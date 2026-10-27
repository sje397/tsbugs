/**
 * The machine panel's arithmetic: what one bug is, right now.
 *
 * Everything here reads a live `Processor` or `Bug` and returns plain data. No
 * DOM, nothing executed, nothing written — a panel that could nudge the machine
 * it is describing would be a second driver of the simulation.
 *
 * THE SENSE WINDOW'S INDEX ORDER (verified, not assumed)
 *
 * `sensesOf` reads the input pool, so the order of the nine cells is whatever
 * filled it. That is `getVisionAt`/`getEnergyAt` (dish.ts:560-574), which for
 * d = 0..8 ask `wrapX(d, x, width)` and `wrapY(d, y, height)`. Those two
 * (dish.ts:1040-1052) decompose d the same way:
 *
 *     wrapX: d % 3 === 0 -> x - 1   (west)
 *            d % 3 === 1 -> x       (same column)
 *            d % 3 === 2 -> x + 1   (east)
 *     wrapY: trunc(d / 3) === 0 -> y - 1   (north)
 *            trunc(d / 3) === 1 -> y       (same row)
 *            trunc(d / 3) === 2 -> y + 1   (south)
 *
 * So slot = row * 3 + col, with row 0 at the NORTH edge and col 0 at the WEST
 * edge: grid[r][c] is slot 3r + c, d = 0 is north-west, d = 4 is the bug's own
 * cell, d = 7 is south. Three independent checks agree, and any one of them alone
 * would have permitted a wrong answer:
 *   - `wrapY` treats trunc(d/3) = 0 as y - 1, so the first three slots are the
 *     row above — image order top-to-bottom, not a mathematical y-up axis;
 *   - the move phase (dish.ts:390-410) passes the direction output through the
 *     same `wrapX`/`wrapY` pair, so a direction and a sense slot with the same
 *     number mean the same offset (see `directionName` below — which is why
 *     direction 0 is north-west and not north);
 *   - bug.ts's comment on `dir` states the same crossing in the other notation:
 *     "0-2 left, 3-5 stay, 6-8 right, crossed with up/stay/down".
 * The trap this guards against is column-major: reading slot = col * 3 + row
 * transposes the window and swaps slot 1 (north) with slot 3 (west), which
 * nothing on screen would reveal. `test/machine.test.ts` asserts the placement
 * against `wrapX`/`wrapY` themselves rather than against a transcribed table.
 *
 * A SECOND TRAP, for anyone rebuilding this window from the grid instead: the
 * dish stores cells x-major — `bugCol[nx * height + ny]` (dish.ts:564, 572) — so
 * the obvious `y * width + x` indexes a different cell. `sensesOf` reads the
 * input pool and never touches the cell array.
 *
 * The vision channel is the cell's colour byte as the renderer left it, not an
 * identity: 0 empty, 1..252 a bug (`(color % 252) + 1`), 254 poison, 255 energy
 * (dish.ts `findBugColorAt`). It carries no scaling, unlike the energy channel,
 * which is `senseByte`'s 0..255 rescaling of the cell's energy.
 *
 * THE SPLIT THRESHOLD
 *
 * `split < 128` — see `SPLIT_THRESHOLD`. It is a literal in `replicate`
 * (dish.ts:598): upstream's `qrand() % 255 + 1` is commented out, so no draw is
 * made and the value is exactly 128. 128 itself does NOT split, and 127 does, and
 * that boundary is one byte wide and invisible on screen. The output is also only
 * a statement of willingness: the cell must hold at least two bugs, BOTH of the
 * chosen pair must be below the threshold, the mother must hold
 * `childEnergy + minEnergy`, and she pays `childEnergy` for the child.
 *
 * THE FOURTH OUTPUT
 *
 * `OUTPUTS = 4` — direction, colour, split, action. Nothing reads output 3 in
 * this port: `Bug.update` reads 0, 1 and 2, and the dish reads only the fields
 * those produced. A program writing it changes nothing, so a panel must not show
 * it as a decision.
 */

import { DIR_STAY, SENSE_SLOTS, type Bug } from '../sim/bug.js';
import type { Processor } from '../sim/processor.js';

/** The sense window is square; `SENSE_SLOTS` is its area, not its side. */
export const SENSE_SIDE = 3;

/** The compass, indexed by direction. Non-obvious: index 4 is "stay". */
export const DIRECTION_NAMES: readonly string[] = [
  'north-west', 'north', 'north-east',
  'west', 'stay', 'east',
  'south-west', 'south', 'south-east',
];

/**
 * The split output must be strictly below this to count as a request to split.
 *
 * Named rather than inlined at the comparison because `<` and `<=` differ only at
 * 128 and nothing downstream reports which one a bug took.
 */
export const SPLIT_THRESHOLD = 128;

/** The four registers, plus the stack's capacity — the size `sp` is counting up to. */
export interface Registers {
  ip: number;
  sp: number;
  bp: number;
  acc: number;
  /** Bytes the stack can hold. `sp` is how many it holds now. */
  stackSize: number;
}

export function registersOf(processor: Processor): Registers {
  const state = processor.state;
  return {
    ip: state.ip,
    sp: state.sp,
    bp: state.bp,
    acc: state.accumulator,
    stackSize: processor.stackSize,
  };
}

/** What the bug can see: the 3x3 window it was given this tick, as a grid. */
export interface Senses {
  /** Rows top to bottom, each left to right, of the colour channel (0-252). */
  vision: number[][];
  /** Same shape, the energy channel, as the 0-255 byte the VM actually reads. */
  energy: number[][];
  /** The bug's own energy as the VM sees it: in18*256 + in19, and the two raw bytes. */
  ownEnergy: number;
  ownEnergyBytes: [number, number];
}

/**
 * The senses as a grid, in the row/column order derived in the header.
 *
 * The grids are fresh arrays on every call: a panel that held one and mutated it
 * would be describing a tick that has since been overwritten.
 */
export function sensesOf(processor: Processor): Senses {
  const vision: number[][] = [];
  const energy: number[][] = [];

  for (let row = 0; row < SENSE_SIDE; row++) {
    const visionRow: number[] = [];
    const energyRow: number[] = [];
    for (let col = 0; col < SENSE_SIDE; col++) {
      const slot = row * SENSE_SIDE + col;
      visionRow.push(processor.readIn(slot));
      energyRow.push(processor.readIn(SENSE_SLOTS + slot));
    }
    vision.push(visionRow);
    energy.push(energyRow);
  }

  // bug.ts `update()` writes trunc(energy / 256) & 0xff then energy % 256, which
  // is a 16-bit quantity split high byte first — not the low-first operand order
  // the VM uses for addresses, so the two must not be assumed alike.
  const high = processor.readIn(2 * SENSE_SLOTS);
  const low = processor.readIn(2 * SENSE_SLOTS + 1);

  return { vision, energy, ownEnergy: high * 256 + low, ownEnergyBytes: [high, low] };
}

/**
 * Direction as an index into the compass. Defined for any integer, including the
 * ones a modulo has already been through; nothing else can reach it, since every
 * direction here comes out of `(out + DIR_STAY) % 9`.
 */
function normaliseDirection(dir: number): number {
  const d = Math.trunc(dir);
  return ((d % DIRECTION_NAMES.length) + DIRECTION_NAMES.length) % DIRECTION_NAMES.length;
}

/** Compass name for a direction 0-8, e.g. 0 -> 'north-west', 4 -> 'stay'. */
export function directionName(dir: number): string {
  return DIRECTION_NAMES[normaliseDirection(dir)];
}

/** The index a name stands for, or -1 — the inverse of `directionName`. */
export function directionOffset(name: string): number {
  return DIRECTION_NAMES.indexOf(name);
}

/**
 * bug.ts `update()`: `dir = (readOut(0) + DIR_STAY) % 9`.
 *
 * Duplicated from there rather than derived, because it is the one place the
 * offset lives and a second derivation is a second thing to get wrong. The offset
 * exists so that a program which writes nothing moves nowhere: an all-zero output
 * means "stay", not "north-west".
 */
export function dirFromOutput(output: number): number {
  return (output + DIR_STAY) % DIRECTION_NAMES.length;
}

/** "moved south-west" / "stayed put" — the action the dir output encodes. */
export function describeMove(dir: number): string {
  const d = normaliseDirection(dir);
  return d === DIR_STAY ? 'stayed put' : `moved ${DIRECTION_NAMES[d]}`;
}

/** What the bug decided, as words. */
export interface Decision {
  dir: number;
  move: string;
  colour: number;
  split: number;
  splits: boolean;
  explain: string;
}

/**
 * The bug's decision, read from its outputs after a tick.
 *
 * `colour` is `readOut(1)` raw. `Bug.update` writes it unclamped while the
 * constructor clamps to 1..252, so the two disagree for the same outputs and the
 * snapshot — not the constructor — is authoritative. The renderer applies
 * `% 252 + 1` at draw time, so the number here is what the program decided, not
 * what the cell looks like.
 */
export function decisionOf(processor: Processor): Decision {
  const out0 = processor.readOut(0);
  const colour = processor.readOut(1);
  const split = processor.readOut(2);

  const dir = dirFromOutput(out0);
  const move = describeMove(dir);
  const splits = split < SPLIT_THRESHOLD;

  const explain = [
    `out0 = ${out0} -> direction ${dir} (${directionName(dir)}), so it ${move}`,
    `out1 = ${colour} -> its colour becomes ${colour}`,
    splits
      ? `out2 = ${split} is below ${SPLIT_THRESHOLD}, so it asks to split — which needs a partner in its cell and the energy for the child`
      : `out2 = ${split} is not below ${SPLIT_THRESHOLD}, so it will not split, partner or not`,
  ].join('; ');

  return { dir, move, colour, split, splits, explain };
}

/** One reading of a bug, cheap enough to keep two of. */
export interface Snapshot {
  registers: Registers;
  energy: number;
  age: number;
  children: number;
  /**
   * Genome length, without which `tickDelta` cannot read ip's movement: the
   * machine wraps at the end of the program, so 5 -> 3 in a 6-byte genome is
   * four bytes forward, not two back. A processor would answer this, but holding
   * one in a snapshot would hold the bug alive.
   */
  programLength: number;
}

export function snapshotOf(bug: Bug, hash: number): Snapshot & { hash: number } {
  return {
    hash,
    registers: registersOf(bug.processor),
    energy: bug.energy,
    age: bug.age,
    children: bug.children,
    programLength: bug.processor.programLength,
  };
}

/** The difference between two reads of one bug, for "what did the last tick do". */
export interface TickDelta {
  /** `moved` is modulo the program length; `wrapped` is the raw difference going negative. */
  ip: { from: number; to: number; moved: number; wrapped: boolean };
  acc: { from: number; to: number; delta: number };
  energy: { from: number; to: number; delta: number };
  ageFrom: number;
  ageTo: number;
  childrenFrom: number;
  childrenTo: number;
  /** Human sentences for what the numbers cannot say themselves; empty on a quiet tick. */
  note: string[];
}

/**
 * What changed between two snapshots of one bug.
 *
 * ip's `moved` is the forward distance modulo the program length, which is the
 * only reading of it that is a distance at all: the machine wraps. `wrapped` is
 * therefore a statement about the raw difference going negative, and the note
 * says what the registers cannot: a backward jump (JMP to a lower address) and a
 * wrap produce the same pair of values, so the panel reports the wrap and admits
 * the other reading rather than choosing one.
 *
 * `acc`'s delta is a plain difference, not a modulo-correct one. The accumulator
 * is a data value, not a position, so a machine that added 200 to 100 shows +200
 * with both ends printed; there is no "forward" through it to normalise by.
 */
export function tickDelta(before: Snapshot, after: Snapshot): TickDelta {
  const length = after.programLength;
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`program length is ${length}, so ip cannot be read as a distance`);
  }

  const from = before.registers.ip;
  const to = after.registers.ip;
  const raw = to - from;
  const moved = ((raw % length) + length) % length;
  const wrapped = raw < 0;

  const note: string[] = [];
  const ticks = after.age - before.age;

  if (ticks > 1) {
    note.push(
      `${ticks} ticks separate these two reads, not one — age counts VM runs, so every number here is for that whole span`,
    );
  }
  if (wrapped) {
    note.push(
      `ip went from ${from} to ${to} on a ${length}-byte program: ${moved} bytes forward through the wrap at the end, or a jump backwards — one pair of register reads cannot tell those apart`,
    );
  }
  if (ticks !== 0 && moved === 0) {
    note.push(
      'a tick ran but ip is where it was: either the world runs no instructions per update, or the program jumped back to the address it started from',
    );
  }

  return {
    ip: { from, to, moved, wrapped },
    acc: {
      from: before.registers.acc,
      to: after.registers.acc,
      delta: after.registers.acc - before.registers.acc,
    },
    energy: {
      from: before.energy,
      to: after.energy,
      delta: after.energy - before.energy,
    },
    ageFrom: before.age,
    ageTo: after.age,
    childrenFrom: before.children,
    childrenTo: after.children,
    note,
  };
}
