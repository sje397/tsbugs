/**
 * The machine panel's arithmetic.
 *
 * The assertions that matter here are the ones whose failure is silent on
 * screen. A transposed sense window still looks like a window; a split threshold
 * that is `<=` instead of `<` still splits half of all bugs; an ip move read as
 * `to - from` still produces a number. So each of those is pinned to the source
 * it came from rather than to a table transcribed from it:
 *
 *   - the window's cell order is checked against `wrapX`/`wrapY` themselves, with
 *     all eighteen input slots holding distinct values, so any permutation of the
 *     grid shows up;
 *   - the split boundary is checked at 127 and 128, the only two values where the
 *     two readings of the comparison differ;
 *   - ip's displacement is checked in both directions on a 6-byte program, where
 *     wrapping and not wrapping give 4 and 2 rather than -2 and 2.
 *
 * Fixtures are real machines: bugs built through `Bug.restore` (the path a saved
 * world takes) and processors through `new Processor` / `Processor.restore`, so a
 * fixture cannot agree with the module about a layout the simulation does not
 * have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Bug, DIR_STAY, SENSE_SLOTS, type BugState } from '../src/sim/bug.js';
// The window's own coordinate functions, so the grid is asserted against the
// source rather than against a table copied out of it.
import { wrapX, wrapY } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, type WorldParams } from '../src/sim/params.js';
import { INPUTS, Instruction, OUTPUTS, Processor } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';
import {
  DIRECTION_NAMES, SPLIT_THRESHOLD,
  decisionOf, describeMove, dirFromOutput, directionName, directionOffset,
  registersOf, senseFrame, sensesOf, snapshotOf, tickDelta,
} from '../src/ui/machine.js';

const STACK_SIZE = 32;

/** No instructions run unless a test asks for them: a still machine is a known one. */
const PARAMS: WorldParams = { ...DEFAULT_PARAMS, stepsPerUpdate: 0, stackSize: STACK_SIZE, mutation: 0 };

interface BugOptions {
  ip?: number;
  steps?: number;
  energy?: number;
  age?: number;
  children?: number;
}

/** A real bug running exactly this genome, at the address given. */
function bugWith(genome: number[], options: BugOptions = {}): Bug {
  const ram = Uint8Array.from(genome);
  const state: BugState = {
    genome: ram.slice(),
    mutationRate: 0,
    processor: {
      ram,
      stack: new Uint8Array(STACK_SIZE),
      inp: new Uint8Array(INPUTS),
      out: new Uint8Array(OUTPUTS),
      ip: options.ip ?? 0,
      sp: 0,
      bp: 0,
      accumulator: 0,
    },
    dir: DIR_STAY,
    color: 1,
    split: 0,
    age: options.age ?? 0,
    children: options.children ?? 0,
    generation: 0,
    energy: options.energy ?? 100,
    marked: false,
  };
  const params: WorldParams = { ...PARAMS, stepsPerUpdate: options.steps ?? 0 };
  return Bug.restore(state, params, new Rng(1));
}

/** A machine with the given outputs already written, as a restore would leave it. */
function processorWithOut(out: number[]): Processor {
  return Processor.restore(
    {
      ram: Uint8Array.from([Instruction.NOOP]),
      stack: new Uint8Array(STACK_SIZE),
      inp: new Uint8Array(INPUTS),
      out: Uint8Array.from(out),
      ip: 0,
      sp: 0,
      bp: 0,
      accumulator: 0,
    },
    0,
    STACK_SIZE,
    new Rng(3),
  );
}

test('the registers are the machine\'s own, including the stack it is filling', () => {
  // INC leaves an accumulator to see, and SUBROUTINE is the only opcode that moves
  // bp — it pushes four bytes (ip then bp) and jumps. Operands are low byte first,
  // so `1, 0` is address 1.
  const genome = [Instruction.INC, Instruction.SUBROUTINE, 1, 0];
  const bug = bugWith(genome, { steps: 2 });
  bug.update();

  const registers = registersOf(bug.processor);
  assert.deepEqual(registers, { ip: 1, sp: 4, bp: 4, acc: 1, stackSize: STACK_SIZE });
  assert.equal(bug.processor.stackBytes().length, registers.sp, 'sp is the bytes in use, not the capacity');
});

test('the sense window is placed by wrapX/wrapY order, not by an assumed grid', () => {
  // All eighteen slots distinct, so any permutation of the grid — a transpose, a
  // flip, rows read bottom-up — produces a grid the expectations below reject.
  const processor = new Processor(Uint8Array.from([Instruction.NOOP]), 0, STACK_SIZE, new Rng(9));
  for (let slot = 0; slot < SENSE_SLOTS; slot++) {
    processor.setIn(slot, slot + 1);                    // colour channel: 1..9
    processor.setIn(SENSE_SLOTS + slot, 100 + slot);    // energy channel: 100..108
  }

  const senses = sensesOf(processor);

  // THE DERIVATION, from dish.ts:560-574 and 1040-1052:
  //   wrapX: d % 3 === 0 -> x-1 (west), 1 -> x, 2 -> x+1 (east)
  //   wrapY: trunc(d/3) === 0 -> y-1 (north), 1 -> y, 2 -> y+1 (south)
  // so slot = row*3 + col with row counted from the NORTH edge, and the nine
  // slots are 0 north-west, 1 north, 2 north-east, 3 west, 4 here, 5 east,
  // 6 south-west, 7 south, 8 south-east.
  for (let slot = 0; slot < SENSE_SLOTS; slot++) {
    const row = Math.trunc(slot / 3);
    const col = slot % 3;

    // The claim "row 0 is north and col 0 is west" against the source functions
    // themselves: each slot's offset must be one step west/north/… from the centre.
    assert.equal(wrapX(slot, 5, 11), 5 + (col - 1), `slot ${slot}'s column is not its d % 3`);
    assert.equal(wrapY(slot, 5, 11), 5 + (row - 1), `slot ${slot}'s row is not its trunc(d / 3)`);

    assert.equal(senses.vision[row][col], slot + 1, `slot ${slot} is not at row ${row}, column ${col}`);
    assert.equal(senses.energy[row][col], 100 + slot, `energy slot ${slot} is not where its colour twin is`);
  }

  // Written out, so a reader can check the claim without running the loop: rows
  // top to bottom are the row above the bug, its own row, and the row below.
  assert.deepEqual(senses.vision, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.deepEqual(senses.energy, [[100, 101, 102], [103, 104, 105], [106, 107, 108]]);

  // The centre of the window is the bug's own cell, not a hole.
  assert.equal(senses.vision[1][1], 5);
});

// --------------------------------------------------- where the window was taken

/**
 * The window is a tick behind the dish, and the panel has to say so.
 *
 * These are the assertions for the direction of that offset. A bug that has moved
 * senses from the cell it left, so the panel's centre is one step back — and a
 * one-cell offset in a 3x3 grid reads as a directional error rather than as lag:
 * the reader sees food one row away from where it is drawn and concludes the
 * compass is wrong, which is what happened (a bug beside a food cell, the panel
 * calling it north).
 */

test('the sample cell is the inverse of the move the dish applies', () => {
  // Round-trip against wrapX/wrapY — the functions the move phase itself uses —
  // so this cannot agree with a wrong table. The edges are included because that
  // is where a wrap makes the inverse non-obvious: a bug standing at x = 0 did
  // not come from x = -1, it came from the far side.
  const cases: Array<{ x: number; y: number; width: number; height: number }> = [
    { x: 5, y: 7, width: 11, height: 13 },
    { x: 0, y: 0, width: 11, height: 13 },
    { x: 10, y: 12, width: 11, height: 13 },
    { x: 0, y: 12, width: 11, height: 13 },
  ];

  for (const { x, y, width, height } of cases) {
    for (let dir = 0; dir < DIRECTION_NAMES.length; dir++) {
      // Where the bug ends up having moved `dir` from (x, y) ...
      const nowX = wrapX(dir, x, width);
      const nowY = wrapY(dir, y, height);
      const frame = senseFrame({ x: nowX, y: nowY }, dir, width, height);

      assert.deepEqual(
        frame.at, { x, y },
        `a bug that moved ${directionName(dir)} to ${nowX},${nowY} (from ${x},${y} on ${width}x${height}) ` +
        `was sampled at ${frame.at.x},${frame.at.y}`,
      );
      assert.equal(frame.movedDir, dir === DIR_STAY ? DIR_STAY : dir);
    }
  }
});

test('a bug that moved south was sampled from the cell north of it', () => {
  // The reported symptom, spelled out in coordinates. South is dir 7 and y grows
  // southward (see the header), so a bug at 10,20 that moved south came from
  // 10,19 — and the cell it now occupies is therefore the SOUTH slot of the window
  // it is looking at, not the centre.
  const frame = senseFrame({ x: 10, y: 20 }, 7, 64, 64);
  assert.deepEqual(frame.at, { x: 10, y: 19 });
  assert.equal(frame.moved, true);
  assert.equal(directionName(frame.movedDir), 'south');

  // The consequence that made the panel look mirrored: the bug's own current cell
  // sits in slot 7 of the sampled window, one row below the centre the panel used
  // to label "its own cell".
  assert.equal(wrapX(7, frame.at.x, 64), 10);
  assert.equal(wrapY(7, frame.at.y, 64), 20);

  // And the mirror image, because a sign error in one direction only is exactly
  // the bug this is guarding: a bug that moved north was sampled from the south.
  const north = senseFrame({ x: 10, y: 20 }, 1, 64, 64);
  assert.deepEqual(north.at, { x: 10, y: 21 });
  assert.equal(wrapY(1, north.at.y, 64), 20, "the bug's own cell is the north slot");
});

test('a bug that stayed is sampled where it stands', () => {
  const frame = senseFrame({ x: 3, y: 4 }, DIR_STAY, 8, 8);
  assert.deepEqual(frame.at, { x: 3, y: 4 });
  assert.deepEqual(frame.current, { x: 3, y: 4 });
  assert.equal(frame.moved, false);
  assert.equal(frame.movedDir, DIR_STAY);
});

test('eight directions give eight different sample cells', () => {
  // A transposed inverse, or one that reused the direction instead of mirroring
  // it, would send two directions to the same cell — which a per-direction
  // assertion against the same source function could still miss.
  const from = { x: 6, y: 6 };
  const seen = new Map<string, number>();
  for (let dir = 0; dir < DIRECTION_NAMES.length; dir++) {
    if (dir === DIR_STAY) continue;
    const at = senseFrame(from, dir, 13, 13).at;
    const key = `${at.x},${at.y}`;
    assert.equal(seen.has(key), false, `directions ${seen.get(key)} and ${dir} both sampled ${key}`);
    seen.set(key, dir);
  }
  // ... and all eight are inside the world, which is what makes the round trip
  // above meaningful at an edge rather than a coincidence of arithmetic.
  for (const key of seen.keys()) {
    const [x, y] = key.split(',').map(Number);
    assert.ok(x >= 0 && x < 13 && y >= 0 && y < 13, `${key} is outside a 13x13 world`);
  }
});

// --------------------------------------------------------------- own energy

test('own energy is the 16-bit pair the bug writes, and round-trips whole', () => {
  const values = [0, 1, 255, 256, 1000, 65535];

  // Through the pool directly, at the two slots bug.ts writes.
  const processor = new Processor(Uint8Array.from([Instruction.NOOP]), 0, STACK_SIZE, new Rng(4));
  for (const energy of values) {
    processor.setIn(18, Math.trunc(energy / 256) & 0xff);
    processor.setIn(19, energy & 0xff);

    const senses = sensesOf(processor);
    assert.equal(senses.ownEnergy, energy, `own energy ${energy} did not survive the pair`);
    assert.deepEqual(senses.ownEnergyBytes, [Math.trunc(energy / 256) & 0xff, energy & 0xff]);
  }

  // And through a real bug's update, which is where the encoding is chosen: a
  // test of the slots alone would pass on a machine that never sets them.
  for (const energy of values) {
    const bug = bugWith([Instruction.NOOP]);
    bug.energy = energy;
    bug.update(); // stepsPerUpdate is 0: writes the inputs, runs nothing
    assert.equal(sensesOf(bug.processor).ownEnergy, energy, `a bug holding ${energy} reported something else`);
  }
});

// --------------------------------------------------------------- directions

test('the compass has nine names, each mapping back to its own index', () => {
  const seen = new Set<string>();
  for (let index = 0; index < 9; index++) {
    const name = directionName(index);
    assert.equal(typeof name, 'string');
    assert.notEqual(name, '', `direction ${index} has no name`);
    seen.add(name);
    assert.equal(directionOffset(name), index, `${name} does not point back at ${index}`);
  }
  assert.equal(seen.size, 9, 'two directions share a name');

  assert.equal(directionName(0), 'north-west');
  assert.equal(directionName(4), 'stay');
  assert.equal(directionName(7), 'south');

  // Total for 0..8 and beyond it: an index that has been through the machine's
  // own modulo arithmetic is still a direction rather than undefined.
  for (const d of [-1, 9, 13, 900]) {
    assert.equal(directionName(d), directionName(((d % 9) + 9) % 9), `direction ${d} is not total`);
  }
});

test('the direction output round-trips through the name table', () => {
  // All 256 bytes a program can write: (out + DIR_STAY) % 9 is the reduction in
  // bug.ts, and the offset must survive the trip back out for every one of them.
  assert.equal(dirFromOutput(0), DIR_STAY, 'an all-zero machine must stay put');
  for (let out = 0; out < 256; out++) {
    const dir = dirFromOutput(out);
    assert.ok(dir >= 0 && dir < 9, `output ${out} produced direction ${dir}`);
    assert.equal(
      (directionOffset(directionName(dir)) - DIR_STAY + 9) % 9,
      out % 9,
      `output ${out} did not come back as itself`,
    );
  }
  assert.equal(DIRECTION_NAMES[DIR_STAY], 'stay');
});

test('exactly one direction says it stayed', () => {
  assert.equal(describeMove(DIR_STAY), 'stayed put');
  for (const dir of [0, 1, 2, 3, 5, 6, 7, 8]) {
    assert.equal(describeMove(dir), `moved ${directionName(dir)}`, `direction ${dir}`);
    assert.notEqual(describeMove(dir), 'stayed put', `direction ${dir} claimed to have stayed`);
  }
});

// ---------------------------------------------------------------- decisions

test('the split boundary is 127 in and 128 out', () => {
  // dish.ts:598 compares `mum.split < 128`. 128 is the only value where `<` and
  // `<=` disagree, so it is the only value that can catch the mistake.
  assert.equal(SPLIT_THRESHOLD, 128);
  const cases: Array<[number, boolean]> = [[0, true], [1, true], [126, true], [127, true], [128, false], [129, false], [255, false]];
  for (const [split, splits] of cases) {
    const decision = decisionOf(processorWithOut([0, 1, split, 0]));
    assert.equal(decision.split, split);
    assert.equal(decision.splits, splits, `split output ${split}`);
  }
});

test('a decision names the direction, the colour and the split it read', () => {
  const decision = decisionOf(processorWithOut([0, 17, 127, 0]));
  assert.equal(decision.dir, DIR_STAY);
  assert.equal(decision.move, 'stayed put');
  assert.equal(decision.colour, 17);
  assert.equal(decision.split, 127);
  assert.equal(decision.splits, true);
  assert.ok(decision.explain.includes('stay'), decision.explain);
  assert.ok(decision.explain.includes('17'), decision.explain);
  assert.ok(decision.explain.includes('127'), decision.explain);

  // A split request is willingness, not a birth: the explanation has to say so,
  // or the panel tells a reader that a lone bug is about to reproduce.
  assert.ok(decision.explain.includes('partner'), decision.explain);

  const west = decisionOf(processorWithOut([5, 0, 200, 0]));
  assert.equal(west.dir, 0, '(5 + 4) % 9 should be north-west');
  assert.equal(west.move, 'moved north-west');
  assert.equal(west.splits, false);
});

test('the decision is read from what a running machine wrote', () => {
  // IN 0 / OUT 2: the accumulator takes input slot 0 and stores it as the split
  // output. Two steps, so the machine's own arithmetic decides the answer rather
  // than a fixture's assumption about where OUT writes.
  const genome = Uint8Array.from([Instruction.IN, 0, Instruction.OUT, 2]);
  for (const [written, splits] of [[127, true], [128, false]] as const) {
    const processor = new Processor(genome, 2, STACK_SIZE, new Rng(5));
    processor.setIn(0, written);
    processor.run();
    assert.equal(processor.readOut(2), written, 'the fixture did not reach the split output');
    assert.equal(decisionOf(processor).splits, splits, `split output ${written}`);
  }
});

// ------------------------------------------------------------------ deltas

test('a wrapped ip is read forward through the program, not backwards', () => {
  const genome = new Array<number>(6).fill(Instruction.NOOP);
  const atFive = snapshotOf(bugWith(genome, { ip: 5 }), 1);
  const atThree = snapshotOf(bugWith(genome, { ip: 3 }), 1);
  assert.equal(atFive.programLength, 6, 'the snapshot must carry the length the wrap happens at');

  // 5 -> 3 in a 6-byte program is four bytes forward through the end.
  const wrapped = tickDelta(atFive, atThree);
  assert.deepEqual(wrapped.ip, { from: 5, to: 3, moved: 4, wrapped: true });
  assert.notEqual(wrapped.ip.moved, -2, 'the raw difference is not a distance');
  assert.equal(wrapped.note.length, 1, 'a wrap with nothing else said should be one note');

  // ...and the other way is not a wrap: 3 -> 5 is two bytes forward.
  const forward = tickDelta(atThree, atFive);
  assert.deepEqual(forward.ip, { from: 3, to: 5, moved: 2, wrapped: false });
  assert.deepEqual(forward.note, [], 'a plain forward step is not worth a note');

  const still = tickDelta(atThree, atThree);
  assert.deepEqual(still.ip, { from: 3, to: 3, moved: 0, wrapped: false });
});

test('two reads of the same bug give zeros and nothing to say', () => {
  const bug = bugWith([Instruction.INC, Instruction.INC], { ip: 1, energy: 250, age: 3, children: 2 });
  const before = snapshotOf(bug, 42);
  const after = snapshotOf(bug, 42);

  const delta = tickDelta(before, after);
  assert.equal(after.hash, 42);
  assert.deepEqual(delta.ip, { from: 1, to: 1, moved: 0, wrapped: false });
  assert.deepEqual(delta.acc, { from: 0, to: 0, delta: 0 });
  assert.deepEqual(delta.energy, { from: 250, to: 250, delta: 0 });
  assert.equal(delta.ageFrom, 3);
  assert.equal(delta.ageTo, 3);
  assert.equal(delta.childrenFrom, 2);
  assert.equal(delta.childrenTo, 2);
  assert.deepEqual(delta.note, []);
});

test('a tick that moved one byte and lost one energy is not worth a note', () => {
  const genome = new Array<number>(8).fill(Instruction.NOOP);
  const before = snapshotOf(bugWith(genome, { ip: 2, energy: 100, age: 5, children: 0 }), 1);
  const after = snapshotOf(bugWith(genome, { ip: 3, energy: 99, age: 6, children: 0 }), 1);

  const delta = tickDelta(before, after);
  assert.equal(delta.ip.moved, 1);
  assert.equal(delta.energy.delta, -1);
  assert.equal(delta.ageTo - delta.ageFrom, 1);
  assert.deepEqual(delta.note, [], 'ordinary numbers were reported as anomalies');
});

test('a gap of several ticks says so', () => {
  const genome = new Array<number>(8).fill(Instruction.NOOP);
  const before = snapshotOf(bugWith(genome, { ip: 0, age: 0 }), 1);
  const after = snapshotOf(bugWith(genome, { ip: 3, age: 3 }), 1);

  const delta = tickDelta(before, after);
  assert.equal(delta.note.length, 1, delta.note.join(' / '));
  assert.ok(delta.note[0].includes('3'), delta.note[0]);
});

test('a delta cannot be computed without the length the wrap happens at', () => {
  // A snapshot with no program is not one this simulation can produce — restore
  // refuses an empty genome — but the arithmetic must not answer with a NaN.
  const genome = new Array<number>(6).fill(Instruction.NOOP);
  const snapshot = snapshotOf(bugWith(genome, { ip: 1 }), 1);
  assert.throws(() => tickDelta(snapshot, { ...snapshot, programLength: 0 }), RangeError);
  assert.throws(() => tickDelta(snapshot, { ...snapshot, programLength: 2.5 }), RangeError);
});
