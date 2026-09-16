import test from 'node:test';
import assert from 'node:assert/strict';

import { nearestBugAnywhere, pickNearestBug, pickRadiusCells, PICK_RADIUS_PX } from '../src/ui/pickBug.js';

/** A world of the given size holding one bug per listed cell. */
function world(width: number, height: number, bugCells: Array<[number, number]>, emptyCells: Array<[number, number]> = []) {
  const cells = new Map<number, readonly unknown[]>();
  for (const [x, y] of emptyCells) cells.set(x * height + y, []);
  for (const [x, y] of bugCells) cells.set(x * height + y, [{}]);
  return { width, height, cells };
}

test('a click on a bug finds that bug, at no distance', () => {
  const w = world(240, 240, [[157, 144]]);
  const pick = pickNearestBug(w, 157, 144, 5);
  assert.ok(pick);
  assert.equal(pick.direct, true);
  assert.equal(pick.distance, 0);
  assert.equal(pick.x, 157);
  assert.equal(pick.y, 144);
  // The dish addresses a cell by x * height + y, not the other way round.
  assert.equal(pick.hash, 157 * 240 + 144);
});

test('a click one cell off a bug still finds it, and says how far', () => {
  const w = world(240, 240, [[157, 144]]);
  const pick = pickNearestBug(w, 155, 144, 5);
  assert.ok(pick);
  assert.equal(pick.direct, false);
  assert.equal(pick.x, 157);
  assert.equal(pick.y, 144);
  assert.equal(pick.distance, 2);
});

test('the nearest bug wins, not the first one in the map', () => {
  // Both candidates are inside the radius, and the farther one is inserted first:
  // an implementation that returns the first cell it meets answers with the wrong
  // bug. A decoy outside the radius would not test this at all — it could never be
  // the first candidate.
  const w = world(240, 240, [[96, 100], [103, 100]]);
  const pick = pickNearestBug(w, 100, 100, 5);
  assert.ok(pick);
  assert.deepEqual([pick.x, pick.y], [103, 100], '3 cells away beats 4 cells away');
  assert.equal(pick.distance, 3);
});

test('distance is Euclidean, not the larger axis', () => {
  // (2,2) is 2.83 cells away; (3,0) is 3. A Chebyshev or box scan treats both as
  // 3 and would fall through to the tie-break and pick (3,0) for its lower row.
  const w = world(240, 240, [[3, 0], [2, 2]]);
  const pick = pickNearestBug(w, 0, 0, 5);
  assert.ok(pick);
  assert.deepEqual([pick.x, pick.y], [2, 2]);
});

test('equidistant bugs resolve the same way whichever order the map iterates in', () => {
  const left: [number, number] = [8, 10];
  const right: [number, number] = [12, 10];
  const forwards = pickNearestBug(world(240, 240, [left, right]), 10, 10, 5);
  const backwards = pickNearestBug(world(240, 240, [right, left]), 10, 10, 5);
  assert.ok(forwards && backwards);
  assert.deepEqual([forwards.x, forwards.y], [8, 10], 'lower column wins a tie');
  assert.deepEqual([backwards.x, backwards.y], [forwards.x, forwards.y], 'and the answer is order-independent');

  // Same column: the lower row wins.
  const above: [number, number] = [10, 8];
  const below: [number, number] = [10, 12];
  const vertical = pickNearestBug(world(240, 240, [below, above]), 10, 10, 5);
  assert.ok(vertical);
  assert.deepEqual([vertical.x, vertical.y], [10, 8]);
});

test('a bug beyond the radius is not picked, and the same world has one nearby', () => {
  const w = world(240, 240, [[100, 100]]);
  assert.equal(pickNearestBug(w, 100, 110, 5), null, 'ten cells away is outside a five-cell reach');
  assert.ok(pickNearestBug(w, 100, 110, 10), 'and inside a ten-cell reach');
});

test('the radius is inclusive at its edge', () => {
  const w = world(240, 240, [[105, 100]]);
  const pick = pickNearestBug(w, 100, 100, 5);
  assert.ok(pick, 'exactly five cells away is within a five-cell reach');
  assert.equal(pick.distance, 5);
});

test('a cell that outlives its occupant is not a candidate', () => {
  // Cells with an empty list are skipped, otherwise a dead bug's last cell answers
  // a click and the inspector is pointed at nothing. Both bugs are inside the
  // radius, so a failure here is about the empty list and not about the reach.
  const emptyOnly = world(240, 240, [], [[100, 100]]);
  assert.equal(pickNearestBug(emptyOnly, 100, 100, 5), null, 'an empty cell is not a bug, even at zero distance');

  const withNeighbour = world(240, 240, [[104, 100]], [[100, 100]]);
  const pick = pickNearestBug(withNeighbour, 100, 100, 5);
  assert.ok(pick);
  assert.deepEqual([pick.x, pick.y], [104, 100], 'the click falls past the empty cell to the bug that is there');
  assert.equal(pick.distance, 4);
});

test('an empty world picks nothing, bounded or not', () => {
  const w = world(240, 240, []);
  assert.equal(pickNearestBug(w, 120, 120, 5), null);
  assert.equal(nearestBugAnywhere(w, 120, 120), null);
});

test('the unbounded search reports what the bounded one refused', () => {
  // The pair is the point: the bounded search decides the selection, the unbounded
  // one only feeds the message that says how far the nearest bug is.
  const w = world(240, 240, [[101, 100]]);
  assert.equal(pickNearestBug(w, 120, 120, 5), null);
  const far = nearestBugAnywhere(w, 120, 120);
  assert.ok(far);
  assert.deepEqual([far.x, far.y], [101, 100]);
  assert.equal(far.distance.toFixed(1), '27.6', 'sqrt(19² + 20²)');
});

test('the reach follows the size the world is drawn at', () => {
  // 15 px of reach: at 3 px per cell that is five cells, and it stays roughly a
  // fingertip on screen as the canvas grows.
  assert.equal(PICK_RADIUS_PX, 15);
  assert.equal(pickRadiusCells(720, 240), 5);
  assert.equal(pickRadiusCells(1440, 240), 3, 'tiny cells relative to the reach are clamped');
  assert.equal(pickRadiusCells(240, 240), 10, 'a huge reach is clamped too');
  assert.equal(pickRadiusCells(0, 240), 3, 'a canvas with no measured width falls back to the floor');
  assert.equal(pickRadiusCells(720, 0), 3);
});
