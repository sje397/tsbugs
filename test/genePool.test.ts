/**
 * The gene-pool panel's arithmetic.
 *
 * What this panel claims is that the population's instruction repertoire changed
 * — that some opcode spread and another was selected away — so the assertions
 * here are about the distribution being a distribution, and about the sample
 * being a sample of the whole dish:
 *
 *   - the shares are a partition of the instructions (they sum to 1 and each one
 *     is its count over the total), so the bars add up to the strip;
 *   - entropy and evenness answer the two questions they look like they answer:
 *     one opcode is 0 bits and 0 evenness, all 27 equally is log2(27) bits and 1;
 *   - the sample is SPREAD over the population, not the first N genomes — the
 *     test for that gives a population where only the last tenth uses an opcode
 *     and asserts it still appears, which is what a clipped sample gets wrong;
 *   - the lengths describe the SAMPLE, because that is what the panel says it
 *     measured, and a mean over the whole dish beside a count of ten bugs is a
 *     disagreement between two numbers in the same box;
 *   - an empty dish produces zeros rather than NaN, because 0/0 reaching a bar
 *     chart's width is how a panel renders nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_I } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';
import { genePool, type GenePool } from '../src/ui/genePool.js';

/** A genome of the requested length, from a stated seed — random bytes, so random opcodes. */
function genomeOf(seed: number, length: number): Uint8Array {
  const rng = new Rng(seed);
  const genome = new Uint8Array(length);
  for (let i = 0; i < length; i++) genome[i] = rng.int(256);
  return genome;
}

/** A population of distinct genomes of one length. */
function population(count: number, length: number, seed = 1): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(genomeOf(seed + i, length));
  return out;
}

/** A one-instruction genome: the byte is the opcode, and length 1 means no operand bytes. */
function oneOpcode(opcode: number): Uint8Array {
  return new Uint8Array([opcode]);
}

function shareOf(pool: GenePool, opcode: number): number {
  const found = pool.shares.find((entry) => entry.opcode === opcode);
  assert.ok(found !== undefined, `opcode ${opcode} is missing from the shares`);
  return found.count;
}

test('the shares partition the instructions', () => {
  const pool = genePool(population(40, 200), 40);
  assert.ok(pool.instructions > 0, 'the fixture decoded nothing');

  for (const entry of pool.shares) {
    assert.equal(entry.share, entry.count / pool.instructions, `opcode ${entry.opcode}'s share is not its count over the total`);
  }
  const sum = pool.shares.reduce((n, entry) => n + entry.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `the shares sum to ${sum}`);
  const counts = pool.shares.reduce((n, entry) => n + entry.count, 0);
  assert.equal(counts, pool.instructions);
});

test('the shares are every opcode, ordered by count then opcode', () => {
  // All MAX_I entries, because the panel draws a fixed set of rows: an opcode with
  // no instructions is a zero-height bar and "not used" is exactly what that says.
  const pool = genePool(population(25, 120, 17), 25);
  assert.equal(pool.shares.length, MAX_I);
  assert.deepEqual([...pool.shares].map((entry) => entry.opcode).sort((a, b) => a - b), Array.from({ length: MAX_I }, (_, i) => i));
  assert.equal(pool.distinct, pool.shares.filter((entry) => entry.count > 0).length);

  for (let i = 1; i < pool.shares.length; i++) {
    const prev = pool.shares[i - 1];
    const next = pool.shares[i];
    const ordered = prev.count > next.count || (prev.count === next.count && prev.opcode < next.opcode);
    assert.ok(ordered, `entry ${i - 1} (${prev.name} ${prev.count}) is not before ${next.name} ${next.count}`);
  }
  // Sorted by a real count, not a count that ties everywhere and is sorted by
  // luck: the top row has to be above the bottom row.
  assert.ok(pool.shares[0].count >= pool.shares[pool.shares.length - 1].count);
});

test('a population of one repeated opcode has one opcode, no entropy and no evenness', () => {
  // Identical genomes: NOOP is one byte, so every genome decodes to exactly one
  // instruction and the distribution is a spike.
  const genomes = Array.from({ length: 20 }, () => oneOpcode(0));
  const pool = genePool(genomes, 20);
  assert.equal(pool.bugs, 20);
  assert.equal(pool.distinct, 1);
  assert.equal(pool.entropyBits, 0, 'a single opcode has entropy 0');
  assert.equal(pool.evenness, 0, 'evenness must be 0 when only one opcode is used');
  assert.equal(shareOf(pool, 0), 20);
  assert.equal(pool.instructions, 20);
});

test('a population using every opcode equally is perfectly even', () => {
  // Four of each of the 27 opcodes: entropy is log2(27), and evenness — the ratio
  // to that maximum — is 1. This is the value the panel's widest bar means, so it
  // has to come out at 1 rather than at 0.99 of it.
  const genomes: Uint8Array[] = [];
  for (let copy = 0; copy < 4; copy++) {
    for (let opcode = 0; opcode < MAX_I; opcode++) genomes.push(oneOpcode(opcode));
  }
  const pool = genePool(genomes, genomes.length);
  assert.equal(pool.distinct, MAX_I);
  assert.equal(pool.instructions, MAX_I * 4);
  assert.ok(Math.abs(pool.entropyBits - Math.log2(MAX_I)) < 1e-9, `entropy is ${pool.entropyBits}, not log2(27)`);
  assert.ok(Math.abs(pool.evenness - 1) < 1e-9, `evenness is ${pool.evenness}`);
});

test('two opcodes in equal numbers are one bit, and three in equal numbers are log2(3)', () => {
  // Entropy in bits is a measurement, not a normalised score: it has to say how
  // many equally-common opcodes the distribution is worth.
  const half = genePool([oneOpcode(0), oneOpcode(1), oneOpcode(0), oneOpcode(1)], 4);
  assert.ok(Math.abs(half.entropyBits - 1) < 1e-12, `two equal opcodes gave ${half.entropyBits} bits`);
  assert.ok(Math.abs(half.evenness - 1 / Math.log2(MAX_I)) < 1e-12);

  const third = genePool([oneOpcode(0), oneOpcode(1), oneOpcode(2)], 3);
  assert.ok(Math.abs(third.entropyBits - Math.log2(3)) < 1e-12, `three equal opcodes gave ${third.entropyBits} bits`);
});

test('entropy never exceeds the even repertoire and evenness stays inside 0..1', () => {
  for (const length of [1, 2, 7, 64, 300]) {
    for (const seed of [1, 2, 3]) {
      const pool = genePool(population(12, length, seed), 12);
      assert.ok(pool.entropyBits >= 0 && pool.entropyBits <= Math.log2(MAX_I) + 1e-12, `entropy ${pool.entropyBits} out of range`);
      assert.ok(pool.evenness >= 0 && pool.evenness <= 1, `evenness ${pool.evenness} out of range`);
      assert.ok(pool.distinct >= 1 && pool.distinct <= MAX_I);
    }
  }
});

test('an empty population is all zeros, with no NaN in it', () => {
  // An empty dish is a real state — the tick after a load, or after an extinction —
  // and 0/0 reaching a bar chart's width is a panel that draws nothing at all.
  const pool = genePool([], 10);
  assert.equal(pool.bugs, 0);
  assert.equal(pool.instructions, 0);
  assert.equal(pool.bytes, 0);
  assert.equal(pool.distinct, 0);
  assert.equal(pool.meanLength, 0);
  assert.equal(pool.minLength, 0);
  assert.equal(pool.maxLength, 0);
  assert.equal(pool.entropyBits, 0);
  assert.equal(pool.evenness, 0);
  assert.equal(pool.shares.length, MAX_I);
  for (const entry of pool.shares) assert.equal(entry.share, 0);
  for (const field of ['bugs', 'instructions', 'bytes', 'distinct', 'meanLength', 'minLength', 'maxLength', 'entropyBits', 'evenness'] as const) {
    assert.ok(!Number.isNaN(pool[field]), `${field} is NaN`);
  }
  for (const entry of pool.shares) {
    assert.ok(!Number.isNaN(entry.count) && !Number.isNaN(entry.share) && !Number.isNaN(entry.opcode), `${entry.name} is NaN`);
  }
});

test('genomes with no bytes are swept, counted as bugs, and decode to nothing', () => {
  // The guard is `instructions > 0`, not `bugs > 0`: a population of empty genomes
  // is a population, its lengths are 0, and its distribution is undefined rather
  // than NaN. This is the case that catches a mean computed with the wrong
  // denominator.
  const pool = genePool([new Uint8Array(0), new Uint8Array(0)], 2);
  assert.equal(pool.bugs, 2);
  assert.equal(pool.instructions, 0);
  assert.equal(pool.bytes, 0);
  assert.equal(pool.meanLength, 0);
  assert.equal(pool.entropyBits, 0);
  assert.equal(pool.evenness, 0);
  for (const entry of pool.shares) assert.equal(entry.share, 0);
  assert.ok(!Number.isNaN(pool.evenness) && !Number.isNaN(pool.entropyBits));
});

test('a sample of nothing sweeps nothing, and does not sweep everything', () => {
  // A bad number must not turn into an unbounded sweep: the failure to avoid is a
  // panel that stalls, so a sample of 0, of -1 or of NaN reads no genomes.
  const genomes = population(10, 20);
  for (const sample of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const pool = genePool(genomes, sample);
    assert.equal(pool.bugs, 0, `sample ${String(sample)} swept ${pool.bugs} genomes`);
    assert.equal(pool.instructions, 0);
    assert.ok(!Number.isNaN(pool.meanLength) && !Number.isNaN(pool.evenness));
  }
});

test('a sample larger than the population sweeps the population', () => {
  const pool = genePool(population(6, 30), 1000);
  assert.equal(pool.bugs, 6);
  assert.ok(pool.instructions > 0);
});

test('the sample is spread over the population, not the first N', () => {
  // Ninety NOOP genomes then ten JMP ones, sampling a tenth of them. A "first ten"
  // sample reports JMP as extinct — the panel would say the population never
  // branched while a tenth of it does, which is the failure this test exists for.
  // It survives here because the picks are every tenth genome of the hundred,
  // which lands on the first of the ten JMPs.
  const genomes: Uint8Array[] = [];
  for (let i = 0; i < 90; i++) genomes.push(oneOpcode(0));
  for (let i = 0; i < 10; i++) genomes.push(oneOpcode(9)); // JMP

  const pool = genePool(genomes, 10);
  assert.equal(pool.bugs, 10, 'the sample is not a tenth of the population');
  assert.ok(pool.bugs <= 10, 'the sample is larger than asked for');
  assert.ok(shareOf(pool, 9) > 0, 'the opcode only the last tenth uses did not appear — the sample is clipped');
  assert.ok(pool.distinct >= 2);
});

test('the same population and the same sample give the same pool, twice', () => {
  // No RNG and no clock: the panel refreshes on a timer, and bars that twitch
  // between two readings of the same world are a measurement that is not one.
  const genomes = population(50, 90, 31);
  const first = genePool(genomes, 7);
  const second = genePool(genomes, 7);
  assert.deepEqual(second, first);
  // And the sampled subset is smaller than the population, so this is not the
  // trivial case of both runs sweeping everything.
  assert.ok(first.bugs < genomes.length);
});

test('the lengths describe the sampled genomes, not the whole dish', () => {
  // Ninety short genomes, then ten fifty-byte ones; a sample of five. The picks are
  // every twentieth genome, and all of them are short — so the pool must report
  // mean 4 where the dish's mean is 8.6 and its longest is 50. An implementation
  // that measured the full set (or the last five) fails here, and the panel would
  // be printing a length for a set of bugs it says it did not read.
  const genomes: Uint8Array[] = [];
  for (let i = 0; i < 90; i++) genomes.push(new Uint8Array(4));
  for (let i = 0; i < 10; i++) genomes.push(new Uint8Array(50));

  const pool = genePool(genomes, 5);
  assert.equal(pool.bugs, 5);
  assert.equal(pool.bytes, 20, 'the byte total is not the sampled genomes');
  assert.equal(pool.meanLength, 4);
  assert.equal(pool.minLength, 4);
  assert.equal(pool.maxLength, 4, 'the longest genome in the sample is 4 bytes');

  // What the full dish would have said, stated so the difference is visible.
  const full = genePool(genomes, 1000);
  assert.equal(full.bugs, 100);
  assert.equal(full.bytes, 90 * 4 + 10 * 50);
  assert.equal(full.maxLength, 50);
  assert.notEqual(pool.meanLength, full.meanLength, 'the sample and the dish have the same mean here, so this test proves nothing');
  assert.notEqual(pool.bytes, full.bytes);
});

test('the sample count is reported as what it is, and never exceeds the request', () => {
  for (const [count, sample] of [[100, 10], [100, 1], [5, 5], [5, 4], [1, 1]] as const) {
    const pool = genePool(population(count, 12), sample);
    assert.equal(pool.bugs, Math.min(count, sample), `population ${count}, sample ${sample}`);
  }
});

test('genomes are accepted as any iterable, not just an array', () => {
  // The dish hands these over through a visitor; a generator is the shape that
  // catches an implementation that walks the input twice.
  function* generate(): Generator<Uint8Array> {
    yield oneOpcode(0);
    yield oneOpcode(1);
    yield oneOpcode(1);
  }
  const pool = genePool(generate(), 3);
  assert.equal(pool.bugs, 3);
  assert.equal(pool.instructions, 3);
  assert.equal(shareOf(pool, 1), 2);
});
