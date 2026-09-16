/**
 * The gene chart's geometry, which is where a histogram quietly lies.
 *
 * Upstream collapsed 8192 gene positions into a dialog a few hundred pixels wide
 * inside a paint event, so nothing could check what survived the collapse and
 * nothing did. Each property below is stated against the implausible alternative
 * it rules out, and each was falsified by writing that alternative and watching
 * exactly these tests fail.
 */

import type { GeneSpread } from '../src/sim/variance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { barIndex, chartColumns, chartSummary, geneAtColumn } from '../src/ui/varianceChart.js';

test('a column shows the worst position under it, not the average', () => {
  // MAX, not mean. Two genes share one column: one fixed, one fully variable.
  // Averaging reports 0.5 and the variable gene becomes a mid-height bar nobody
  // would look at; a mean-of-neighbours is the exact failure this rules out.
  const mean = chartColumns(Float64Array.from([0, 1]), 1)[0];
  assert.equal(mean, 1, 'a variable gene next to a fixed one must still read 1');

  // ...and it is the maximum of the pair, not whichever came last.
  assert.equal(chartColumns(Float64Array.from([0.8, 0.2]), 1)[0], 0.8);
  assert.equal(chartColumns(Float64Array.from([0.2, 0.8]), 1)[0], 0.8);
});

test('every position lands in a column, including the last one', () => {
  // A tail-only fixture: an implementation that wrapped with `gene % width`
  // instead of scaling would file this gene in column 8191 % 600 = 391.
  const positions = 8192;
  const columns = 600;
  const spread = new Float64Array(positions);
  spread[positions - 1] = 0.9;

  const bars = chartColumns(spread, columns);
  assert.equal(bars.length, columns);
  assert.equal(bars[columns - 1], 0.9, 'the final gene belongs in the final column');
  assert.equal(bars.filter((v) => v !== 0).length, 1);
});

test('more columns than positions spaces them across the axis, leaving the gaps empty', () => {
  // The chart's x-axis is gene position over 0..maxData-1, so few positions are
  // spread across the width rather than packed at the left. That is what keeps the
  // axis invertible: gene 1 of 2 sits at the midpoint's column, and geneAtColumn
  // answers with gene 1 there. Left-aligning would make the axis lie about position.
  const bars = chartColumns(Float64Array.from([0.25, 0.75]), 5);
  assert.equal(bars.length, 5);
  assert.deepEqual([...bars], [0.25, 0, 0.75, 0, 0]);
  assert.equal(geneAtColumn(2, 5, 2), 1, 'the column the second gene landed in selects it');
  assert.equal(geneAtColumn(0, 5, 2), 0);
});

test('an empty or zero-width chart is empty rather than NaN', () => {
  assert.deepEqual([...chartColumns(new Float64Array(0), 4)], [0, 0, 0, 0]);
  assert.equal(chartColumns(new Float64Array(0), 0).length, 1);
  assert.deepEqual([...chartColumns(Float64Array.from([1]), 0)], [1]);
});

test('a click selects a gene inside the column it came from', () => {
  const positions = 1000;
  const columns = 64;

  for (let c = 0; c < columns; c++) {
    const gene = geneAtColumn(c, columns, positions);
    assert.ok(gene >= 0 && gene < positions, `column ${c} selected gene ${gene}`);

    // The gene must actually be one the column draws: land it back through the
    // same mapping chartColumns uses.
    const owner = Math.min(columns - 1, Math.floor((gene * columns) / positions));
    assert.equal(owner, c, `column ${c} selected a gene belonging to column ${owner}`);
  }
});

test('a click selects a representative gene, not the column edge', () => {
  // A column 10 genes wide must not answer with its left edge: the left-edge
  // implementation passes the test above, so this is the one that rules it out.
  const positions = 1000;
  const columns = 100; // 10 genes per column
  const gene = geneAtColumn(3, columns, positions);
  assert.equal(gene, 35, 'the middle of genes 30..39');
  assert.notEqual(gene, 30, 'not the edge');
});

test('the colour ramp is bounded by the world palette, at both ends', () => {
  assert.equal(barIndex(0), 1, 'complete agreement is the red end');
  assert.equal(barIndex(1), 252, 'complete disagreement is the green end');

  // The reserved colours live at 253..255 (cyan, magenta, energy blue), so an
  // out-of-range value must clamp rather than reach them.
  assert.equal(barIndex(1.4), 252);
  assert.equal(barIndex(-0.2), 1);
  assert.equal(barIndex(Number.NaN), 1, 'an unmeasured column is not a bright bar');

  // Monotone through the range, since the ramp is read as "more variation".
  let previous = 0;
  for (let i = 0; i <= 20; i++) {
    const index = barIndex(i / 20);
    assert.ok(index >= previous, `value ${i / 20} went backwards`);
    previous = index;
  }
});

/**
 * A measurement shaped like geneSpread's, assembled by hand so a test can put the
 * two fixed counts *against* each other: the sentinel tail means `fixedPositions`
 * and `fixedWithinGenome` differ in any world whose genomes are shorter than
 * maxData, and the readout has to print the second one (seed 2024: 128 vs 0).
 */
function measurement(input: {
  genomes: number;
  positions: number;
  fixedPositions: number;
  fixedWithinGenome: number;
  widestPosition: number;
  widestSpread: number;
}): GeneSpread {
  const spread = new Float64Array(input.positions);
  if (input.widestSpread > 0) spread[input.widestPosition] = input.widestSpread;
  return {
    population: input.genomes,
    spread,
    longestGenome: input.positions,
    fixedPositions: input.fixedPositions,
    fixedWithinGenome: input.fixedWithinGenome,
    widestPosition: input.widestPosition,
    widestSpread: input.widestSpread,
  };
}

test('the readout states the measurement and what it cost', () => {
  const line = chartSummary({
    tick: 200,
    spread: measurement({ genomes: 77, positions: 8192, fixedPositions: 128, fixedWithinGenome: 128, widestPosition: 0, widestSpread: 0.922 }),
    columns: 600,
    ms: 2.34,
  });
  assert.match(line, /^tick 200 · 77 bugs/, 'the tick the measurement came from leads, so a stale chart cannot read as current');
  assert.match(line, /8192 genes into 600 columns, max per column/);
  assert.match(line, /128 fixed/);
  assert.match(line, /widest at 0 \(0\.92\)/);
  assert.match(line, /2\.3 ms/, 'the cost is reported, not implied');

  // One column per gene reads as itself, not as a collapse.
  assert.match(
    chartSummary({
      tick: 5,
      spread: measurement({ genomes: 1, positions: 8, fixedPositions: 7, fixedWithinGenome: 7, widestPosition: 7, widestSpread: 1 }),
      columns: 8,
      ms: 0,
    }),
    /8 genes, one column each/,
  );

  // The seed-2024 world: 128 positions read 0 spread, every one of them past the
  // longest genome, so nothing is fixed. The readout prints the in-genome count --
  // printing `fixedPositions` here would claim 128 conserved genes that do not exist.
  const seeded = chartSummary({
    tick: 200,
    spread: measurement({ genomes: 77, positions: 8192, fixedPositions: 128, fixedWithinGenome: 0, widestPosition: 0, widestSpread: 0.922 }),
    columns: 352,
    ms: 1.6,
  });
  assert.match(seeded, /· 0 fixed ·/, 'a zero tail is not conservation');
  assert.match(seeded, /widest at 0 \(0\.92\)/, 'and the rest of the measurement is unaffected');

  // No bugs: the fraction is 0/0 upstream and UB downstream, so say nothing was measured.
  assert.equal(
    chartSummary({
      tick: 0,
      spread: measurement({ genomes: 0, positions: 8192, fixedPositions: 8192, fixedWithinGenome: 0, widestPosition: 0, widestSpread: 0 }),
      columns: 600,
      ms: 0.1,
    }),
    'tick 0 · no bugs to measure — measured in 0.1 ms',
  );
});
