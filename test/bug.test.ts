/**
 * Writing to a creature's code.
 *
 * A genome byte lives in two arrays on a live bug — the machine's `ram`, which is
 * what executes, and the Dna's buffer, which is what children are built from —
 * and they are separate on purpose (processor.ts note 3). An editor that writes
 * one has a signature failure mode: write only `ram` and the edit runs until the
 * bug is saved, at which point the snapshot carries the untouched genome and the
 * edit is gone; write only the Dna and nothing appears to happen at all, because
 * this bug does not execute its Dna.
 *
 * So the assertions here are the two directions plus the persistence, and the
 * instruction word is built rather than random: a genome of INC bytes with one
 * step per update makes "did the patch reach the machine" a single integer,
 * which a random genome cannot answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Bug, type BugState } from '../src/sim/bug.js';
import { Instruction, INPUTS, OUTPUTS } from '../src/sim/processor.js';
import { DEFAULT_PARAMS, type WorldParams } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

/** One step per update, so a single update is one instruction. */
const PARAMS: WorldParams = { ...DEFAULT_PARAMS, stepsPerUpdate: 1, stackSize: 32, mutation: 0 };

/** A bug running exactly the genome given, about to execute it from the start. */
function bugFrom(genome: number[]): Bug {
  const ram = Uint8Array.from(genome);
  const state: BugState = {
    genome: ram.slice(),
    mutationRate: 0,
    processor: {
      ram,
      stack: new Uint8Array(PARAMS.stackSize),
      inp: new Uint8Array(INPUTS),
      out: new Uint8Array(OUTPUTS),
      ip: 0, sp: 0, bp: 0, accumulator: 0,
    },
    dir: 4, color: 1, split: 0, age: 0, children: 0, generation: 0, energy: 100, marked: false,
  };
  return Bug.restore(state, PARAMS, new Rng(1));
}

test('a patched byte is what the machine executes', () => {
  const inc = Instruction.INC;
  const control = bugFrom([inc, inc, inc]);
  control.update();
  assert.equal(control.processor.state.accumulator, 1, 'the fixture is not running the INC it was built from');

  const patched = bugFrom([inc, inc, inc]);
  const previous = patched.patchCode(0, Instruction.NOOP);
  assert.equal(previous, inc, 'the edit did not report the byte it replaced');

  patched.update();
  assert.equal(
    patched.processor.state.accumulator, 0,
    'the patched byte did not reach the machine that executes',
  );
});

test('a patched byte is what a child inherits', () => {
  const inc = Instruction.INC;

  const controlChild = Bug.createChild(bugFrom([inc, inc, inc]), bugFrom([inc, inc, inc]), PARAMS, new Rng(2));
  assert.equal(controlChild.dna.data[1], inc, 'the child of two unpatched parents does not inherit the unpatched byte');

  const mum = bugFrom([inc, inc, inc]);
  const dad = bugFrom([inc, inc, inc]);
  mum.patchCode(1, Instruction.NOOP);
  dad.patchCode(1, Instruction.NOOP);

  const child = Bug.createChild(mum, dad, PARAMS, new Rng(2));
  assert.equal(
    child.dna.data[1], Instruction.NOOP,
    'the child was built from a genome the edit did not reach',
  );
});

test('a patched byte survives the snapshot that a save writes', () => {
  const bug = bugFrom([Instruction.INC, Instruction.INC, Instruction.INC]);
  bug.patchCode(2, Instruction.NOOP);

  const state = bug.snapshotState();
  assert.equal(state.genome[2], Instruction.NOOP, 'the snapshot genome does not carry the edit');
  assert.equal(state.processor.ram[2], Instruction.NOOP, 'the snapshot program does not carry the edit');

  // and a restore keeps both halves agreeing, which is the invariant patchCode leans on
  const back = Bug.restore(state, PARAMS, new Rng(3));
  assert.equal(back.dna.data.length, back.snapshotState().processor.ram.length);
  back.update();
  back.update();
  back.update();
  assert.equal(back.processor.state.accumulator, 2, 'only two of the three INCs should still run');
});

test('an address or byte the program cannot hold is refused, and nothing is written', () => {
  const bug = bugFrom([Instruction.INC, Instruction.INC]);
  const before = bug.snapshotState();

  assert.throws(() => bug.patchCode(2, 0), RangeError, 'an address past the program was accepted');
  assert.throws(() => bug.patchCode(-1, 0), RangeError);
  assert.throws(() => bug.patchCode(0, 256), RangeError);
  assert.throws(() => bug.patchCode(0, 1.5), RangeError);

  // A refusal that half-wrote would leave the machine and the genome disagreeing,
  // which is the one state neither the display nor a save could reconcile.
  const after = bug.snapshotState();
  assert.deepEqual(after.genome, before.genome);
  assert.deepEqual(after.processor.ram, before.processor.ram);
});
