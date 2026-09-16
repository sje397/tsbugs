/**
 * The genome, pinned against dna.cpp.
 *
 * Mutation is where a port most easily diverges without anyone noticing: a
 * shifted draw, an inclusive bound where the original was exclusive, or a chunk
 * operation that copies when it should alias. The tests below therefore drive
 * each branch with a scripted draw source rather than hoping a seeded sequence
 * happens to land in it — and an unexpected extra draw is a failure, not a
 * silent shift.
 *
 * Expected values are derived from dna.cpp:31-50 and :104-145, not from the port.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Bug } from '../src/sim/bug.js';
import { CROSSOVER_VAL, DEFAULT_MUTATION_TABLE, Dna } from '../src/sim/dna.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { RAND_MAX, Rng, type RandomSource } from '../src/sim/rng.js';

/** The real genome bounds, for the sustained-mutation test. */
const MAX_SIZE = 8192;
const MIN_SIZE = 4096;

/**
 * Bounds for the single-branch tests, chosen so every chunk is non-empty. With
 * the real bounds a six-byte genome is already shorter than minSize, so
 * removeChunk returns on its guard and the branch is unreachable.
 */
const BAND_MAX = 64;
const BAND_MIN = 1;

/**
 * A draw source whose every value comes from the test. Running out is an error
 * rather than a wrap-around, so a branch that draws more than the test expects
 * fails here instead of quietly shifting the rest of the sequence.
 */
class ScriptedRng implements RandomSource {
  private readonly queue: number[];

  constructor(values: number[]) {
    this.queue = [...values];
  }

  next(): number {
    const value = this.queue.shift();
    if (value === undefined) {
      throw new Error('scripted source exhausted: the code drew more than the test expected');
    }
    return value;
  }

  int(n: number): number {
    return this.next() % n;
  }

  float(): number {
    return this.next() / RAND_MAX;
  }
}

/** A raw `next()` value whose `float()` lands at `fraction`. */
function at(fraction: number): number {
  return Math.round(fraction * RAND_MAX);
}

function dnaOf(bytes: number[], mutation: number, draws: number[]): Dna {
  return new Dna(new Uint8Array(bytes), mutation, new ScriptedRng(draws));
}

function mutationOf(bytes: number[], draws: number[]): number[] {
  const dna = dnaOf(bytes, 1, draws);
  dna.mutate(BAND_MAX, BAND_MIN);
  return [...dna.data];
}

function blended(mum: number[], dad: number[], combo: number): number[] {
  const child = dnaOf([], 0, [combo, 0]);
  child.blend(dnaOf(mum, 0, []), dnaOf(dad, 0, []), MAX_SIZE, MIN_SIZE);
  return [...child.data];
}

test('mutation is an exclusive bound: a draw of exactly 1.0 does not mutate', () => {
  // Each scripted source holds exactly one draw, so a second would throw.
  const capped = dnaOf([1, 2, 3], 1, [RAND_MAX]);
  capped.mutate(BAND_MAX, BAND_MIN);
  assert.deepEqual([...capped.data], [1, 2, 3]);

  const inert = dnaOf([1, 2, 3], 0, [RAND_MAX]);
  inert.mutate(BAND_MAX, BAND_MIN);
  assert.deepEqual([...inert.data], [1, 2, 3]);
});

/**
 * A whole draw sequence for one mutation: the gate draw that decides whether a
 * mutation happens at all, then the draw that picks the band, then whatever
 * that band consumes.
 */
function bandDraws(band: number, ...rest: number[]): number[] {
  return [at(0.5), at(band), ...rest];
}

test('each mutation band is reached by its own slice of the draw', () => {
  // addChunk: two bytes from position 0, inserted at position 1.
  assert.deepEqual(mutationOf([10, 20, 30, 40], bandDraws(0.005, 2, 0, 1)), [10, 10, 20, 20, 30, 40]);

  // removeChunk: one byte removed at position 1.
  assert.deepEqual(mutationOf([10, 20, 30, 40, 50, 60], bandDraws(0.015, 1, 1)), [10, 30, 40, 50, 60]);

  // moveChunk: one byte from position 0 reinserted at position 2.
  assert.deepEqual(mutationOf([10, 20, 30, 40], bandDraws(0.05, 1, 0, 2)), [20, 30, 10, 40]);

  // reverseSection: positions 0..2 reversed.
  assert.deepEqual(mutationOf([10, 20, 30, 40], bandDraws(0.125, 3, 0)), [30, 20, 10, 40]);

  // swapBit: bit 3 of byte 0 flipped.
  assert.deepEqual(mutationOf([0x00, 0xff], bandDraws(0.5, 0, 3)), [0x08, 0xff]);

  // randomByte: byte 1 set to 254, the highest this path can write.
  assert.deepEqual(mutationOf([0x00, 0xff], bandDraws(0.9, 1, 254)), [0x00, 0xfe]);

  // and a draw of 255 wraps to 0 rather than being written, because the index
  // is `% 0xff`. 255 is therefore never produced by this path.
  assert.deepEqual(mutationOf([0x00, 0xff], bandDraws(0.9, 1, 255)), [0x00, 0x00]);
});

test('the mutation table leaves no draw for addCrossover', () => {
  const table = DEFAULT_MUTATION_TABLE;
  const spent = table.addChunk + table.removeChunk + table.moveChunk
    + table.reverseSection + table.swapBit + table.randomByte;

  // addCrossover is 0.00f upstream, and the six bands above already cover the
  // whole of [0, 1), so reaching it would take r going negative in floating
  // point. It stays in the table as a faithful copy, and stays dead.
  assert.equal(table.addCrossover, 0);
  assert.ok(spent >= 1, `the six bands must cover the draw, but they sum to ${spent}`);
});

test('blend of two identical parents reproduces the parent', () => {
  const source = [0x12, 0x34];
  const child = dnaOf([], 0, [0, 0]);
  child.blend(dnaOf(source, 0, []), dnaOf(source, 0, []), MAX_SIZE, MIN_SIZE);
  assert.deepEqual([...child.data], source);
});

test('a shared crossover marker swaps parents, a lone one does not', () => {
  const mum = [0xab, CROSSOVER_VAL, 0xff];

  // Both parents carry the marker at index 1, so the nibble sources swap there.
  const shared = [0xcd, CROSSOVER_VAL, 0x12];
  assert.deepEqual(
    blended(mum, shared, 0),
    [0xad, 0x00, 0x1f],
    'with combo 0 byte 0 takes dad low + mum high, then the parents swap',
  );
  assert.deepEqual(
    blended(mum, shared, 1),
    [0xcb, 0x00, 0xf2],
    'with combo 1 byte 0 takes mum low + dad high, then the parents swap',
  );

  // Only mum carries the marker, so the parents never swap.
  assert.deepEqual(blended(mum, [0xcd, 0x11, 0x12], 0), [0xad, 0x01, 0xf2]);
});

test('blend is bounded by the shorter parent and copies the longer tail', () => {
  const long = [0x11, 0x22, 0x33, 0x44];
  const short = [0xaa, 0xbb];

  // The loop runs over the *current* parent, so combo 0 here walks the shorter one.
  assert.deepEqual(blended(long, short, 0), [0x1a, 0x2b]);
  // And combo 1 walks the longer one, copying its tail unblended.
  assert.deepEqual(blended(long, short, 1), [0xa1, 0xb2, 0x33, 0x44]);
});

test('genome length stays within [minData, maxData) under sustained mutation', () => {
  const dna = new Dna(new Uint8Array(MIN_SIZE).fill(0x5a), 1, new Rng(2024));
  let smallest = dna.size;
  let largest = dna.size;

  for (let i = 0; i < 20_000; i++) {
    dna.mutate(MAX_SIZE, MIN_SIZE);
    if (dna.size < smallest) smallest = dna.size;
    if (dna.size > largest) largest = dna.size;
  }

  assert.ok(smallest >= MIN_SIZE, `shrank to ${smallest}`);
  assert.ok(largest < MAX_SIZE, `grew to ${largest}, which is not below maxSize`);
  // Both directions must actually have been exercised, or the bounds prove nothing.
  assert.ok(largest > MIN_SIZE, 'the fixture never grew');
  assert.ok(smallest < MAX_SIZE, 'the fixture never shrank');
});

test('the same seed mutates the same way', () => {
  const once = (seed: number): number[] => {
    const dna = new Dna(new Uint8Array(MIN_SIZE).fill(0x5a), 1, new Rng(seed));
    for (let i = 0; i < 500; i++) dna.mutate(MAX_SIZE, MIN_SIZE);
    return [...dna.data];
  };

  assert.deepEqual(once(4242), once(4242));
  assert.notDeepEqual(once(4242), once(4243));
});

test('genesis draws genes from % 256, so 255 is reachable there', () => {
  // The randomByte mutation path is % 0xff and cannot reach 255, but genesis is
  // % 256 and swapBit can accumulate to it. A port that "tidied" either modulus
  // would change the distribution of gene values.
  let genesis255 = false;
  for (let seed = 0; seed < 40 && !genesis255; seed++) {
    for (const byte of Bug.createRandom(DEFAULT_PARAMS, new Rng(seed)).dna.data) {
      if (byte === 255) {
        genesis255 = true;
        break;
      }
    }
  }
  assert.ok(genesis255, '40 genomes of ~4096 genes each must hit 255 somewhere');
});
