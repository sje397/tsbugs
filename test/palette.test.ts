/**
 * The colour table, and the two surfaces that must agree about it.
 *
 * The bug this file exists for: the legend rendered poison and an energy cell as
 * `rgb(254, 0, 0)` and `rgb(255, 0, 0)` — two nearly identical reds — while the
 * dish drew them magenta and blue. The page was calling the CSS helper with a
 * colour CODE where it expected a packed word, so the table was never indexed at
 * all and the code was painted as if it were a colour. Nothing threw, nothing was
 * out of range, and the swatches looked like a legend.
 *
 * So the assertions are:
 *   - the sentinels, by name, because those are the two the legend got wrong;
 *   - PARITY with the renderer: blit one cell, read the word back, and require the
 *     CSS for the same code to be the same colour. That is the invariant, checked
 *     against the code that draws rather than against a copied expectation;
 *   - distinctness, because a table where two codes render the same is a table
 *     that cannot show the difference — which is the shape the bug produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blitViewCol } from '../src/ui/blit.js';
import { PALETTE, colourName, cssFor, onColour } from '../src/ui/palette.js';
import { BKG_COLOR, ENERGY_COLOR, MAX_BUG_COLOR, POISON_COLOR } from '../src/sim/params.js';

/** Every code a view mode can put in `viewCol`: the ramp, the two sentinels, empty. */
const LIVE_CODES = [BKG_COLOR, 1, 2, 63, 126, 127, 188, MAX_BUG_COLOR - 1, MAX_BUG_COLOR, POISON_COLOR, ENERGY_COLOR];

/** `rgb(r, g, b)` back to numbers, so a CSS string can be compared with a pixel. */
function parseCss(css: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  assert.notEqual(m, null, `${css} is not an rgb() triple`);
  const [, r, g, b] = m as RegExpExecArray;
  return [Number(r), Number(g), Number(b)];
}

test('the two sentinels render as the colours the dish draws them', () => {
  // Written out rather than derived, because these two strings ARE the fix: the
  // legend showed red for both, and a derivation from the table would have agreed
  // with any table.
  assert.equal(cssFor(POISON_COLOR), 'rgb(255, 0, 255)', 'poison is magenta');
  assert.equal(cssFor(ENERGY_COLOR), 'rgb(0, 0, 255)', 'an energy cell is blue');
  assert.equal(cssFor(BKG_COLOR), 'rgb(0, 0, 0)', 'empty is black');
  assert.notEqual(cssFor(POISON_COLOR), cssFor(ENERGY_COLOR), 'poison and energy must not look alike');
});

test('CSS and the blit agree, pixel for pixel', () => {
  // The renderer and the legend are the two paths this module exists to keep in
  // step. One cell at a time through the real blit, whose transpose test already
  // pins the placement — this is about the colour, not the position.
  for (const code of LIVE_CODES) {
    const out = new Uint32Array(1);
    blitViewCol(Uint8Array.from([code]), 1, 1, out, PALETTE);
    const word = out[0];
    const pixel: [number, number, number] = [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff];
    assert.deepEqual(parseCss(cssFor(code)), pixel, `code ${code} differs between the canvas and CSS`);
  }
});

test('the ramp runs red to yellow to green, and changes at every step', () => {
  const first = parseCss(cssFor(1));
  const mid = parseCss(cssFor(126));
  const last = parseCss(cssFor(MAX_BUG_COLOR));

  assert.deepEqual(first, [255, 0, 0], 'code 1 is the red end');
  // Green is 2, not 0, and that is the source's arithmetic rather than a mistake:
  // f runs from 0 at code 1 to 251/252 at code 252, so the red channel of the last
  // step is trunc(255 * (1 - 251/252) * 2) = 2. Pinned exactly, because "close
  // enough to green" is the kind of tolerance that would also accept a wrong ramp.
  assert.deepEqual(last, [2, 255, 0], 'the last bug colour is the green end');
  assert.ok(mid[0] > 200 && mid[1] > 200 && mid[2] === 0, `the middle of the ramp is yellow, not ${mid}`);

  // Adjacent codes must differ: a ramp with a flat spot would render two different
  // bugs as one colour, on the canvas as well as in the legend.
  for (let code = 2; code <= MAX_BUG_COLOR; code++) {
    assert.notEqual(
      PALETTE[code], PALETTE[code - 1],
      `codes ${code - 1} and ${code} are the same packed colour, so the ramp has a flat spot`,
    );
  }
});

test('a code outside the table is refused rather than rendered', () => {
  // A silent transparent or clamped swatch is how a packing error hides. The page
  // cannot reach these (it never handles a packed word), so reaching one is a bug
  // in the caller and is worth a throw.
  for (const bad of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cssFor(bad), /not a palette index/, `${bad} should be refused`);
  }
});

test('the table is large enough for every byte a view mode can hold', () => {
  // blitViewCol refuses a palette under 256 entries; this says the table it is
  // handed is that size, rather than the blit being the only thing that knows.
  assert.equal(PALETTE.length, 256);
});

test('the names distinguish poison, energy and a bug from each other', () => {
  assert.equal(colourName(BKG_COLOR), 'empty');
  assert.equal(colourName(POISON_COLOR), 'poison');
  assert.equal(colourName(ENERGY_COLOR), 'energy cell');
  assert.equal(colourName(253), 'cyan (reserved)');
  assert.equal(colourName(7), 'bug colour 7');

  // The three cell kinds a reader has to tell apart in the sense grid.
  const names = new Set([colourName(7), colourName(POISON_COLOR), colourName(ENERGY_COLOR)]);
  assert.equal(names.size, 3);
});

test('only the dark cell gets light text', () => {
  // The sense grid draws text ON the cell fill. Blue is the only fill dark enough
  // to need it; measuring 2.2:1 for dark text is what put this here.
  assert.equal(onColour(ENERGY_COLOR), '#e8eef4');
  for (const code of [BKG_COLOR, 1, 126, MAX_BUG_COLOR, POISON_COLOR, 253]) {
    assert.equal(onColour(code), '#0a0c0f', `code ${code} is bright enough for dark text`);
  }
});
