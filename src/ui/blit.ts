/**
 * The dish's pixels: `viewCol` (one palette index per cell) to an RGBA buffer.
 *
 * THIS IS WHERE THE WORLD USED TO BE DRAWN TRANSPOSED. The obvious loop —
 *
 *     for (let i = 0; i < viewCol.length; i++) out[i] = palette[viewCol[i]];
 *
 * — is wrong, and looks right. A cell's index is `x * height + y` (column-major,
 * petri_dish.cpp:217), while a pixel buffer is row-major, so writing cell `i` to
 * pixel `i` puts cell (108,126) at pixel column 126 row 108. Every bug therefore
 * appeared mirrored across the diagonal, and because the click mapping is honest
 * (`x = px`, `y = py`) the reader selected a bug that was drawn somewhere else —
 * the ring landed on the click and the panel described a creature the pointer was
 * not on. A petri dish is a symmetric field of noise, so the mirror was invisible;
 * measured on a 240x240 world at seed 2024, tick 10: 99 of 99 occupied cells drawn
 * at their transposed position.
 *
 * The original C++ had this right and the port lost it in the blit: upstream
 * `PetriWidget::update_pixel(x, y, col)` called `image.setPixel(x, y, col)`, so the
 * expansion from hash to (x, y) happened in the drawing code. That expansion is
 * what lives here now, in one place, asserted by test, so a rewrite of the render
 * loop cannot quietly reintroduce the transpose.
 *
 * The palette is passed in rather than imported: the colours belong to the page
 * (they are the same table the legend shows), and this module is about placement.
 */

/** Bytes per pixel in the output, as a name, so the length check reads as itself. */
export const RGBA = 4;

/**
 * Write `viewCol` into `out`, at the pixel each cell's coordinates actually name.
 *
 * `out` is a `Uint32Array` VIEW over an RGBA `ImageData` buffer (one packed
 * little-endian word per pixel), which is why the assignment is a single word.
 * Lengths are checked rather than assumed: a short buffer would silently drop the
 * right-hand columns, and the failure would look like a world with no bugs there.
 */
export function blitViewCol(
  viewCol: Uint8Array,
  width: number,
  height: number,
  out: Uint32Array,
  palette: readonly number[],
): void {
  if (viewCol.length !== width * height) {
    throw new Error(`viewCol is ${viewCol.length} cells, but ${width}x${height} is ${width * height}`);
  }
  if (out.length !== width * height) {
    throw new Error(`output holds ${out.length} pixels, but ${width}x${height} is ${width * height}`);
  }
  if (palette.length < 256) {
    throw new Error(`palette has ${palette.length} entries; viewCol values are 0..255`);
  }

  for (let hash = 0; hash < viewCol.length; hash++) {
    const x = Math.trunc(hash / height);
    const y = hash % height;
    out[y * width + x] = palette[viewCol[hash]];
  }
}

/**
 * The pixel a cell occupies — `y * width + x`, spelled out because it is the
 * half of the mapping the transpose bug got wrong, and the marker needs it too.
 */
export function pixelIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

/** The cell a pixel belongs to. The inverse of `pixelIndex`, for hit tests. */
export function cellOfPixel(index: number, width: number): { x: number; y: number } {
  return { x: index % width, y: Math.trunc(index / width) };
}
