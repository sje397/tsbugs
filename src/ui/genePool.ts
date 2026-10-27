/**
 * What a population's programs are made of.
 *
 * The interesting thing about a run of this simulation is not which creatures won
 * but what the instruction set turned out to be worth: a world that started on
 * random bytes settles into a handful of opcodes, and whether that handful is
 * three or fifteen is a fact about the selection pressure, not about the bugs. So
 * this counts opcodes across genomes and reports the distribution — with the
 * distribution's own shape, Shannon entropy, because "the top opcode is 43% of the
 * program" and "the program uses six opcodes at all" are different observations
 * and neither implies the other.
 *
 * IT SWEEPS, SO IT SAMPLES, AND IT SAYS SO
 *
 * A dish can hold thousands of bugs of several thousand bytes each; sweeping all
 * of them on every refresh is the whole frame budget spent on a number that is
 * being drawn as a bar chart. `genePool` therefore takes `sample` and reports
 * `bugs` — the genomes it actually read — alongside the totals, so a caller
 * printing "1,204 bugs" cannot accidentally be printing "over 10,000". Every
 * mean, every share and the entropy describe the SAMPLE.
 *
 * THE SAMPLE IS SPREAD, NOT CLIPPED
 *
 * Taking the first N genomes would be the natural thing to write and it is wrong
 * here in a specific way: `dish.cells` is ordered by cell hash and bugs in a cell
 * have a shared history, so the first N genomes are a biased slice of the
 * population — the same cells, the same lineages, possibly one founder's
 * descendants. The sample is instead every (population/sample)-th genome, which
 * costs one pass and touches the whole population as evenly as N picks can. The
 * test that pins this gives a population where only the LAST tenth of the genomes
 * use a given opcode and asserts that opcode still shows up: a first-N
 * implementation reports the opcode as extinct, which is the failure that would
 * make this panel lie about evolution.
 *
 * That spreadness needs the population size before the first pick, so the
 * iterable is materialised — an Iterable cannot be rewound. The cost is one array
 * of references, not a copy of the genomes, and a few thousand entries of that is
 * nothing beside the genomes themselves.
 *
 * NOTHING HERE IS RANDOM
 *
 * No RNG, no clock: the same genomes in the same order give the same pool, so a
 * frame can be refreshed on a timer without the bars twitching, and a test can
 * assert the numbers twice.
 *
 * DEGENERATE INPUT HAS NO NaN IN IT
 *
 * An empty dish is a normal state (the first tick after a load, or after an
 * extinction), so every ratio is guarded at its source: zero genomes gives zero
 * for the means, zero for the entropy and zero for the evenness, rather than
 * 0/0 propagated into the panel's width arithmetic. The tests assert
 * `!Number.isNaN` on every numeric field for exactly that case.
 */

import { decodeLinear } from '../sim/disasm.js';
import { MAX_I } from '../sim/processor.js';
import { opcodeNames } from './genomeMap.js';

/** One opcode's count in the sample, and its share of all decoded instructions. */
export interface OpcodeShare {
  opcode: number;
  name: string;
  /** Instructions in the sample with this opcode. */
  count: number;
  /** count / instructions, 0..1; 0 when nothing was decoded. */
  share: number;
}

/** The instruction repertoire of a sample of a population. */
export interface GenePool {
  /** Genomes actually swept — at most the requested sample, and at most the population. */
  bugs: number;
  /** Total instructions decoded from those genomes. */
  instructions: number;
  /** Total genome bytes swept. */
  bytes: number;
  /** Opcodes with a non-zero count. */
  distinct: number;
  /** All MAX_I opcodes, sorted by count descending then opcode ascending. */
  shares: OpcodeShare[];
  /** Mean genome length over the SAMPLE, 0 when bugs is 0. */
  meanLength: number;
  /** Shortest genome in the SAMPLE, 0 when bugs is 0. */
  minLength: number;
  /** Longest genome in the SAMPLE, 0 when bugs is 0. */
  maxLength: number;
  /** Shannon entropy of the opcode distribution, bits; 0 when nothing was decoded. */
  entropyBits: number;
  /**
   * entropyBits / log2(MAX_I), 0..1. 1 when every opcode is equally common, 0 when
   * only one opcode is used — or when nothing was decoded.
   */
  evenness: number;
}

/** log2 of the number of opcodes: the entropy of a perfectly even repertoire. */
const LOG2_MAX_I = Math.log2(MAX_I);

/**
 * How many genomes to sweep, and which ones.
 *
 * `wanted` is clamped to the population because asking for more than exists is
 * not an error; a negative or non-finite sample sweeps nothing, because the
 * failure mode to avoid is a bad number causing an unbounded sweep, not a bad
 * number causing an empty one.
 *
 * The picks are `floor(i * total / wanted)`, which spreads them over the whole
 * population: for 10 of 100 that is 0, 10, … 90 — including the last tenth, which
 * is where a first-N sample would have stopped looking.
 */
function pickSpread(genomes: readonly Uint8Array[], sample: number): Uint8Array[] {
  const total = genomes.length;
  const want = Number.isFinite(sample) ? Math.min(total, Math.max(0, Math.floor(sample))) : 0;

  const picked: Uint8Array[] = [];
  for (let i = 0; i < want; i++) {
    picked.push(genomes[Math.floor((i * total) / want)]);
  }
  return picked;
}

/**
 * Shannon entropy of a count distribution, in bits.
 *
 * Zero counts are skipped rather than contributing `0 * log2(0)`, which is 0 in
 * the limit and NaN in JavaScript. A single opcode has entropy 0 by definition,
 * not by rounding: its only term is `1 * log2(1)`.
 */
function shannonBits(counts: readonly number[], total: number): number {
  if (total <= 0) return 0;
  let bits = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / total;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Sweep at most `sample` genomes, spread across the population rather than the
 * first N, and describe their instruction repertoire.
 *
 * The genomes are the ones a bug would pass on (`bug.dna.data`), not the bytes its
 * processor is currently running: a bug that has stored over its own genome is
 * editing working memory, and counting that as the population's program would
 * describe a machine state as an inheritance.
 */
export function genePool(genomes: Iterable<Uint8Array>, sample: number): GenePool {
  const all: Uint8Array[] = [];
  for (const genome of genomes) all.push(genome);

  const picked = pickSpread(all, sample);

  const names = opcodeNames();
  const counts = new Array<number>(MAX_I).fill(0);
  let instructions = 0;
  let bytes = 0;
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;

  for (const genome of picked) {
    bytes += genome.length;
    if (genome.length < minLength) minLength = genome.length;
    if (genome.length > maxLength) maxLength = genome.length;
    for (const ins of decodeLinear(genome)) {
      counts[ins.opcode] += 1;
      instructions += 1;
    }
  }

  const bugs = picked.length;
  const shares: OpcodeShare[] = counts.map((count, opcode) => ({
    opcode,
    name: names[opcode],
    count,
    share: instructions > 0 ? count / instructions : 0,
  }));
  // Count descending, then opcode ascending: the ordering a bar chart reads top to
  // bottom, with ties broken by the enum so the order is total and stable.
  shares.sort((a, b) => b.count - a.count || a.opcode - b.opcode);

  const entropyBits = shannonBits(counts, instructions);
  // Clamped, not because the arithmetic is expected to exceed 1 — entropy cannot —
  // but because 'evenness' is documented as a fraction and a caller multiplying it
  // by a width should not have to wonder about 1.0000000000000002.
  const evenness = instructions > 0 ? Math.min(1, Math.max(0, entropyBits / LOG2_MAX_I)) : 0;

  return {
    bugs,
    instructions,
    bytes,
    distinct: counts.reduce((n, count) => n + (count > 0 ? 1 : 0), 0),
    shares,
    meanLength: bugs > 0 ? bytes / bugs : 0,
    minLength: bugs > 0 ? minLength : 0,
    maxLength: bugs > 0 ? maxLength : 0,
    entropyBits,
    evenness,
  };
}
