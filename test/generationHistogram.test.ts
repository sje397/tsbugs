/**
 * The generation histogram's arithmetic, which is where this chart can lie quietly.
 *
 * Three properties decide whether it is honest, and each is stated against the
 * plausible alternative it rules out:
 *
 *   - a bar must describe the same generations on every refresh, or the window
 *     slides and the chart reads as the world changing when only the axis moved;
 *   - nothing may be dropped. A second, older population is precisely what this
 *     chart exists to reveal, and clipping it would delete the finding;
 *   - the step may not flicker. A width that changes on alternate refreshes is
 *     indistinguishable from a change in the world.
 *
 * Every one of these was falsified by writing the alternative and watching exactly
 * these assertions fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  binGenerations,
  binRange,
  binsForSpan,
  chooseStep,
  histogramSummary,
  idealStep,
  peakBin,
} from '../src/ui/generationHistogram.js';

/** Which bin holds a generation, in the same arithmetic binGenerations uses. */
function binOf(first: number, step: number, generation: number): number {
  return Math.floor(generation / step) - Math.floor(first / step);
}

test('a generation lands in the same bin whatever else is alive', () => {
  // The anti-shimmer property, and it only bites above one generation per bin: at a
  // width of 1 every integer is a boundary, so both anchorings agree and a
  // step-1 fixture would pass against the wrong implementation.
  //
  // Anchoring the window at the population's current minimum (the easy version)
  // makes generation 20 land in 20-24 when it is alone, and in 16-20 as soon as a
  // generation-6 bug joins it -- the same age reported differently because someone
  // else arrived.
  const alone = binGenerations([20], 5);
  const crowded = binGenerations([6, 20], 5);

  const indexAlone = binOf(alone.first, alone.step, 20);
  const indexCrowded = binOf(crowded.first, crowded.step, 20);
  assert.deepEqual(binRange(alone, indexAlone), { lo: 20, hi: 24 });
  assert.deepEqual(binRange(crowded, indexCrowded), { lo: 20, hi: 24 }, 'gen 20 must not move because gen 6 arrived');

  // ...and the whole bar is the same bar, not just its label.
  assert.equal(alone.counts[indexAlone], 1);
  assert.equal(crowded.counts[indexCrowded], 1);
  assert.equal(crowded.first, 5, 'the window starts at a multiple of the width, not at the youngest bug');
});

test('bins are anchored at generation zero, not at the youngest bug', () => {
  // With a width of 5 the first bin must be a multiple of 5, so bin k is always
  // [5k, 5k+4]. A window that started at the minimum would begin at 7 here.
  const bins = binGenerations([7, 8, 9], 5);
  assert.equal(bins.first, 5);
  assert.deepEqual([...bins.counts], [3]);
  assert.deepEqual(binRange(bins, 0), { lo: 5, hi: 9 });
});

test('the window covers exactly the occupied bins, with no empty ends', () => {
  // Padding the axis out to a round number would draw empty bars that look like a
  // population that died out. Both ends are the data.
  const bins = binGenerations([3, 4, 5, 9], 1);
  assert.equal(bins.first, 3);
  assert.equal(bins.counts.length, 7);
  assert.deepEqual([...bins.counts], [1, 1, 1, 0, 0, 0, 1]);
  assert.equal(bins.counts[0], 1, 'the first bin holds the youngest bug');
  assert.equal(bins.counts[bins.counts.length - 1], 1, 'the last bin holds the oldest');
});

test('a one-shot iterable is counted once, not walked twice', () => {
  // Finding the window and filling it are two passes over the same values. `Iterable`
  // admits a generator, which is empty on the second pass, so the two passes have to
  // share one read -- otherwise every count comes back zero for a caller that passed
  // a generator rather than an array.
  function* once(): Generator<number> {
    yield 0;
    yield 0;
    yield 4;
  }
  const bins = binGenerations(once(), 1);
  assert.equal(bins.total, 3);
  assert.deepEqual([...bins.counts], [2, 0, 0, 0, 1]);
});

test('an empty population is no bars, not one empty bar', () => {
  const bins = binGenerations([], 1);
  assert.deepEqual([...bins.counts], []);
  assert.equal(bins.total, 0);
  assert.equal(peakBin(bins), null);
  assert.match(histogramSummary({ tick: 12, bins }), /no bugs to count/);
});

test('a value that is not a generation is skipped rather than blanking the chart', () => {
  // Generations are non-negative integers by construction (bug.ts), so this cannot
  // happen -- but a NaN bin index would make `first` NaN and blank every bar, so one
  // impossible value must not take the whole chart with it.
  const bins = binGenerations([3, Number.NaN, 5, Number.POSITIVE_INFINITY], 1);
  assert.equal(bins.total, 2);
  assert.equal(bins.first, 3);
  assert.deepEqual([...bins.counts], [1, 0, 1]);
});

test('the bin count a step produces is the bin count binsForSpan predicts', () => {
  // The step choice is a promise about how many bars the strip will hold. If these
  // two disagreed, chooseStep would certify a width that overflows the chart, and
  // the overflow would be invisible because the far end is just off-screen.
  for (const maxBars of [12, 40, 60, 200]) {
    for (const span of [0, 1, 4, 5, 9, 10, 11, 29, 30, 44, 59, 60, 61, 118, 119, 240]) {
      const step = idealStep(span, maxBars);
      const bins = binGenerations([0, span], step);
      assert.equal(
        bins.counts.length,
        binsForSpan(span, step),
        `span ${span} at step ${step} should hold ${binsForSpan(span, step)} bins`,
      );
      assert.ok(
        bins.counts.length <= maxBars,
        `span ${span}, maxBars ${maxBars}: ${step} gen/bin gives ${bins.counts.length} bars`,
      );
    }
  }
});

test('the step widens as soon as the data stops fitting', () => {
  // No hysteresis in this direction: an overflowing axis is a chart that has lost
  // its far end, and waiting for a second refresh to fix it is waiting for nothing.
  assert.equal(idealStep(59, 60), 1, '59 generations is 60 one-generation bins');
  assert.equal(idealStep(60, 60), 2, '60 needs 61 bins, so it does not fit at 1');
  assert.equal(chooseStep(60, 60, 1), 2);
  assert.equal(chooseStep(600, 60, 2), 20);
});

test('the step does not flicker on a boundary', () => {
  // 59, 60, 59 is a span wobbling by one generation. The ideal step alternates
  // 1, 2, 1 -- which would redraw every bar at half width and swap the axis label on
  // alternate refreshes -- so once it has widened it stays wide until the span has
  // genuinely shrunk.
  let step = chooseStep(59, 60, 1);
  assert.equal(step, 1);
  step = chooseStep(60, 60, step);
  assert.equal(step, 2, 'it widens immediately');
  step = chooseStep(59, 60, step);
  assert.equal(step, 2, 'and does not narrow back on a one-generation wobble');
  step = chooseStep(58, 60, step);
  assert.equal(step, 2);
});

test('the step narrows again once the span has genuinely shrunk', () => {
  // Three quarters of the strip, not a hair below the boundary: at 45 bars or fewer
  // the finer width has room to spare, so the deadband is exited.
  assert.equal(chooseStep(44, 60, 2), 1);
  assert.equal(chooseStep(30, 60, 2), 1);

  // A large shrink crosses rungs in one step rather than crawling.
  assert.equal(chooseStep(30, 60, 5), 1);
});

test('the deadband lags the axis by at most a quarter of the strip', () => {
  // The cost of not flickering, stated. 100 generations fits one-per-two at 51 bars
  // of 60, but it is only 15% below the point where that width would overflow, so
  // narrowing there would put the axis back into the band it just left. The width
  // therefore stays coarse until the span is comfortably clear of the boundary.
  assert.equal(chooseStep(100, 60, 5), 5);
  assert.equal(chooseStep(89, 60, 5), 2, '45 bars of 60 is clear enough');
});

test('two populations far apart stay two humps at the chosen width', () => {
  // The measured shape of the two-dot preset at tick 35000, seed 1234: 59 bugs at
  // generations 0-2 and 53 at 13-30. A chart that merged these would be reporting
  // one population where there are two, which is the whole question the chart
  // exists to answer.
  const generations: number[] = [];
  for (let i = 0; i < 59; i++) generations.push(i % 3);
  for (let i = 0; i < 53; i++) generations.push(13 + (i % 18));

  const span = 30;
  const step = chooseStep(span, 60);
  assert.equal(step, 1, 'a 30-generation span fits one generation per bin');

  const bins = binGenerations(generations, step);
  const occupied = bins.counts.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  const gaps = occupied.slice(1).filter((i, n) => i > occupied[n] + 1);
  assert.ok(gaps.length > 0, 'the two clusters must be separated by an empty run of bins');
  assert.equal(bins.total, 112);
});

test('peakBin names the generations it is counting, and ties go to the older bin', () => {
  const bins = binGenerations([2, 2, 7], 1);
  assert.deepEqual(peakBin(bins), { index: 0, count: 2, lo: 2, hi: 2 });

  // Two bins of equal height: the older one is named, so the readout is stable as
  // the newer population arrives rather than jumping at every tie.
  const tied = binGenerations([1, 1, 9, 9], 1);
  assert.equal(peakBin(tied)?.lo, 1);
});

test('a bin index outside the window is clamped rather than read as undefined', () => {
  const bins = binGenerations([5, 7], 1);
  assert.deepEqual(binRange(bins, -3), { lo: 5, hi: 5 });
  assert.deepEqual(binRange(bins, 99), { lo: 7, hi: 7 });
});

test('the readout names the span, the step and the peak', () => {
  // The step is the one number that changes what every bar means, and it is not in
  // the axis labels: 5 generations per bin and 1 per bin look the same at a glance,
  // and the wider one is the one that can hide a second hump inside a single bar.
  const summary = histogramSummary({ tick: 35000, bins: binGenerations([0, 1, 2, 13, 30], 1) });
  assert.match(summary, /^tick 35000 /);
  assert.match(summary, /5 bugs/);
  assert.match(summary, /gen 0–30/);
  assert.match(summary, /1 gen\/bin/);
  assert.match(summary, /peak 1 at gen 0/);

  const coarse = histogramSummary({ tick: 1, bins: binGenerations([0, 30], 10) });
  assert.match(coarse, /10 gen\/bin/);
});
