/**
 * The generation histogram: how far down its own lineage each living bug is.
 *
 * The ticker and the Generation series both report `maxGen`, which is one number
 * about one bug. Two worlds with the same `maxGen` can be completely different
 * populations — one where a single lineage got to generation 40 while everything
 * else is fresh stock, and one where forty bugs all sit at generation 40 — and
 * `maxGen` cannot tell them apart. This chart is the distribution behind that
 * number.
 *
 * WHY IT IS INTERESTING AT ALL. A world is a mixture of arrival and descent:
 * `balance()` tops the world back up with *generation 0* bugs whenever bug energy
 * falls below `minBugEnergy` (dish.ts:636), so the population is always some stock
 * plus some descendants, and the proportions are what a world's regime looks like.
 * A population whose generations all sit near zero is a world where nothing is
 * getting far enough to inherit; one with a long tail is a world where lineages
 * are surviving. Measured on the two-dot preset at tick 35000, seed 1234: 59 bugs
 * at generations 0-2 and 53 at 13-30 — two humps, which is exactly the shape a
 * single number cannot report.
 *
 * THE AXIS HAS TO MOVE, and it moves by whole bins. Generation only climbs, so a
 * fixed axis either starts at zero and loses all resolution once a lineage is deep,
 * or has to be re-scaled. Here the bins are anchored at generation 0 in multiples
 * of `step` — bin k covers generations [k*step, (k+1)*step) — and the window is
 * whichever bins the population actually occupies. So a bar never represents a
 * different range of generations from one refresh to the next; the window slides,
 * and the left edge moves only when the youngest living bug's generation enters a
 * new bin. Anchoring per-refresh (bins starting at whatever the current minimum is)
 * would be the easy version and would make every bar crawl sideways as the
 * population drifts.
 *
 * THE STEP WIDENS rather than the window clipping. A deep world needs either more
 * bins than the strip has pixels or a coarser step; clipping the old bins would make
 * a second, older population vanish from a chart whose entire purpose is noticing
 * that it exists. So `chooseStep` picks from a 1-2-5 ladder wide enough that the
 * occupied range fits, and nothing is ever dropped.
 */

/**
 * Bin widths, in generations. 1-2-5 per decade rather than any integer, because a
 * continuous step would change on almost every refresh and the axis label would be
 * unreadable. Generation counts are small integers in practice — the two-dot preset
 * runs ranges of 4 to 44 over 200,000 ticks — so the low end of the ladder is where
 * this chart spends its life.
 */
const STEP_LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000] as const;

function isLadderStep(step: number): boolean {
  return (STEP_LADDER as readonly number[]).includes(step);
}

/**
 * The number of bins a span occupies at a given step, counting both ends: a span of
 * exactly `step` generations straddles two bins, not one. `binGenerations` uses the
 * same arithmetic, so a step this module calls a fit is a fit in the chart.
 */
export function binsForSpan(span: number, step: number): number {
  const width = Math.max(1, Math.trunc(step));
  return Math.floor(Math.max(0, span) / width) + 1;
}

/**
 * The narrowest width from the ladder whose bins fit `span` into `maxBars`.
 *
 * `maxBars - 1` rather than `maxBars` in the divisor: an inclusive bin count is one
 * more than span/step, and using maxBars there would produce a step that is one bin
 * too narrow at every boundary.
 */
export function idealStep(span: number, maxBars: number): number {
  const bars = Math.max(2, Math.trunc(maxBars));
  const needed = Math.max(1, span) / (bars - 1);
  for (const step of STEP_LADDER) {
    if (step >= needed) return step;
  }
  // Past the top of the ladder the step keeps doubling, so an absurd span still
  // gets a chart instead of a silent overflow of the whole strip.
  const top = STEP_LADDER[STEP_LADDER.length - 1];
  return top * 2 ** Math.ceil(Math.log2(needed / top));
}

/**
 * How empty the strip has to be at the finer width before the axis narrows again.
 *
 * Not a tuning knob so much as the width of the deadband. Without one, the ideal
 * step alone flickers: a span sitting on a boundary (59, then 60, then 59) changes
 * the width, the bar count and the axis label on alternate refreshes, and a reader
 * cannot tell that from the world changing. Measured against the two-dot preset,
 * spans of 4 to 44 arrive within a few thousand ticks of each other, so this is not
 * a hypothetical.
 */
const NARROW_FILL = 0.75;

/**
 * The step to draw at, given what was drawn last time.
 *
 * Widening is immediate, because the data no longer fits and there is nothing to
 * wait for. Narrowing waits until the finer width would use no more than three
 * quarters of the strip, so the span has to have genuinely shrunk rather than
 * wobbled across a boundary.
 */
export function chooseStep(span: number, maxBars: number, current = 1): number {
  const ideal = idealStep(span, maxBars);
  if (!isLadderStep(current) || ideal >= current) return ideal;
  return binsForSpan(span, ideal) <= Math.max(2, Math.trunc(maxBars)) * NARROW_FILL ? ideal : current;
}

export interface GenerationBins {
  /** Generations per bin. */
  readonly step: number;
  /** Generation at the left edge of the first bin: always a multiple of `step`. */
  readonly first: number;
  /** Bug count per bin, oldest first. Empty when nothing is alive. */
  readonly counts: readonly number[];
  /** Bugs counted. Equals the sum of `counts`. */
  readonly total: number;
}

/**
 * Count the living population by generation, in bins anchored at generation 0.
 *
 * The window is the occupied bins and nothing else: `first` is the bin holding the
 * youngest living bug and the last bin holds the oldest. Neither end is padded out
 * to a round number, because padding would draw empty bars that look like a
 * population that had died out.
 *
 * Generation is a non-negative integer by construction (bug.ts: `generation = 0`
 * for injected stock, `max(mum, dad) + 1` for a birth), so a value that is not
 * finite is not a generation. Those are skipped rather than binned, because a NaN
 * bin index would make `first` NaN and blank the whole chart over one bad value.
 */
export function binGenerations(generations: Iterable<number>, step: number): GenerationBins {
  const width = Math.max(1, Math.trunc(step));
  // Collected, not walked twice: `Iterable` includes a generator, which is empty on
  // the second pass, so finding the window and filling it have to share one read.
  const values: number[] = [];
  for (const generation of generations) {
    if (Number.isFinite(generation)) values.push(generation);
  }
  if (values.length === 0) return { step: width, first: 0, counts: [], total: 0 };

  let firstBin = Infinity;
  let lastBin = -Infinity;
  for (const generation of values) {
    const bin = Math.floor(generation / width);
    if (bin < firstBin) firstBin = bin;
    if (bin > lastBin) lastBin = bin;
  }

  const counts: number[] = new Array(lastBin - firstBin + 1).fill(0);
  for (const generation of values) counts[Math.floor(generation / width) - firstBin] += 1;

  return { step: width, first: firstBin * width, counts, total: values.length };
}

/** The generations a bin covers, inclusive at both ends: bin k is [lo, lo + step - 1]. */
export function binRange(bins: GenerationBins, index: number): { lo: number; hi: number } {
  const i = Math.min(bins.counts.length - 1, Math.max(0, Math.trunc(index)));
  const lo = bins.first + i * bins.step;
  return { lo, hi: lo + bins.step - 1 };
}

/** The tallest bin, and the generations it covers. Ties go to the older bin. */
export function peakBin(bins: GenerationBins): { index: number; count: number; lo: number; hi: number } | null {
  let index = -1;
  let count = 0;
  bins.counts.forEach((value, i) => {
    if (value > count) {
      count = value;
      index = i;
    }
  });
  if (index < 0) return null;
  return { index, count, ...binRange(bins, index) };
}

/**
 * What the chart's readout line says about the measurement behind it.
 *
 * It names the span and the step rather than relying on the axis labels, because
 * the axis labels are 10-pixel text at the two ends of a strip and the step is the
 * one number that changes what every bar means. Without it, a chart at 5
 * generations per bin and the same chart at 1 are indistinguishable at a glance —
 * and the wider one is the one that can hide a second hump inside a single bar.
 */
export function histogramSummary(input: { readonly tick: number; readonly bins: GenerationBins }): string {
  const { tick, bins } = input;
  const at = `tick ${tick}`;
  if (bins.total === 0) return `${at} · no bugs to count`;

  const last = binRange(bins, bins.counts.length - 1);
  const span = `gen ${bins.first}–${last.hi}`;
  const step = bins.step === 1 ? '1 gen/bin' : `${bins.step} gen/bin`;
  const peak = peakBin(bins);
  const top = peak === null ? '' : ` · peak ${peak.count} at ${peak.lo === peak.hi ? `gen ${peak.lo}` : `gen ${peak.lo}–${peak.hi}`}`;
  return `${at} · ${bins.total} bugs · ${span} · ${step}${top}`;
}
