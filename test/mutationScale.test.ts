/**
 * The mutation slider's scale.
 *
 * The property that matters is not "the numbers look right" but "adjacent
 * positions are different worlds". A linear slider passed every test of the
 * arithmetic it was given and still could not express a rate between 1e-4 and
 * 1e-2 to better than a factor of 50, so the assertions here are about
 * resolution and reversibility rather than about individual values:
 *
 *   - every position round-trips, so dragging and releasing does not drift;
 *   - adjacent positions are always distinct rates, so no pixel is a no-op;
 *   - the geometric section's step is the same ratio at 1e-4 as at 1e-1, which is
 *     the whole reason for the split;
 *   - a rate the scale cannot reach says so instead of being rounded to the floor,
 *     because that rounding is a silent rewrite of the world's rate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_PER_STEP, SLIDER_FLOOR, SLIDER_MAX, SLIDER_TOP,
  describeRate, sliderPosition, sliderToRate, summariseRate,
} from '../src/ui/mutationScale.js';

test('every slider position round-trips through its rate', () => {
  // All of them, not a sample: a position that does not round-trip is one where
  // releasing the slider silently moves it.
  for (let p = 0; p <= SLIDER_MAX; p++) {
    assert.equal(sliderPosition(sliderToRate(p)), p, `position ${p} did not round-trip`);
  }
});

test('every rate the slider produces is already as legible as it is displayed', () => {
  // The panel prints a rate as it stands, so a rate carrying digits the print
  // would drop is the panel disagreeing with the world it is describing.
  for (let p = 1; p <= SLIDER_MAX; p++) {
    const rate = sliderToRate(p);
    assert.equal(rate, Number(rate.toPrecision(4)), `position ${p} produced ${rate}, which is not four figures`);
  }
});

test('no two adjacent positions mean the same rate', () => {
  // The old linear slider failed exactly here: 0, 0.0005 and 0.001 all landed on
  // the first pixel. A step that rounds to a no-op makes the control feel broken.
  for (let p = 0; p < SLIDER_MAX; p++) {
    assert.notEqual(sliderToRate(p), sliderToRate(p + 1), `positions ${p} and ${p + 1} are the same rate`);
  }
});

test('the slider rises without ever going backwards', () => {
  for (let p = 0; p < SLIDER_MAX; p++) {
    assert.ok(sliderToRate(p) < sliderToRate(p + 1), `position ${p} is not below ${p + 1}`);
  }
});

test('off is exactly zero, and only position zero reaches it', () => {
  assert.equal(sliderToRate(0), 0);
  assert.equal(sliderToRate(-5), 0, 'a position left of the track is still off');
  for (let p = 1; p <= SLIDER_MAX; p++) {
    assert.ok(sliderToRate(p) > 0, `position ${p} claimed to be off`);
  }
});

test('the geometric section changes by a constant ratio, at both ends', () => {
  // Equal *ratios* is the property, so it is measured as a ratio at the floor, in
  // the middle, and at the top — an implementation that clamped or used a
  // different formula in one region would pass a single-point check.
  //
  // The tolerance is a tenth of a percent rather than an ulp, because the rates
  // are rounded to four significant figures on the way out: the ratio is then
  // constant to within the rounding, which is what can be true of the numbers the
  // control produces. A scale that was not geometric misses by far more than that
  // — the linear slider this replaced moved the ratio by a factor of three across
  // the track — so the check still discriminates.
  for (const p of [1, 250, 499]) {
    const ratio = sliderToRate(p + 1) / sliderToRate(p);
    assert.ok(
      Math.abs(ratio / RATE_PER_STEP - 1) < 1e-3,
      `step at position ${p} is ${ratio}, not ${RATE_PER_STEP}`,
    );
  }

  // and it really is three decades over the five hundred positions
  assert.equal(sliderToRate(1), SLIDER_FLOOR);
  assert.equal(sliderToRate(500), SLIDER_TOP);
});

test('the slider reaches a mutation rate as small as one birth in ten thousand', () => {
  // This is the requirement, stated as one, because "constant ratio" alone does
  // not imply it: a linear 0..1 track over a thousand positions also has distinct
  // adjacent values, and its smallest non-zero rate would be 0.001 — ten times
  // coarser than the floor a mutation rate needs.
  assert.equal(sliderToRate(1), SLIDER_FLOOR, 'the first position above off is not the floor');
  assert.ok(sliderToRate(2) < 1.02 * SLIDER_FLOOR, 'one step off the floor is not a fine adjustment');
  assert.ok(sliderToRate(3) / sliderToRate(2) < 1.02, 'the second step is coarser than the first');
});

test('the linear section is equal differences, from the split to one', () => {
  const step = sliderToRate(501) - sliderToRate(500);
  for (const p of [500, 700, 999]) {
    assert.ok(Math.abs((sliderToRate(p + 1) - sliderToRate(p)) - step) < 1e-12, `unequal step at ${p}`);
  }
  assert.equal(sliderToRate(SLIDER_MAX), 1);
  // the two halves meet without a jump
  assert.ok(sliderToRate(501) - sliderToRate(500) < 0.005);
});

test('the ends are ends: a position past the track is clamped, not extrapolated', () => {
  assert.equal(sliderToRate(SLIDER_MAX + 50), 1);
  assert.equal(sliderToRate(SLIDER_MAX), sliderToRate(SLIDER_MAX + 1));
});

test('a rate the slider cannot reach is reported as unreachable, not rounded', () => {
  // Both of these are rates a world can hold. Reporting either as a position
  // would apply a different rate the moment the slider was touched.
  assert.equal(sliderPosition(1e-9), null, 'a rate below the floor was reported as a position');
  assert.equal(sliderPosition(-0.1), null);
  assert.equal(sliderPosition(1.5), null);
  assert.equal(sliderPosition(Number.NaN), null);

  // and the floor itself IS reachable — the boundary is on the reachable side
  assert.equal(sliderPosition(SLIDER_FLOOR), 1);
  assert.equal(sliderPosition(1), SLIDER_MAX);
  assert.equal(sliderPosition(0), 0);

  // a rate between grid points lands on the nearest one, which is why the page
  // keeps a box that states a rate exactly
  const nearest = sliderPosition(0.0001234);
  assert.notEqual(nearest, null, 'a rate inside the slider\'s range was reported as unreachable');
  assert.notEqual(sliderToRate(nearest ?? 0), 0.0001234, 'the grid is coarser than the input, and that is fine');
});

test('a rate is described in the units it is reasoned about in', () => {
  assert.equal(describeRate(0), 'no mutation');
  assert.equal(describeRate(1e-4), '1 birth in 10,000 is mutated');
  assert.equal(describeRate(3e-4), '1 birth in 3,333 is mutated');
  // the branch boundary is one birth in twenty, and it is tested from both sides
  assert.equal(describeRate(0.04), '1 birth in 25 is mutated');
  assert.equal(describeRate(0.05), '1 birth in 20 is mutated');
  assert.equal(describeRate(0.06), '6.0% of births are mutated');
  assert.equal(describeRate(0.5), '50% of births are mutated');
  assert.equal(describeRate(1), '100% of births are mutated');
});

test('the summary leads with the number, so the words cannot stand in for it', () => {
  assert.equal(summariseRate(0.00012), '0.00012 — 1 birth in 8,333 is mutated');
  assert.equal(summariseRate(0), '0 — no mutation');
  // A value carried by a saved world and set by no control still renders.
  assert.ok(summariseRate(1e-9).startsWith('1e-9 — '), summariseRate(1e-9));
  assert.equal(summariseRate(Number.NaN), 'not a rate');

  // The number is the value, at whatever width it has. Rounding it here would let
  // the line under a box read 0.0001234 while the box held 0.00012345.
  for (const rate of [0.5, 0.00012, 0.00012345, 0.0003937226329963481, 1e-9, 1]) {
    assert.equal(
      summariseRate(rate).split(' — ')[0],
      String(rate),
      `summariseRate(${rate}) did not lead with the value it was given`,
    );
  }
});
