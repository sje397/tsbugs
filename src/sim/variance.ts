/**
 * The population's per-gene spread — upstream's HistogramDialog, as a function.
 *
 * Each gene position is a column. For position i, upstream buckets the byte every
 * bug holds there, finds the most common byte, and reports the fraction of the
 * population that is *not* at it (histogramdialog.cpp:52-76):
 *
 *     scaled_v = (pop - buckets[maxi]) / (double)pop;   c = (int)(scaled_v * 255);
 *
 * So 0 means the whole population holds the same byte at that position and 1 means
 * no two bugs agree. That is selection made visible: a column pinned at 0 is a
 * gene the world has stopped varying, and a column near 1 is one it does not
 * constrain. The port keeps it as a number rather than a bar height because the
 * graph wants both the value and the population behind it.
 *
 * Two upstream details are kept deliberately:
 *
 *  - A bug whose DNA is shorter than the position lands in bucket 256, one past
 *    the byte range, which upstream's `d = 256` sentinel means as "no such gene".
 *    Bins are per position, so this cannot mix with the byte 0 bin.
 *  - The modal bucket counts as agreement even when nothing holds a byte there, so
 *    a position beyond every genome reads 0 rather than 1.
 *
 * One divergence: at population 0 upstream computes 0/0, which is NaN in floating
 * point and then `(int)(NaN * 255)` — undefined behaviour in C++, and no meaning
 * worth reproducing. An empty population reads 0 across the board here.
 */

/** How many samples the histogram has to be computed over, and how uneven they are. */
export interface GeneSpread {
  /** Genomes sampled — upstream's `pop`, the denominator of every fraction. */
  readonly population: number;
  /** One entry per gene position in 0..maxData-1, each in 0..1. */
  readonly spread: Float64Array;
  /** Positions at 0 spread: the whole population agrees there. */
  readonly fixedPositions: number;
  /** The position with the most disagreement, and its spread (0 when empty). */
  readonly widestPosition: number;
  readonly widestSpread: number;
}

/** Buckets per position: the 256 byte values, plus the short-genome sentinel. */
const SENTINEL = 256;
const BUCKET_COUNT = SENTINEL + 1;

/**
 * Spread per gene position over `genomes`, for positions 0..maxData-1.
 *
 * Cost is maxData x population, which is what upstream pays per repaint (8192 x
 * ~150 here). The UI calls this on demand rather than per frame for that reason.
 */
export function geneSpread(genomes: readonly Uint8Array[], maxData: number): GeneSpread {
  const population = genomes.length;
  const spread = new Float64Array(maxData);
  const buckets = new Int32Array(BUCKET_COUNT);

  let fixedPositions = 0;
  let widestPosition = 0;
  let widestSpread = 0;

  for (let gene = 0; gene < maxData; gene++) {
    buckets.fill(0);
    let modal = 0;
    for (const genome of genomes) {
      // Upstream reads `dna[i]` for i < size and the sentinel otherwise; a gene
      // position past the end of a bug's DNA is a bucket of its own.
      const bucket = gene < genome.length ? genome[gene] : SENTINEL;
      const count = ++buckets[bucket];
      // Strictly greater, so ties keep the lower index — upstream's comparison.
      if (count > buckets[modal]) modal = bucket;
    }

    const value = population === 0 ? 0 : (population - buckets[modal]) / population;
    spread[gene] = value;
    if (value === 0) fixedPositions++;
    if (value > widestSpread) {
      widestSpread = value;
      widestPosition = gene;
    }
  }

  return { population, spread, fixedPositions, widestPosition, widestSpread };
}
