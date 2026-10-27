/**
 * Screen and cell coordinates, both directions, over a matrix.
 *
 * The failure these are built for is symmetric and quiet: a mapping that is
 * self-consistent in one direction and off by a cell or an axis in the other.
 * Reading the code will not show it, a picture of the dish will not show it (a
 * dish is symmetric noise), and the only cheap detector is a round trip over
 * every cell at several zooms and pans.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZOOM_MAX, cellAt, cellCentre, cellRect, centreOn, clampView, clampZoom,
  fitZoom, layout, panBy, toDevice, visibleCells, zoomAt, zoomStep,
} from '../src/ui/worldView.js';
import { pixelIndex } from '../src/ui/blit.js';

const WORLDS = [
  { width: 240, height: 240 },
  { width: 5, height: 3 },
  { width: 60, height: 180 },
];
const VIEWPORTS = [
  { width: 900, height: 620 },
  { width: 320, height: 480 },
];

test('every visible cell round-trips through its own centre', () => {
  for (const world of WORLDS) {
    for (const viewport of VIEWPORTS) {
      for (const zoom of [1, 2, 3, 9]) {
        for (const [ox, oy] of [[0, 0], [1, 1], [10, 5]]) {
          const l = layout(world, viewport, { zoom, ox, oy });
          for (let y = l.oy; y < Math.min(world.height, l.oy + 40); y++) {
            for (let x = l.ox; x < Math.min(world.width, l.ox + 40); x++) {
              const c = cellCentre(l, x, y);
              assert.deepEqual(
                cellAt(l, c.x, c.y),
                { x, y },
                `world ${world.width}x${world.height} view ${viewport.width}x${viewport.height} zoom ${zoom} pan ${ox},${oy}: cell ${x},${y} did not round-trip`,
              );
            }
          }
        }
      }
    }
  }
});

test('a point outside the world is over nothing', () => {
  const world = { width: 60, height: 60 };
  const viewport = { width: 900, height: 600 };
  // Fitted at zoom 4: the world is 240 px and centred, so there is 330 px of
  // letterbox on each side. The middle ROW of the world is at cssY 300; the
  // letterbox cases vary x only, which is why they are all asserted at that row.
  const fitted = layout(world, viewport, { zoom: 4, ox: 0, oy: 0 });
  assert.deepEqual([fitted.originX, fitted.originY], [330, 180]);
  assert.equal(cellAt(fitted, 1, 300), null, 'letterbox to the left of the world');
  assert.equal(cellAt(fitted, 899, 300), null, 'letterbox to the right of the world');
  assert.equal(cellAt(fitted, fitted.originX - 0.01, 300), null, 'a hair left of cell 0');
  assert.equal(cellAt(fitted, 450, fitted.originY - 0.01), null, 'a hair above cell 0');
  // Both axes at once, or the corner cell is read from a row that is not row 0.
  assert.deepEqual(cellAt(fitted, fitted.originX + 0.01, fitted.originY + 0.01), { x: 0, y: 0 });

  // Panned is a different question, and it needs a world that OVERFLOWS: at zoom 8
  // a 60-cell world is 480 px, which still fits inside 900x600, so clampView pins
  // ox to 0 and there is nothing panned to test. 240 cells at zoom 8 is 1920 px.
  const panned = layout({ width: 240, height: 240 }, viewport, { zoom: 8, ox: 20, oy: 2 });
  assert.deepEqual([panned.originX, panned.originY], [-160, -16]);
  // The world starts left of the viewport, so cssX 0 is inside it: the top-left
  // visible cell is the pan origin, and there is no letterbox to be over.
  assert.deepEqual(cellAt(panned, 0, 0), { x: 20, y: 2 });
  // The far edge, one pixel past the world's own extent, is over nothing -- the
  // pan does not wrap.
  // the right edge of the world is at -160 + 240*8 = 1760
  assert.equal(cellAt(panned, 1761, 300), null, 'past the world is outside it, not a wrap');
});

test('a panned view cannot leave the world', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  for (const zoom of [4, 8, 24]) {
    for (const asked of [-50, -1, 0, 1, 100, 5000]) {
      const v = clampView(world, viewport, { zoom, ox: asked, oy: asked });
      const l = layout(world, viewport, { zoom, ox: asked, oy: asked });
      assert.ok(v.ox >= 0 && v.oy >= 0, 'negative pan');
      // The right/bottom edge must stay inside the viewport when panned out.
      assert.ok(l.originX + world.width * l.cellPx >= viewport.width - 1e-9, 'gap on the right');
      assert.ok(l.originY + world.height * l.cellPx >= viewport.height - 1e-9, 'gap at the bottom');
      assert.ok(l.originX <= 0 && l.originY <= 0, 'gap on the left or top');
    }
  }
});

test('a world that fits is pinned and centred, not pannable', () => {
  const world = { width: 60, height: 60 };
  const viewport = { width: 900, height: 600 };
  const a = layout(world, viewport, { zoom: 4, ox: 0, oy: 0 });
  const b = layout(world, viewport, { zoom: 4, ox: 30, oy: 30 });
  assert.deepEqual([a.ox, a.oy], [0, 0]);
  assert.deepEqual([b.ox, b.oy], [0, 0], 'a fitted world must not pan');
  assert.equal(a.originX, b.originX);
  assert.equal(a.originX, (900 - 240) / 2);
});

test('fit shows the whole world and never a fractional pixel', () => {
  for (const world of WORLDS) {
    for (const viewport of VIEWPORTS) {
      const zoom = fitZoom(world, viewport);
      assert.ok(Number.isInteger(zoom), 'zoom is not an integer');
      assert.ok(zoom >= 1);
      if (viewport.width >= world.width && viewport.height >= world.height) {
        assert.ok(world.width * zoom <= viewport.width, 'fit is wider than the viewport');
        assert.ok(world.height * zoom <= viewport.height, 'fit is taller than the viewport');
      }
    }
  }
  // The LOWER of the two ratios binds, and on a 900x620 stage that is the height:
  // 620/240 = 2.58, so fit is 2 and the 240-cell world is drawn 480 px square with
  // 70 px of letterbox above and below. (900/240 = 3.75 alone would be 3, and the
  // world would be 100 px taller than the stage.)
  assert.equal(fitZoom({ width: 240, height: 240 }, { width: 900, height: 620 }), 2);
  assert.equal(fitZoom({ width: 240, height: 240 }, { width: 900, height: 900 }), 3);
});

test('zooming holds the cell under the pointer, unless an edge is in the way', () => {
  // The world overflows BOTH axes at every zoom here (480 cells at zoom 2 is 960 px
  // against a 300x200 stage), which is the case anchoring is defined for: a fitted
  // world is centred by design, so there is no anchor to hold.
  const world = { width: 480, height: 480 };
  const viewport = { width: 300, height: 200 };
  let held = 0;
  let pinned = 0;

  for (const from of [2, 3, 4, 6, 8]) {
    for (const to of [2, 3, 4, 6, 8]) {
      for (const [ax, ay] of [[150, 100], [80, 60], [220, 140], [10, 10]]) {
        const before = layout(world, viewport, { zoom: from, ox: 0, oy: 0 });
        const target = cellAt(before, ax, ay);
        assert.ok(target, `anchor ${ax},${ay} must be over the world at zoom ${from}`);

        const view = zoomAt(world, viewport, { zoom: from, ox: 0, oy: 0 }, to, { x: ax, y: ay });
        const after = layout(world, viewport, view);
        const got = cellAt(after, ax, ay);

        // Holding the anchor exactly needs ox = target.x + 0.5 - ax / zoom to land
        // inside [0, max]. Zooming OUT from a view pinned at the top-left asks for a
        // negative ox -- the anchored cell would have to sit left of the viewport's
        // left edge, i.e. letterbox before cell 0, which this renderer never draws.
        // There the view pins at the edge instead, and that is the whole of the
        // exception: no other case may lose the anchor.
        if (view.ox === 0 || view.oy === 0) {
          pinned++;
          continue;
        }
        assert.ok(got, `zoom ${from} -> ${to} at ${ax},${ay} put the anchor outside the world`);
        const drift = Math.max(Math.abs(got.x - target.x), Math.abs(got.y - target.y));
        // At most one cell: the pan is rounded to whole cells so the dish stays
        // crisp (see worldView.ts), and half a cell of rounding is one cell of drift
        // at a boundary. An axis swap or a sign error is far larger than this.
        assert.ok(drift <= 1, `zoom ${from} -> ${to} at ${ax},${ay} moved the cell ${drift} cells`);
        if (drift === 0) held++;
      }
    }
  }

  // These two counters are the control on the assertions above: if nothing were
  // held exactly, the test would only be measuring its own escape hatch, and if
  // nothing were pinned, the pinning clause would be dead.
  assert.ok(held > 10, `the anchor was held exactly only ${held} times -- the matrix is not exercising it`);
  assert.ok(pinned > 0, 'no case exercised the pinned-at-an-edge exception');
});

test('zooming out below the overflow size pins the view, and centres the axis that fits', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  const zoomed = zoomAt(world, viewport, { zoom: 8, ox: 40, oy: 40 }, 3, { x: 450, y: 310 });
  // Zooming out from 8 to 3 asks for ox = 96.5 - 450/3 = -53.5: negative, so the pan
  // clamps to 0 on both axes and the view is no longer panned at all.
  assert.deepEqual([zoomed.ox, zoomed.oy], [0, 0]);

  const after = layout(world, viewport, zoomed);
  // 720 px wide inside 900: the width now fits, so that axis is centred (90 px of
  // letterbox each side). 720 px tall does not fit inside 620, so that axis stays
  // pinned at cell 0 and its origin is 0. One view, two axes, two rules.
  assert.deepEqual([after.originX, after.originY], [90, 0]);
});

test('zoom steps double and halve, and stop at the ends', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  const anchor = { x: 450, y: 310 };
  assert.equal(zoomStep(world, viewport, { zoom: 4, ox: 0, oy: 0 }, 1, anchor).zoom, 8);
  assert.equal(zoomStep(world, viewport, { zoom: 3, ox: 0, oy: 0 }, 1, anchor).zoom, 6);
  assert.equal(zoomStep(world, viewport, { zoom: 3, ox: 0, oy: 0 }, -1, anchor).zoom, 1);
  assert.equal(zoomStep(world, viewport, { zoom: ZOOM_MAX, ox: 0, oy: 0 }, 1, anchor).zoom, ZOOM_MAX);
  assert.equal(clampZoom(0), 1);
  assert.equal(clampZoom(1000), ZOOM_MAX);
  assert.equal(clampZoom(Number.NaN), 1);
});

test('panning is reversible and clamped at the edge', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  const start = { zoom: 8, ox: 40, oy: 40 };
  const there = panBy(world, viewport, start, 80, -40);
  assert.deepEqual(there, { zoom: 8, ox: 30, oy: 45 });
  assert.deepEqual(panBy(world, viewport, there, -80, 40), start);
  const wayLeft = panBy(world, viewport, start, 10000, 10000);
  assert.deepEqual([wayLeft.ox, wayLeft.oy], [0, 0]);
});

test('centring a cell puts it in the middle, unless an edge stops it', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  const middle = layout(world, viewport, centreOn(world, viewport, 8, 120, 120));
  const target = cellCentre(middle, 120, 120);
  // To half a cell, not to the pixel. 900 / 8 = 112.5 cells across the viewport, so
  // its middle falls halfway through a cell and no whole-cell pan can put a cell's
  // centre on it: the cell centre lands 2 px off, which is the closest there is.
  const tolerance = middle.cellPx / 2;
  assert.ok(Math.abs(target.x - viewport.width / 2) <= tolerance,
    `x is ${target.x}, ${Math.abs(target.x - viewport.width / 2)} px from the middle`);
  assert.ok(Math.abs(target.y - viewport.height / 2) <= tolerance,
    `y is ${target.y}, ${Math.abs(target.y - viewport.height / 2)} px from the middle`);

  const corner = layout(world, viewport, centreOn(world, viewport, 8, 0, 0));
  assert.deepEqual([corner.ox, corner.oy], [0, 0], 'a corner cannot be centred; it is pinned');
});

test('the marker and the blit agree about where a cell is', () => {
  // Two modules, one mapping. At zoom 1 with no letterbox the cell the marker
  // rings must be the pixel the blit wrote — the transpose bug was exactly this
  // disagreement, in the other direction.
  const world = { width: 40, height: 40 };
  const viewport = { width: 40, height: 40 };
  const l = layout(world, viewport, { zoom: 1, ox: 0, oy: 0 });
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const rect = cellRect(l, x, y);
      assert.equal(rect.left, x);
      assert.equal(rect.top, y);
      const c = cellCentre(l, x, y);
      const back = cellAt(l, c.x, c.y);
      assert.deepEqual(back, { x, y });
      // The pixel the same cell occupies, from the blit's own rule.
      assert.equal(pixelIndex(back!.x, back!.y, world.width), y * world.width + x);
    }
  }
});

test('a cell centre is the middle of its own rectangle', () => {
  // The round trip above cannot see this: at one pixel per cell the left edge and
  // the centre both floor to the same cell, so a centre that lost its half-pixel
  // still maps back correctly. Found by mutation — dropping `(x + 0.5)` left all
  // thirteen tests green — and the cost is real rather than cosmetic: the ring sits
  // on the cell's top-left corner instead of over the bug, and a hover probe at low
  // zoom can name the neighbour. Equidistance is the assertion that fails either way.
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  let checked = 0;
  for (const zoom of [1, 2, 3, 7, 9]) {
    for (const view of [{ zoom, ox: 0, oy: 0 }, { zoom, ox: 37, oy: 51 }, { zoom, ox: 200, oy: 140 }]) {
      const l = layout(world, viewport, view);
      for (const [x, y] of [[0, 0], [1, 0], [0, 1], [119, 200], [239, 239]]) {
        const rect = cellRect(l, x, y);
        const c = cellCentre(l, x, y);
        const toLeft = c.x - rect.left;
        const toRight = rect.left + rect.size - c.x;
        const toTop = c.y - rect.top;
        const toBottom = rect.top + rect.size - c.y;
        assert.ok(Math.abs(toLeft - toRight) < 1e-9, `zoom ${zoom} cell ${x},${y}: ${toLeft} px to the left edge, ${toRight} to the right`);
        assert.ok(Math.abs(toTop - toBottom) < 1e-9, `zoom ${zoom} cell ${x},${y}: ${toTop} px to the top, ${toBottom} to the bottom`);
        assert.deepEqual(cellAt(l, c.x, c.y), { x, y });
        checked++;
      }
    }
  }
  assert.equal(checked, 75);
});


test('visible cells cover the viewport when zoomed in', () => {
  const world = { width: 240, height: 240 };
  const viewport = { width: 900, height: 620 };
  for (const zoom of [4, 9, 24]) {
    const { cols, rows } = visibleCells(world, viewport, zoom);
    assert.ok(cols * zoom >= viewport.width, `zoom ${zoom}: ${cols} columns do not cover 900 px`);
    assert.ok(rows * zoom >= viewport.height, `zoom ${zoom}: ${rows} rows do not cover 620 px`);
    assert.ok(cols <= world.width && rows <= world.height);
  }
});

test('device pixels are whole', () => {
  assert.equal(toDevice(10.4, 2), 21);
  assert.equal(toDevice(10, 1), 10);
  assert.equal(toDevice(-0.6, 2), -1);
});
