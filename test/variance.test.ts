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
  assert.equal(result.fixedWithinGenome, 4, 'every position is inside a 4-byte genome');
  assert.equal(result.longestGenome, 4);
  assert.equal(result.widestSpread, 0);
});

test('positions past the longest genome are not counted as conservation', () => {
  // Two bugs, one 4 bytes and one 6, measured over 8 positions. They agree on 0..3
  // (all fixed), disagree at 4 and 5 (one has a byte, the other the sentinel), and
  // positions 6 and 7 are past the end of both -- so they read 0 spread without
  // anything having been conserved. Only 0..3 are genes the population actually has.
  const result = geneSpread([bytes(1, 2, 3, 4), bytes(1, 2, 3, 4, 5, 6)], 8);

  assert.deepEqual([...result.spread], [0, 0, 0, 0, 0.5, 0.5, 0, 0]);
  assert.equal(result.longestGenome, 6);
  assert.equal(result.fixedPositions, 6, 'six positions read 0 spread, tail included');
  assert.equal(result.fixedWithinGenome, 4, 'only the four genes both bugs hold are conserved');
  assert.equal(result.widestPosition, 4, 'the sentinel boundary is where disagreement starts');
});

test('an empty population has no genome to be fixed within', () => {
  const result = geneSpread([], 4);

  assert.equal(result.population, 0);
  assert.equal(result.longestGenome, 0);
  assert.equal(result.fixedPositions, 4, 'every position still reads 0, as upstream ends up doing');
  assert.equal(result.fixedWithinGenome, 0);
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

test('the two counts differ by exactly the positions no genome reaches', () => {
  // The shape the readout got wrong. `fixedPositions` counts every position at
  // zero spread, and the sentinel above means that includes the tail past the
  // longest genome; `fixedWithinGenome` excludes it. So their difference is not
  // free -- it is exactly maxData minus the longest genome, and asserting that
  // catches the tail being counted as conservation on a real world rather than
  // on a hand-built array, which is where the defect shipped from.
  //
  // Measured on real runs, 20k ticks, seed 19 at three mutation rates:
  //   378 - 4 = 374 = 8192 - 7818;  24 - 0 = 24 = 8192 - 8168;
  //   175 - 0 = 175 = 8192 - 8017.
  for (const ticks of [300, 800]) {
    const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(2024));
    for (let i = 0; i < ticks; i++) dish.step();

    const genomes: Uint8Array[] = [];
    dish.forEachBug((bug) => genomes.push(bug.dna.data));
    const result = geneSpread(genomes, DEFAULT_PARAMS.maxData);

    assert.ok(result.longestGenome < DEFAULT_PARAMS.maxData,
      `tick ${ticks}: the fixture needs a genome shorter than maxData, or the tail is empty`);
    assert.equal(
      result.fixedPositions - result.fixedWithinGenome,
      DEFAULT_PARAMS.maxData - result.longestGenome,
      `tick ${ticks}: fixedPositions must exceed fixedWithinGenome by exactly the unreached tail`,
    );
    assert.ok(result.fixedWithinGenome <= result.fixedPositions,
      'and the honest count can never exceed the inclusive one');
  }
});
