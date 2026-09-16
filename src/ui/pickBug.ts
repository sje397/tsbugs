/**
 * Turning a click into a bug.
 *
 * Upstream's worldView maps a mouse position to a cell and then `edit_bug(x, y)`
 * looks up that cell's list — so a click that lands one pixel off a bug finds
 * nothing, and the world is mostly empty. Measured on the default world at tick
 * 200: 76 bugs in 57,600 cells (0.132%), the canvas drawing each cell in 3 screen
 * pixels, and the nearest bug from a random point a median 21 cells away. So a
 * miss has two quite different causes that look identical from the user's side:
 *
 *  - an aim error of one or two pixels, which is a whole cell at this scale, and
 *  - genuinely empty space.
 *
 * The second cannot be fixed by looking harder, so the pick is bounded: a bug is
 * only selected if it is within a radius derived from the on-screen size of a cell,
 * and the panel says how far away it was. A nearest-bug search with no bound would
 * answer every click with *some* bug, which is worse than saying nothing — it would
 * silently describe a bug on the far side of the world.
 *
 * The tie-break is deliberate rather than incidental: two bugs equidistant from the
 * click must not depend on map iteration order, or a repeated click could walk
 * between them for no reason the user can see.
 */

/** The part of a world this needs: its size, and the cells that hold bugs. */
export interface CellSource {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyMap<number, readonly unknown[]>;
}

/** A bug the pick settled on, and how far it was from the click. */
export interface PickedBug {
  /** Cell coordinates of the bug. */
  readonly x: number;
  readonly y: number;
  /** Its cell hash, the way the dish addresses a cell. */
  readonly hash: number;
  /** Euclidean distance in cells from the clicked cell. 0 means a direct hit. */
  readonly distance: number;
  /** True when the click landed on the bug's own cell. */
  readonly direct: boolean;
}

/**
 * How far a click may reach, in screen pixels.
 *
 * A cell is 3 px across on the default canvas, so this is about five cells — near
 * enough that the selection is plausibly the bug that was aimed at, and far enough
 * to absorb the one-cell error a hand makes at this scale.
 */
export const PICK_RADIUS_PX = 15;

const MIN_RADIUS_CELLS = 3;
const MAX_RADIUS_CELLS = 10;

/**
 * The pick radius in cells for the size the world is currently drawn at.
 *
 * Expressed in screen pixels rather than cells so it means the same thing to a
 * hand at any zoom: if the canvas is later scaled up, the reach shrinks in cells
 * and stays constant on screen. Clamped, because at one pixel per cell an
 * unclamped 15-cell reach would select bugs the user cannot see, and at large
 * scales a literal 2-pixel reach would reinstate the aim-error miss this exists
 * to fix.
 */
export function pickRadiusCells(canvasWidth: number, worldWidth: number): number {
  if (!(canvasWidth > 0) || !(worldWidth > 0)) return MIN_RADIUS_CELLS;
  const pxPerCell = canvasWidth / worldWidth;
  const cells = Math.round(PICK_RADIUS_PX / pxPerCell);
  return Math.min(MAX_RADIUS_CELLS, Math.max(MIN_RADIUS_CELLS, cells));
}

/**
 * The nearest cell holding at least one bug, or null if there is none.
 *
 * `maxCells` bounds the search: a bug further away than that is not returned at
 * all, so the caller can distinguish "picked the nearest" from "there is nothing
 * here" rather than being handed a distant bug with no way to tell.
 *
 * A cell in the map with an empty list is not a bug — cells can outlive their
 * occupants — and is skipped.
 */
function search(world: CellSource, x: number, y: number, maxCells: number): PickedBug | null {
  const limit = maxCells * maxCells;
  let best: PickedBug | null = null;

  for (const [hash, bugs] of world.cells) {
    if (bugs.length === 0) continue;
    const bx = Math.trunc(hash / world.height);
    const by = hash % world.height;
    const dx = bx - x;
    const dy = by - y;
    const squared = dx * dx + dy * dy;
    if (squared > limit) continue;

    // Nearest wins; ties go to the lower row, then the lower column, so the
    // answer does not depend on the order the map happens to iterate in.
    const better =
      best === null ||
      squared < best.distance * best.distance ||
      (squared === best.distance * best.distance && (by < best.y || (by === best.y && bx < best.x)));
    if (better) {
      best = { x: bx, y: by, hash, distance: Math.sqrt(squared), direct: squared === 0 };
    }
  }

  return best;
}

/** The nearest bug within `maxCells` of the clicked cell, or null. */
export function pickNearestBug(world: CellSource, x: number, y: number, maxCells: number): PickedBug | null {
  return search(world, x, y, maxCells);
}

/**
 * The nearest bug anywhere in the world, however far away.
 *
 * Only for telling the user what they missed: "no bug within 5 cells — the
 * nearest is 21.0 cells away" is a fact they can act on, where "no bug here" is
 * not. Never use this to make a selection.
 */
export function nearestBugAnywhere(world: CellSource, x: number, y: number): PickedBug | null {
  return search(world, x, y, Infinity);
}
