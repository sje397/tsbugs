import type { GeneSpread } from '../sim/variance.js';


/**
 * Drawing the gene histogram: which genes a pixel column shows, and what colour.
 *
 * Upstream's HistogramDialog paints one bar per gene position into a widget a few
 * hundred pixels wide, so 8192 positions become far fewer columns and Qt decides
 * what survives that collapse by painting order — a detail nobody chose and no one
 * could test. Here the collapse is explicit and stated, and the tests pin it.
 *
 * MAX, not mean, per column. A gene position that varies is the signal this graph
 * exists to show, and averaging it against the neighbours it shares a pixel with
 * is exactly how a single variable gene disappears. The cost of that choice is
 * stated rather than hidden: a column at 1.0 says "at least one position in here
 * is unconstrained", not "all of them are".
 *
 * One ramp, not two. Upstream's dialog builds its own 256-entry red→yellow→green
 * table spanning the full 0..255 range, while the world's palette spans 1..252 —
 * so the same spread value is two different colours on the two surfaces. This uses
 * the world's table (palette index 1 + round(value * 251)) so a colour means one
 * thing on the page. The direction matches upstream: low spread is red, high green.
 *
 * The page calls geneSpread() on a timer, not per frame: it costs maxData x
 * population per call — 2.34 ms measured at 8192 x 77 here — which upstream paid
 * per repaint of an open dialog at 500 ms. `chartSummary` reports the figure so
 * the cost is visible instead of inferred.
 */

/** Palette index for a spread value in 0..1. Index 1 is red (agreement), 252 green. */
export function barIndex(value: number): number {
  if (!(value > 0)) return 1; // also catches NaN: an unmeasured column is agreement, not a bright bar
  if (value >= 1) return 252;
  return 1 + Math.round(value * 251);
}

/**
 * One value per drawn column, each the largest spread among the gene positions it
 * covers. `columns` below 1 is treated as 1 so a zero width cannot divide by zero.
 */
export function chartColumns(spread: Float64Array, columns: number): Float64Array {
  const width = Math.max(1, Math.trunc(columns));
  const out = new Float64Array(width);
  const positions = spread.length;
  if (positions === 0) return out;

  for (let gene = 0; gene < positions; gene++) {
    // Position i belongs to column floor(i * width / positions), the same mapping
    // geneAtColumn inverts, so a click lands on a gene the column actually shows.
    const column = Math.min(width - 1, Math.floor((gene * width) / positions));
    if (spread[gene] > out[column]) out[column] = spread[gene];
  }
  return out;
}

/**
 * The gene position a click on `column` selects: the middle of the positions that
 * column covers, so a click picks a representative gene rather than its left edge.
 * Clamped, so a click at either extreme cannot read outside the genome.
 */
export function geneAtColumn(column: number, columns: number, maxData: number): number {
  const width = Math.max(1, Math.trunc(columns));
  const c = Math.min(width - 1, Math.max(0, Math.trunc(column)));
  if (maxData <= 0) return 0;
  // Inverse of the mapping in chartColumns, evaluated at the column's midpoint.
  const mid = ((c + 0.5) * maxData) / width;
  return Math.min(maxData - 1, Math.max(0, Math.floor(mid)));
}

/**
 * What the chart's readout line says about the measurement behind it.
 *
 * `tick` leads, always. This graph is a measurement of a world that keeps moving,
 * and it is refreshed on a timer rather than per frame, so a line that did not
 * carry the tick its numbers came from would be indistinguishable from a current
 * one -- the same way the inspector would describe a dead bug as a live one.
 *
 * The measurement is taken whole (`spread`) rather than field by field. The page
 * imports the built modules as plain JavaScript, so nothing type-checks a caller
 * against GeneSpread -- and a hand-copied field list is exactly where a number
 * silently becomes `undefined`. Passing the object makes that unrepresentable.
 */
export function chartSummary(input: {
  readonly tick: number;
  readonly spread: GeneSpread;
  readonly columns: number;
  readonly ms: number;
}): string {
  const { tick, spread, columns, ms } = input;
  const { population, fixedWithinGenome, widestPosition, widestSpread } = spread;
  const positions = spread.spread.length;
  const cost = `measured in ${ms.toFixed(1)} ms`;
  const at = `tick ${tick}`;
  if (population === 0) return `${at} · no bugs to measure — ${cost}`;

  const perColumn = positions / Math.max(1, columns);
  const collapse =
    perColumn > 1
      ? `${positions} genes into ${columns} columns, max per column`
      : `${positions} genes, one column each`;
  const widest = `widest at ${widestPosition} (${widestSpread.toFixed(2)})`;
  return `${at} · ${population} bugs · ${collapse} · ${fixedWithinGenome} fixed · ${widest} · ${cost}`;
}
