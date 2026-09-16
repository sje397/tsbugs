import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PetriDish, ViewMode } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, SenseModel } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import { fingerprint } from '../src/sim/fingerprint.js';

function run(seed = 2024, steps = 200, roughness = 20): PetriDish {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, senseModel: SenseModel.SIGHTED }, new Rng(seed));
  if (roughness > 0) dish.seedTerrain(roughness, new Rng(seed + 1));
  for (let i = 0; i < steps; i++) dish.step();
  return dish;
}

/**
 * A whole simulation has no oracle here: upstream left no golden output, and its
 * own binaries disagree with each other (the uninitialised energy sense reads
 * different bytes at -O0 and -O3). So these tests pin reproducibility and
 * sensitivity -- the two properties that can be checked without an oracle.
 *
 * The browser page imports this same compiled module and calls this same
 * function, so these numbers are also what "the page and Node agree" means;
 * web/README.md records that comparison.
 */

test('a fixed run reproduces exactly', () => {
  // Not a given: the original's per-bug RNG was the global qrand(), so two runs
  // of the same world diverged. Seeded streams bought this property.
  assert.equal(fingerprint(run(2024, 200)), fingerprint(run(2024, 200)));
});

test('the fingerprint of a fixed run is pinned', () => {
  // The port's own output, NOT upstream's. This catches unintended drift; it
  // cannot distinguish a faithful simulation from a consistently wrong one.
  assert.equal(fingerprint(run(2024, 200)), 0xb49ccd2d);
});

test('the fingerprint moves when anything that shapes the run moves', () => {
  // Each case is checked to differ from the base before it is asserted on, so
  // none of these can pass by comparing a value against itself.
  const base = fingerprint(run(2024, 200));
  assert.equal(base, 0xb49ccd2d, 'precondition: the base run is the pinned one');
  assert.notEqual(fingerprint(run(2024, 201)), base, 'one more tick');
  assert.notEqual(fingerprint(run(2025, 200)), base, 'a different seed');
  assert.notEqual(fingerprint(run(2024, 200, 0)), base, 'flat ground');
});

test('the fingerprint depends on the view mode, and so is only comparable within one', () => {
  const dish = run(2024, 50);
  const before = fingerprint(dish);
  dish.setViewMode(ViewMode.TERRAIN);
  assert.notEqual(fingerprint(dish), before);
  dish.setViewMode(ViewMode.DEFAULT);
  assert.equal(fingerprint(dish), before, 'and returns to it');
});
