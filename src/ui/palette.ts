/**
 * The dish's colour table, and how a colour code becomes CSS.
 *
 * ONE TABLE, TWO SURFACES. `blit.ts` writes packed RGBA words into the canvas;
 * the legend, the hover probe and the sense grid write CSS strings. Those two
 * paths have to agree, and they did not: the legend handed a colour CODE (254,
 * 255) to the helper that packs a packed word into CSS, so it drew poison and an
 * energy cell as `rgb(254, 0, 0)` and `rgb(255, 0, 0)` — plain red, twice — while
 * the dish drew them magenta and blue. Both wrong swatches looked plausible,
 * which is what a packing error looks like when its input is a single small
 * number: nothing is out of range and nothing throws.
 *
 * So the table lives here rather than in the page, and `cssFor` takes the CODE and
 * indexes the table itself. The page no longer has the packed word in its
 * vocabulary at all, which is what makes the mistake unrepresentable rather than
 * merely fixed: there is no argument to pass in the wrong order.
 *
 * `test/palette.test.ts` reads the pixels back out of a blit and compares them
 * with the CSS for the same code, so "a colour means one thing on both" is
 * asserted against the renderer instead of stated in a comment.
 *
 * petriwidget.cpp:10-29, exactly: 0 black, 1..252 a red -> yellow -> green ramp
 * (the same ramp the bug colours use), 253 cyan, 254 magenta (poison), 255 blue
 * (energy). Cyan is reserved and unused by any view mode, which is upstream's
 * state too, so it is kept rather than tidied away.
 */

import { BKG_COLOR, ENERGY_COLOR, MAX_BUG_COLOR, POISON_COLOR } from '../sim/params.js';

/** Pack r,g,b into the little-endian word `ImageData` reads as RGBA. */
const rgba = (r: number, g: number, b: number): number => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** The palette the blit writes into pixels. Indexed by colour code, 0..255. */
export const PALETTE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 1; i <= MAX_BUG_COLOR; i++) {
    const f = (i - 1) / 252;
    const r = f <= 0.5 ? 0xff : Math.trunc(0xff * (1 - f) * 2);
    const g = f <= 0.5 ? Math.trunc(0xff * f * 2) : 0xff;
    table[i] = rgba(r, g, 0);
  }
  table[BKG_COLOR] = rgba(0, 0, 0);
  table[253] = rgba(0, 255, 255);
  table[POISON_COLOR] = rgba(255, 0, 255);
  table[ENERGY_COLOR] = rgba(0, 0, 255);
  return table;
})();

/**
 * A colour code as CSS, for the surfaces that are not the canvas.
 *
 * Takes the CODE, not the packed word — that is the whole point of this module.
 * Anything outside 0..255 is a caller error rather than a colour, so it says so
 * instead of rendering transparent.
 */
export function cssFor(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code >= PALETTE.length) {
    throw new Error(`colour code ${code} is not a palette index (0..${PALETTE.length - 1})`);
  }
  const packed = PALETTE[code];
  return `rgb(${packed & 0xff}, ${(packed >>> 8) & 0xff}, ${(packed >>> 16) & 0xff})`;
}

/**
 * What a colour code means, in words.
 *
 * One function because two surfaces show it — the world's hovertip and the bug
 * panel's sense grid — and they must not be able to disagree about whether a
 * magenta cell is a bug or a poison pile. 253 is named rather than omitted: it is
 * reserved and unreachable, and saying so is cheaper than a reader wondering why
 * the 254 threshold is worth stating.
 */
export function colourName(value: number): string {
  return value === BKG_COLOR ? 'empty'
    : value === POISON_COLOR ? 'poison'
      : value === ENERGY_COLOR ? 'energy cell'
        : value === 253 ? 'cyan (reserved)'
          : `bug colour ${value}`;
}

/**
 * The text colour to use on a cell filled with this code.
 *
 * A sense cell is drawn on a bright fill, so its text has to contrast with the
 * fill rather than with the page. The blue of an energy cell is the only dark one
 * — dark text on it measures 2.2:1 — so it is the only one that goes light.
 */
export function onColour(value: number): string {
  return value === ENERGY_COLOR ? '#e8eef4' : '#0a0c0f';
}
