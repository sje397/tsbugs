/**
 * Snapshot and restore: whether a saved world CONTINUES or merely resembles one.
 *
 * The distinction is the whole point, and it is what these tests are shaped
 * around. "The population matches" would pass for a world restored from a seed
 * alone, because a population count is a coarse statistic that a different world
 * reaches all the time. What has to hold is that the restored world makes the same
 * moves at the same ticks — so every test here compares futures, and the
 * falsification moves the stream by one step to show the comparison can see a
 * difference at all.
 *
 * `encodeWorld` doubles as a structural digest: two worlds whose encoded text is
 * equal agree on every field the format carries, byte for byte. That is a stronger
 * statement than a counter comparison and costs nothing to write, so the roundtrip
 * test uses it rather than re-deriving a hash here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PetriDish, ViewMode, WORLD_SNAPSHOT_VERSION, type WorldSnapshot } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng, isResumable, type RandomSource } from '../src/sim/rng.js';
import { Processor } from '../src/sim/processor.js';
import type { Bug } from '../src/sim/bug.js';
import { fingerprint } from '../src/sim/fingerprint.js';
import { decodeWorld, encodeWorld } from '../src/ui/worldStore.js';

function world(seed = 7, ticks = 120): PetriDish {
  const dish = new PetriDish(DEFAULT_PARAMS, new Rng(seed));
  for (let i = 0; i < ticks; i++) dish.step();
  return dish;
}

/** Ticks both worlds and reports the first tick at which they disagree, or -1. */
function firstDivergence(a: PetriDish, b: PetriDish, ticks: number): number {
  for (let i = 1; i <= ticks; i++) {
    a.step();
    b.step();
    if (fingerprint(a) !== fingerprint(b)) return a.time;
  }
  return -1;
}

test('a world survives a round trip through the text format, byte for byte', () => {
  const original = world();
  const text = encodeWorld(original.snapshot());
  const restored = PetriDish.restore(decodeWorld(text));

  assert.equal(encodeWorld(restored.snapshot()), text);
  assert.equal(restored.time, original.time);
  assert.equal(restored.population, original.population);
  assert.equal(fingerprint(restored), fingerprint(original));
});

test('a restored world continues identically, not merely similarly', () => {
  const original = world();
  const restored = PetriDish.restore(decodeWorld(encodeWorld(original.snapshot())));

  assert.equal(firstDivergence(original, restored, 200), -1);
});

test('the falsification: one step of stream offset is visible within twenty ticks', () => {
  // Without this, "they never diverged" is a claim about a comparison that might
  // not be able to see anything. Moving the stream is the smallest change that
  // must alter the future, so it is the control for every test above.
  const original = world();
  const snapshot = decodeWorld(encodeWorld(original.snapshot()));
  const shifted: WorldSnapshot = {
    ...snapshot,
    counters: { ...snapshot.counters, stream: (snapshot.counters.stream + 1) >>> 0 },
  };
  const restored = PetriDish.restore(shifted);

  const at = firstDivergence(original, restored, 20);
  assert.notEqual(at, -1, 'a world restored one step along its stream should not track the original');
});

test('the falsification: a changed genome byte changes the saved state', () => {
  const original = world();
  const snapshot = decodeWorld(encodeWorld(original.snapshot()));
  const cell = snapshot.cells[0];
  const bug = cell.bugs[0];
  bug.genome[bug.processor.ip] ^= 1;
  const restored = PetriDish.restore(snapshot);

  assert.notEqual(encodeWorld(restored.snapshot()), encodeWorld(original.snapshot()));
});

test('a self-modifying bug keeps what it stored over itself', () => {
  // The genome and the running program are separate arrays, and a save that
  // carried only the genome would quietly undo every STORE the bug had done.
  const original = world();
  const snapshot = original.snapshot();

  const bug = snapshot.cells[0].bugs[0];
  const stored = (bug.genome[0] + 1) & 255;
  bug.processor.ram[0] = stored;

  const restored = decodeWorld(encodeWorld(PetriDish.restore(snapshot).snapshot()));
  const after = restored.cells[0].bugs[0];

  assert.equal(after.processor.ram[0], stored, 'the running program should keep the stored byte');
  assert.equal(after.genome[0], bug.genome[0], 'the inherited genome should not be rewritten by it');
});

test('restoring the same snapshot twice gives the same world twice', () => {
  // A snapshot is data, not a handle: nothing in a restore may adopt its arrays.
  const original = world();
  const snapshot = original.snapshot();
  const first = PetriDish.restore(snapshot);
  for (let i = 0; i < 50; i++) first.step();
  const second = PetriDish.restore(snapshot);

  assert.equal(encodeWorld(second.snapshot()), encodeWorld(original.snapshot()));
});

test('a snapshot refuses a source that cannot say where its stream is', () => {
  // A scripted source in a test has no position, and inventing one would let a
  // world be saved with a claim about its future that is not true.
  // Poison zero, not as a convenience: the constructor scatters poison by drawing
  // cells until it finds one that is free, and a constant source would draw the
  // same occupied cell forever. That loop needs a stream that moves.
  const fixed: RandomSource = { next: () => 1, int: () => 0, float: () => 0 };
  const dish = new PetriDish({ ...DEFAULT_PARAMS, poison: 0 }, fixed);

  assert.equal(isResumable(fixed), false);
  assert.throws(() => dish.snapshot(), /cannot report its stream position/);
});

test('restore refuses a format version it does not know', () => {
  const snapshot = world().snapshot();
  const future: WorldSnapshot = { ...snapshot, version: WORLD_SNAPSHOT_VERSION + 1 };
  assert.throws(() => PetriDish.restore(future), /format version/);
});

test('restore refuses a snapshot that disagrees with itself', () => {
  const snapshot = world().snapshot();

  const wrongPopulation: WorldSnapshot = {
    ...snapshot,
    counters: { ...snapshot.counters, population: snapshot.counters.population + 1 },
  };
  assert.throws(() => PetriDish.restore(wrongPopulation), /disagrees with itself/);

  const shortGrid: WorldSnapshot = { ...snapshot, energy: snapshot.energy.slice(1) };
  assert.throws(() => PetriDish.restore(shortGrid), /cells but the world is/);

  const duplicate: WorldSnapshot = {
    ...snapshot,
    cells: [...snapshot.cells, snapshot.cells[0]],
  };
  assert.throws(() => PetriDish.restore(duplicate), /listed twice|disagrees with itself/);

  const outOfRange: WorldSnapshot = {
    ...snapshot,
    cells: [{ hash: snapshot.params.width * snapshot.params.height + 5, bugs: snapshot.cells[0].bugs }],
  };
  assert.throws(() => PetriDish.restore(outOfRange), /outside the world/);

  const unknownView: WorldSnapshot = { ...snapshot, view: { mode: 9 as ViewMode, showByte: 0 } };
  assert.throws(() => PetriDish.restore(unknownView), /view mode 9/);
});

test('restore rebuilds the pixel cache rather than loading it', () => {
  // viewCol is derived, so a restore that trusted a saved copy would carry a
  // rendering rule into the file. It recomputes from the cells and the ground.
  const original = world();
  const restored = PetriDish.restore(original.snapshot());

  assert.deepEqual(Array.from(restored.viewCol), Array.from(original.viewCol));
});

// ------------------------------------------------------------------ processor

test('a processor refuses a state that could not have come from one', () => {
  const dish = world(1, 20);
  let state = dish.snapshot().cells[0].bugs[0].processor;
  const rng = new Rng(2);

  assert.throws(() => Processor.restore({ ...state, ip: state.ram.length }, 10, 64, rng), /past the end/);
  assert.throws(() => Processor.restore({ ...state, sp: 65 }, 10, 64, rng), /past the end of the stack/);
  assert.throws(() => Processor.restore({ ...state, bp: state.sp + 1 }, 10, 64, rng), /above sp/);
  assert.throws(() => Processor.restore({ ...state, stack: state.stack.slice(1) }, 10, 64, rng), /but the world builds/);

  state = { ...state, ram: new Uint8Array(0) };
  assert.throws(() => Processor.restore(state, 10, 64, rng), /empty program/);
});

test('writeRam refuses an address outside the program rather than wrapping it', () => {
  const dish = world(1, 20);
  let first: Bug | undefined;
  dish.forEachBug((bug) => {
    first ??= bug;
  });
  assert.ok(first !== undefined, 'a populated world holds bugs');
  const processor: Processor = first.processor;
  const length = processor.programLength;

  const before = processor.readRam(0);
  assert.equal(processor.writeRam(0, 200), before, 'writeRam reports the byte it replaced');
  assert.equal(processor.readRam(0), 200);

  assert.throws(() => processor.writeRam(length, 0), /outside the program/);
  assert.throws(() => processor.writeRam(-1, 0), /outside the program/);
  assert.throws(() => processor.writeRam(0, 256), /not in 0..255/);
  assert.throws(() => processor.writeRam(0, 1.5), /not in 0..255/);
});
