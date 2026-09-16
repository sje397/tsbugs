/**
 * The gene histogram's arithmetic.
 *
 * Upstream computes this inside a paint event and draws it as bars, so nothing
 * could check it and nothing did: a wrong denominator or a min instead of a mode
 * would have looked like a differently-shaped graph and never been noticed. Here
 * it is a function over genomes, so the properties can be stated.
 *
 * The two that matter: the fraction is measured against the *modal* byte, not the
 * minority or a mean (test 3 pins a fixture where all three differ), and a gene
 * position past the end of a genome is a bucket of its own, which is upstream's
 * `d = 256` sentinel and is what makes a shortening genome visible as variance
 * rather than as agreement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import { geneSpread } from '../src/sim/variance.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

test('a population that agrees everywhere has zero spread', () => {
  const genome = bytes(1, 2, 3, 4);
  const result = geneSpread([genome, genome, genome], 4);

  assert.equal(result.population, 3);
  assert.deepEqual([...result.spread], [0, 0, 0, 0]);
  assert.equal(result.fixedPositions, 4);
  assert.equal(result.widestSpread, 0);
});

test('one diverging bug moves exactly its own gene', () => {
  const result = geneSpread(
    [bytes(1, 2, 3, 4), bytes(1, 2, 3, 4), bytes(1, 2, 3, 4), bytes(1, 2, 9, 4)],
    4,
  );

  assert.deepEqual([...result.spread], [0, 0, 0.25, 0]);
  assert.equal(result.fixedPositions, 3);
  assert.equal(result.widestPosition, 2);
  assert.equal(result.widestSpread, 0.25);
});

test('the fraction is measured against the modal byte, not a minority', () => {
  // Three of five agree, and the two that differ do not agree with each other:
  // modal fraction 0.6 -> spread 0.4, while the minority fractions are 0.2 each
  // and their mean is also 0.2. Only the mode gives 0.4.
  const result = geneSpread([bytes(7), bytes(7), bytes(7), bytes(9), bytes(11)], 1);

  assert.equal(result.spread[0], 0.4);
});

test('a gene position past the end of a genome is its own bucket', () => {
  // The fourth genome holds a real 0 at gene 2, which is the only reason this
  // fixture can tell the sentinel apart from byte 0: fold "no such gene" into
  // bucket 0 and the three short genomes join the one holding a zero, making the
  // whole population agree and the spread 0 instead of 0.25.
  const result = geneSpread(
    [bytes(1, 2), bytes(1, 2), bytes(1, 2), bytes(1, 2, 0, 4)],
    4,
  );

  assert.equal(result.spread[0], 0, 'everyone holds the same byte here');
  assert.equal(result.spread[1], 0);
  // Three genomes have no gene 2 at all; upstream's sentinel puts those three in a
  // bucket of their own, so the modal bucket is "no such gene" and the genome that
  // does hold a byte is the odd one out: 0.25. A shorter genome therefore reads as
  // the minority rather than as the majority value — upstream's semantics, kept.
  assert.equal(result.spread[2], 0.25);
  assert.equal(result.spread[3], 0.25, 'the same three are short of gene 3 as well');
  assert.equal(result.fixedPositions, 2);
});

test('an empty population reads zero rather than upstream 0/0', () => {
  // Upstream divides by pop, which is 0/0 = NaN, then casts NaN to int. The
  // port states a value instead of inheriting undefined behaviour.
  const result = geneSpread([], 3);

  assert.equal(result.population, 0);
  assert.deepEqual([...result.spread], [0, 0, 0]);
  assert.equal(result.widestSpread, 0);
});

test('agrees with a direct tally of the modal byte, over real DNA', () => {
  const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(2024));
  for (let i = 0; i < 200; i++) dish.step();

  const genomes: Uint8Array[] = [];
  dish.forEachBug((bug) => genomes.push(bug.dna.data));
  assert.ok(genomes.length > 50, 'the fixture needs a population worth summarising');

  const result = geneSpread(genomes, DEFAULT_PARAMS.maxData);

  // Independent path: tally every bucket in a Map and take the largest count,
  // rather than a fixed-size Int32Array and a running mode. It shares only the
  // sentinel convention, which is the point of the test above.
  for (const gene of [0, 1, 137, 4095, DEFAULT_PARAMS.maxData - 1]) {
    const tally = new Map<number, number>();
    for (const genome of genomes) {
      const bucket = gene < genome.length ? genome[gene] : -1;
      tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
    }
    const modal = Math.max(...tally.values());
    assert.equal(
      result.spread[gene],
      (genomes.length - modal) / genomes.length,
      `gene ${gene} (${tally.size} distinct bytes held)`,
    );
  }
});
