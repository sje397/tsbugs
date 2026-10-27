/**
 * Where a cell is on screen, and what a point on screen is over.
 *
 * One function per direction, in one file, because the two directions have to
 * agree and they were previously written twice, in different places, in
 * different units. The bug that motivated this module is in `blit.ts` (the image
 * was transposed); this is the other half of the same class of mistake — the ring
 * drawn at the cell while the cell's pixels were somewhere else — and the reason
 * it is here rather than in the page is that it is arithmetic, and arithmetic can
 * be round-tripped in a test with no browser and no human eye.
 *
 * ## The model
 *
 * `zoom` is **CSS pixels per cell**, an integer. It is not a multiplier over a
 * fitted size: at zoom 3 a cell is three CSS pixels whatever the viewport is
 * doing, which makes "how big is a bug" a property the reader controls rather
 * than a consequence of their window. `fitZoom` supplies the initial value.
 *
 * An integer scale is what keeps the dish crisp: the world is drawn as one
 * `drawImage` from the whole offscreen world into an integer-scaled rectangle, so
 * a cell never straddles a device pixel boundary. `ox`/`oy` are the top-left
 * visible cell and are integers for the same reason — a fractional pan resamples
 * the adjacent cells into each other and a 3-pixel bug turns into a grey smear.
 *
 * When the scaled world is smaller than the viewport it is centred, and `ox` is
 * pinned to 0: panning a world that already fits would only move it off-centre,
 * which reads as the dish drifting for no reason.
 */

export interface WorldSize {
  width: number;
  height: number;
}

/** The canvas's CSS size, which is what pointer coordinates are in. */
export interface Viewport {
  width: number;
  height: number;
}

export interface View {
  /** CSS pixels per cell, integer, between ZOOM_MIN and ZOOM_MAX. */
  zoom: number;
  /** Top-left visible cell. Pinned to 0 on an axis where the world fits. */
  ox: number;
  oy: number;
}

/** A resolved view: the numbers the renderer actually draws with. */
export interface Layout {
  /** CSS pixels per cell, after clamping. */
  cellPx: number;
  /** CSS position of cell (0,0)'s top-left corner. Negative when panned. */
  originX: number;
  originY: number;
  /** Top-left visible cell, after clamping. */
  ox: number;
  oy: number;
  world: WorldSize;
  viewport: Viewport;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 24;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom)));
}

/**
 * The largest integer cell size that shows the whole world, at least 1.
 *
 * Integer and floored, so "fit" never shows a world bigger than the viewport: on
 * a 900 px stage with a 240-cell world this is 3, not 3.75, and the 25 px that
 * leaves over is letterbox rather than a clipped edge column.
 */
export function fitZoom(world: WorldSize, viewport: Viewport): number {
  const fit = Math.min(viewport.width / world.width, viewport.height / world.height);
  return clampZoom(Math.floor(fit));
}

/** How many cells of the world the viewport shows, at most the world itself. */
export function visibleCells(world: WorldSize, viewport: Viewport, zoom: number): { cols: number; rows: number } {
  const cellPx = clampZoom(zoom);
  return {
    cols: Math.min(world.width, Math.ceil(viewport.width / cellPx)),
    rows: Math.min(world.height, Math.ceil(viewport.height / cellPx)),
  };
}

/** The furthest `ox` can go and still have the right-hand edge inside the viewport. */
function maxOffset(worldSpan: number, viewportSpan: number, cellPx: number): number {
  return Math.max(0, worldSpan - Math.ceil(viewportSpan / cellPx));
}

/**
 * Pull a view back inside the world.
 *
 * The lower bound is 0 rather than negative: there is nothing left of cell 0, so
 * a pan that would reveal space before it is a pan that stops. Both axes are
 * independent — a world can be wider than the viewport and shorter than it.
 */
export function clampView(world: WorldSize, viewport: Viewport, view: View): View {
  const zoom = clampZoom(view.zoom);
  const maxX = maxOffset(world.width, viewport.width, zoom);
  const maxY = maxOffset(world.height, viewport.height, zoom);
  return {
    zoom,
    ox: Math.min(maxX, Math.max(0, Math.round(view.ox))),
    oy: Math.min(maxY, Math.max(0, Math.round(view.oy))),
  };
}

/** Resolve a view into the rectangle the renderer draws. */
export function layout(world: WorldSize, viewport: Viewport, view: View): Layout {
  const clamped = clampView(world, viewport, view);
  const cellPx = clamped.zoom;
  const drawnW = world.width * cellPx;
  const drawnH = world.height * cellPx;

  // Centred when it fits, pinned when it does not. `ox` is already 0 in the
  // fitted case (clampView pins it), so the two branches cannot disagree.
  //
  // The `+ 0` is not decoration: `-0 * cellPx` is negative zero, which is numerically
  // 0 but is not `deepEqual` to it, so a pinned axis used to make two identical
  // layouts compare unequal. A layout is arithmetic that callers compare, so it says
  // 0 when it means 0.
  const originX = drawnW <= viewport.width ? (viewport.width - drawnW) / 2 : -clamped.ox * cellPx + 0;
  const originY = drawnH <= viewport.height ? (viewport.height - drawnH) / 2 : -clamped.oy * cellPx + 0;

  return { cellPx, originX, originY, ox: clamped.ox, oy: clamped.oy, world, viewport };
}

/** The cell under a CSS point, or null when the point is outside the world. */
export function cellAt(l: Layout, cssX: number, cssY: number): { x: number; y: number } | null {
  const x = Math.floor((cssX - l.originX) / l.cellPx);
  const y = Math.floor((cssY - l.originY) / l.cellPx);
  if (x < 0 || y < 0 || x >= l.world.width || y >= l.world.height) return null;
  return { x, y };
}

/**
 * The CSS rectangle of one cell. Half-pixel offset is NOT applied here: it is a
 * stroke concern (a 1 px ring centred on a pixel boundary straddles two device
 * pixels and blurs), so the caller adds it and the geometry stays exact.
 */
export function cellRect(l: Layout, x: number, y: number): { left: number; top: number; size: number } {
  return { left: l.originX + x * l.cellPx, top: l.originY + y * l.cellPx, size: l.cellPx };
}

/** The CSS centre of a cell — where a marker's ring belongs, and what a hover names. */
export function cellCentre(l: Layout, x: number, y: number): { x: number; y: number } {
  return { x: l.originX + (x + 0.5) * l.cellPx, y: l.originY + (y + 0.5) * l.cellPx };
}

/** Pan by a CSS-pixel drag. Positive dx moves the world right (reveals left). */
export function panBy(world: WorldSize, viewport: Viewport, view: View, dx: number, dy: number): View {
  const cellPx = clampZoom(view.zoom);
  return clampView(world, viewport, { zoom: cellPx, ox: view.ox - dx / cellPx, oy: view.oy - dy / cellPx });
}

/** Scroll-wheel zoom about a point: sign only, one step per notch, doubling. */
export function zoomStep(world: WorldSize, viewport: Viewport, view: View, direction: number, anchor: { x: number; y: number }): View {
  const cellPx = clampZoom(view.zoom);
  const next = direction > 0 ? Math.min(ZOOM_MAX, cellPx * 2) : Math.max(ZOOM_MIN, Math.floor(cellPx / 2));
  return zoomAt(world, viewport, view, next, anchor);
}

/**
 * Zoom while holding one point still.
 *
 * The point is held to the nearest cell rather than to the pixel, because a
 * fractional origin is a resampled dish; the eye reads "the thing under my
 * pointer stayed put" and does not read the sub-pixel difference. Away from the
 * edges the anchored cell is exactly the one under the pointer afterwards, and
 * `test/worldView.test.ts` asserts that rather than the nearness.
 */
export function zoomAt(
  world: WorldSize,
  viewport: Viewport,
  view: View,
  nextZoom: number,
  anchor: { x: number; y: number },
): View {
  const zoom = clampZoom(nextZoom);
  const before = layout(world, viewport, view);
  const target = cellAt(before, anchor.x, anchor.y);

  if (target === null) {
    // Outside the world: there is no cell to hold, so zoom about the centre.
    return clampView(world, viewport, {
      zoom,
      ox: view.ox + (viewport.width / before.cellPx - viewport.width / zoom) / 2,
      oy: view.oy + (viewport.height / before.cellPx - viewport.height / zoom) / 2,
    });
  }

  return clampView(world, viewport, {
    zoom,
    ox: target.x + 0.5 - anchor.x / zoom,
    oy: target.y + 0.5 - anchor.y / zoom,
  });
}

/** Centre the view on a cell, as far as the world's edges allow. */
export function centreOn(world: WorldSize, viewport: Viewport, zoom: number, x: number, y: number): View {
  const cellPx = clampZoom(zoom);
  return clampView(world, viewport, {
    zoom: cellPx,
    ox: x + 0.5 - viewport.width / cellPx / 2,
    oy: y + 0.5 - viewport.height / cellPx / 2,
  });
}

/**
 * Snap a CSS coordinate to a device pixel.
 *
 * The canvas backing store is CSS size x devicePixelRatio, and a destination
 * rectangle that is not on a whole device pixel gets resampled — which is the
 * one thing the integer zoom exists to prevent.
 */
export function toDevice(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr);
}
