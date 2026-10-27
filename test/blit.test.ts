/**
 * The dish blit, and the transpose that was in it.
 *
 * The failing case is the shape a dish has: every cell lit with a distinct
 * palette index, so any cell drawn in the wrong place is a wrong value rather
 * than a coincidence. Asserting that "a bug appears somewhere" would have passed
 * for months; asserting that the cell at (x, y) is the pixel at (x, y) is the
 * assertion that fails on the code this replaced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blitViewCol, cellOfPixel, pixelIndex, RGBA } from '../src/ui/blit.js';

/** An identity palette: index i paints the word i, so a misplaced cell is visible. */
const identity = (): number[] => Array.from({ length: 256 }, (_, i) => i * 0x01010101);

test('a cell lands at its own column and row, not its mirror', () => {
  const width = 7;
  const height = 5;
  const viewCol = new Uint8Array(width * height);
  const out = new Uint32Array(width * height);

  // One cell at a time: a single wrong placement cannot be hidden by another.
  for (let hash = 0; hash < viewCol.length; hash++) {
    const x = Math.trunc(hash / height);
    const y = hash % height;

    viewCol.fill(0);
    viewCol[hash] = 9;
    out.fill(0);
    blitViewCol(viewCol, width, height, out, identity());

    const lit = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== 0) lit.push(i);
    assert.deepEqual(lit, [y * width + x], `cell (${x},${y}) did not land on its own pixel`);

  }
});

test('in a square world the transposed index is always a different pixel', () => {
  // The clause that makes the sweep above able to SEE the transpose: the old blit
  // wrote out[hash], and in a w x w world hash == y*w + x only when x == y. So every
  // off-diagonal cell is a witness. In a 7x5 world it is not true: cell (3,2) has
  // hash 17 and true pixel 2*7+3 = 17, the same number, which is arithmetic and not
  // a bug -- which is why the placement sweep above asserts placement only.
  const width = 5;
  const height = 5;
  let witnesses = 0;
  for (let hash = 0; hash < width * height; hash++) {
    const x = Math.trunc(hash / height);
    const y = hash % height;
    if (x === y) {
      assert.equal(y * width + x, hash, 'the diagonal is where the two mappings meet');
      continue;
    }
    assert.notEqual(y * width + x, hash, `cell (${x},${y}) would be drawn on the diagonal`);
    witnesses++;
  }
  assert.equal(witnesses, width * height - width, 'every off-diagonal cell is a witness');
});

test('every cell of a populated world lands on its own pixel', () => {
  // The measurement that found the bug: 240x240 at seed 2024 drew 0 of 99
  // occupied cells at their own position. A sweep is what makes it 99 of 99.
  const width = 40;
  const height = 40;
  const viewCol = new Uint8Array(width * height);
  for (let hash = 0; hash < viewCol.length; hash++) viewCol[hash] = (hash % 255) + 1;

  const out = new Uint32Array(width * height);
  blitViewCol(viewCol, width, height, out, identity());

  let drawnAtOwnCell = 0;
  for (let hash = 0; hash < viewCol.length; hash++) {
    const x = Math.trunc(hash / height);
    const y = hash % height;
    if (out[y * width + x] === identity()[viewCol[hash]]) drawnAtOwnCell++;
  }
  assert.equal(drawnAtOwnCell, width * height);
});

test('a non-square world is not even a mirror when transposed', () => {
  // The transpose of a square world is a reflection, which reads as plausible.
  // At 5x3 the same mistake scatters cells outright, so this case is worth
  // pinning: hash / height is still the x, and the pixel row is still the y.
  const width = 5;
  const height = 3;
  const viewCol = new Uint8Array(width * height).fill(0);
  viewCol[4 * height + 1] = 7;      // cell x=4, y=1 — the far right, middle row

  const out = new Uint32Array(width * height);
  blitViewCol(viewCol, width, height, out, identity());

  assert.equal(out[pixelIndex(4, 1, width)], identity()[7]);
  assert.equal(out.filter((v) => v !== 0).length, 1);
});

test('the inverse mapping round-trips', () => {
  const width = 9;
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixelIndex(x, y, width);
      assert.deepEqual(cellOfPixel(index, width), { x, y });
    }
  }
});

test('a wrong-sized buffer is refused rather than silently truncated', () => {
  // A short output drops the right-hand columns, which looks like a world with
  // no bugs there instead of a bug in the renderer.
  const palette = identity();
  assert.throws(() => blitViewCol(new Uint8Array(6), 3, 2, new Uint32Array(5), palette), /output holds 5 pixels/);
  assert.throws(() => blitViewCol(new Uint8Array(5), 3, 2, new Uint32Array(6), palette), /viewCol is 5 cells/);
  assert.throws(() => blitViewCol(new Uint8Array(6), 3, 2, new Uint32Array(6), [0, 1]), /palette has 2 entries/);
});

test('the buffer is the packed word the browser expects', () => {
  // A Uint32Array over ImageData.data is little-endian per pixel; a palette
  // entry is written as one word, so nothing de-interleaves it by accident.
  const viewCol = new Uint8Array([3]);
  const out = new Uint32Array(1);
  // A full 256-entry palette, because that is the contract: viewCol values are
  // bytes, so a 4-entry palette is refused (the test below pins that refusal)
  // rather than clamped to something that would look like a colour bug.
  const palette = identity();
  palette[3] = 0xff0000ff;
  blitViewCol(viewCol, 1, 1, out, palette);
  assert.equal(out[0], 0xff0000ff);
  assert.equal(RGBA, 4);
});
