/**
 * The dish: energy accounting, the sensory model, and the pixel cache.
 *
 * The two properties worth the most here are ones upstream only ever watched by
 * eye: that the energy counters equal the energy actually held (petri_dish.cpp
 * check_integrity), and that the incremental pixel updates agree with a full
 * refresh. The second is a cross-check of two independent code paths, so it can
 * disagree — which is the only thing that makes it evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampByteRamp,
  clampElevation,
  elevationByte,
  offX,
  offY,
  PetriDish,
  senseByte,
  terrainColor,
  ViewMode,
  wrapX,
  wrapY,
} from '../src/sim/dish.js';
import {
  DEFAULT_PARAMS,
  ENERGY_COLOR,
  EnergyLayout,
  MAX_BUG_COLOR,
  SenseModel,
  TERRAIN_FLAT,
  TERRAIN_MAX,
  TERRAIN_MIN,
  TERRAIN_RAMP_SCALE,
  type WorldParams,
} from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import type { Bug } from '../src/sim/bug.js';

const CELLS = DEFAULT_PARAMS.width * DEFAULT_PARAMS.height;

const ALL_VIEW_MODES = [
  ViewMode.DEFAULT,
  ViewMode.BUGS,
  ViewMode.ENERGY,
  ViewMode.AGE,
  ViewMode.DNA_SIZE,
  ViewMode.DNA_VALUE,
  ViewMode.TERRAIN,
];

function run(steps: number, overrides: Partial<WorldParams> = {}, seed = 1234): PetriDish {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, ...overrides }, new Rng(seed));
  for (let i = 0; i < steps; i++) dish.step();
  return dish;
}

function snapshot(dish: PetriDish): string {
  return [
    dish.population,
    dish.bugEnergy,
    dish.energyEnergy,
    dish.maxGen,
    dish.activeCellCount,
    [...dish.viewCol].join(','),
  ].join('|');
}

test('the wrap macros step around the edge; the offset macros step off it', () => {
  // WRAP_X and WRAP_Y are total: they always land inside the grid.
  assert.equal(wrapX(0, 0, 240), 239);
  assert.equal(wrapX(2, 239, 240), 0);
  assert.equal(wrapX(1, 5, 240), 5);
  assert.equal(wrapY(0, 0, 240), 239);
  assert.equal(wrapY(6, 239, 240), 0);
  assert.equal(wrapY(3, 7, 240), 7);

  // The un-wrapped pair is not: it returns -1 and height, which is what the
  // kill_on_edge test and the bounds check look for.
  assert.equal(offX(0, 0), -1);
  assert.equal(offX(2, 239), 240);
  assert.equal(offY(0, 0), -1);
  assert.equal(offY(6, 239), 240);
  assert.equal(offX(1, 5), 5);
  assert.equal(offY(3, 7), 7);
});

test('check_integrity finds no anomalies and no double counting', () => {
  for (const senseModel of [SenseModel.SIGHTED, SenseModel.AS_SHIPPED]) {
    const dish = run(400, { senseModel }, 4242);
    const report = dish.checkIntegrity();

    assert.ok(report.bugCount > 0, 'the fixture must contain bugs');
    assert.equal(report.bugCount, report.population, 'population counter drifted');
    assert.equal(report.summedBugEnergy, report.bugEnergy, 'bugEnergy drifted');
    assert.equal(report.summedCellEnergy, report.energyEnergy, 'energyEnergy drifted');
    assert.equal(report.unlistedOccupied, 0);
    assert.equal(report.listedButEmpty, 0);
    assert.equal(report.overfullBugs, 0);
    assert.equal(report.underfullBugs, 0);
    assert.equal(report.overfullNodes, 0);
    assert.equal(report.underfullNodes, 0);
  }
});

test('the world never holds more energy than it has', () => {
  const dish = new PetriDish(DEFAULT_PARAMS, new Rng(2024));
  for (let i = 0; i < 600; i++) {
    dish.step();
    const held = dish.bugEnergy + dish.energyEnergy;
    assert.ok(
      held <= DEFAULT_PARAMS.totalEnergy,
      `step ${i}: ${held} energy held against a budget of ${DEFAULT_PARAMS.totalEnergy}`,
    );
  }
});

test('every energy layout runs and keeps the budget', () => {
  const layouts = Object.values(EnergyLayout).filter(
    (value): value is EnergyLayout => typeof value === 'number',
  );
  assert.equal(layouts.length, 7, 'the layout enum changed size');

  for (const energyLayout of layouts) {
    const dish = run(60, { energyLayout }, 8);
    const report = dish.checkIntegrity();
    assert.equal(report.unlistedOccupied, 0, `layout ${energyLayout}`);
    assert.equal(report.listedButEmpty, 0, `layout ${energyLayout}`);
    assert.equal(report.summedCellEnergy, report.energyEnergy, `layout ${energyLayout}`);
    assert.equal(report.summedBugEnergy, report.bugEnergy, `layout ${energyLayout}`);
  }
});

test('the shipped sense model blinds the energy channel and flattens altitude', () => {
  const shipped = run(200, { senseModel: SenseModel.AS_SHIPPED }, 999);
  const sighted = run(200, { senseModel: SenseModel.SIGHTED }, 999);

  let bugs = 0;
  let shippedEnergySlots = 0;
  let shippedNonFlatAltitude = 0;
  let sightedEnergySlots = 0;
  let sightedNonUniformEnergy = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    for (const bug of shipped.bugsAt(hash)) {
      bugs++;
      for (let d = 0; d < 9; d++) {
        // Slots 18..26 are the energy sense. Upstream passes the altitude array
        // here instead, so they are never written.
        if (bug.processor.readIn(18 + d) !== 0) shippedEnergySlots++;
      }
      // Slots 9..17 are the altitude sense, and they instead receive the flat
      // energy value: nine copies of one reading, no gradient.
      for (let d = 1; d < 9; d++) {
        if (bug.processor.readIn(9 + d) !== bug.processor.readIn(9)) shippedNonFlatAltitude++;
      }
    }

    for (const bug of sighted.bugsAt(hash)) {
      let nonZero = 0;
      for (let d = 0; d < 9; d++) if (bug.processor.readIn(18 + d) !== 0) nonZero++;
      sightedEnergySlots += nonZero;
      if (nonZero > 0 && nonZero < 9) sightedNonUniformEnergy++;
    }
  }

  assert.ok(bugs > 0, 'the fixture must contain bugs');
  assert.equal(shippedEnergySlots, 0, 'the energy channel is never written as shipped');
  assert.equal(shippedNonFlatAltitude, 0, 'the shipped altitude channel is one value nine times');

  // The control: the same world and the same seed, sensed as the code intended,
  // does carry energy — and carries it per neighbour rather than flat.
  assert.ok(sightedEnergySlots > 0, 'the energy channel must be non-empty when wired correctly');
  assert.ok(sightedNonUniformEnergy > 0, 'the energy window must have a real 3x3 gradient');
});

test('a sensory reading saturates at both ends instead of wrapping (upstream UB)', () => {
  // senseByte is upstream's float -> unsigned char conversion with the edge
  // behaviour pinned: callers scale a value into 0..255 first, and the upper
  // edge is reachable in ordinary play because energy deposits are additive with
  // no cap. It is now the energy channel's conversion only — terrain carries its
  // signed byte unwrapped (elevationByte) — so the maxima below are explicit
  // rather than read from the terrain constant they used to share.
  //
  // The failure mode is not merely arbitrary. Wrapped mod 256, a reading of -1
  // comes back as 255, near-maximum, which inverts the signal the VM evolves
  // against rather than blurring it.
  const M = 10; // upstream's MAX_TERRAIN, kept as the sweep's shape

  assert.equal(senseByte(-1, M), 0, 'below the range saturates low, it does not wrap high');
  assert.equal(senseByte(-0.4, M), 0);
  assert.equal(senseByte(0, M), 0);
  assert.equal(senseByte(M * 2, M), 255, 'above the range saturates high');
  assert.equal(senseByte(80 * 3, 80), 255);

  // Every in-range reading is identical to the original's, truncation toward
  // zero included: this changes the edges only.
  assert.equal(senseByte(5, M), 127); // 0.5 * 255 = 127.5
  assert.equal(senseByte(1, M), 25); // 0.1 * 255 = 25.5
  assert.equal(senseByte(0.02, 1), 5); // 5.1
  assert.equal(senseByte(80, 80), 255);
});


test('no bug ever stands on a poisoned cell', () => {
  const dish = run(300, {}, 11);
  let occupied = 0;
  for (let hash = 0; hash < CELLS; hash++) {
    if (dish.isPoisoned(hash) && dish.bugsAt(hash).length > 0) occupied++;
  }
  assert.equal(occupied, 0, 'placement and the move check should both avoid poison');
});

test('the per-cell bug-energy cap stops constraining anything (upstream defect)', () => {
  // doEatingAndSeeing only eats while cellBugTotal < max_energy * bugsInCell,
  // and cellBugTotal is never increased by eating — so the gate is open from
  // the moment a cell is populated, and the cap is inoperative.
  const dish = run(300, {}, 21);
  const cap = DEFAULT_PARAMS.maxEnergy;
  let cells = 0;
  let gateOpen = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    const count = dish.bugsAt(hash).length;
    if (count === 0) continue;
    cells++;
    if (dish.bugTotalAt(hash) < cap * count) gateOpen++;
  }

  assert.ok(cells > 0, 'the fixture must contain bugs');
  assert.equal(gateOpen, cells);
});

test('cellBugTotal lags the real bug energy by everything the bugs have eaten', () => {
  const dish = run(300, {}, 31);
  let summed = 0;
  for (let hash = 0; hash < CELLS; hash++) summed += dish.bugTotalAt(hash);

  // Spawning, moving and dying adjust both totals by the same amount; only
  // eating adjusts one of them. So this difference is exactly the energy the
  // bugs have absorbed, which is why the gate above can never close.
  assert.ok(dish.bugEnergy > 0);
  assert.ok(
    dish.bugEnergy - summed > 0,
    `bugEnergy ${dish.bugEnergy} and cellBugTotal ${summed} should have diverged by now`,
  );
});

/**
 * Copy the incremental cache, force a full recompute, and compare. Returns the
 * number of cells the incremental path had left wrong, so the caller can also
 * assert that the two paths were ever in a position to disagree.
 */
function staleCells(dish: PetriDish): number {
  const incremental = Uint8Array.from(dish.viewCol);
  dish.updateAllPixels();
  let differences = 0;
  for (let i = 0; i < incremental.length; i++) {
    if (incremental[i] !== dish.viewCol[i]) differences++;
  }
  return differences;
}

test('with births disabled the incremental cache is exact after every tick', () => {
  // Decomposition of the claim above: with births removed as a variable, the
  // move phase, the newPositions sweep and balance()'s two refreshes must each
  // be complete on their own, on every tick, in every view mode. That separates
  // one missing refresh from a systemic one.
  //
  // childEnergy is unreachable against a world budget of 120000, so no bug can
  // ever afford a child.
  const params: WorldParams = { ...DEFAULT_PARAMS, childEnergy: 1_000_000 };
  const dish = new PetriDish(params, new Rng(77));

  for (const mode of ALL_VIEW_MODES) {
    dish.setViewMode(mode);
    for (let i = 0; i < 150; i++) {
      dish.step();
      assert.equal(staleCells(dish), 0, `view mode ${ViewMode[mode]}, tick ${i}`);
    }
  }

  assert.equal(dish.births, 0, 'the fixture must produce no births to test what it claims');
  assert.ok(dish.population > 0, 'and must still be a live world');
});

test('no cell ever renders stale, births included (upstream defect fixed)', () => {
  // Upstream leaves a newborn's cell stale until the next tick's move phase,
  // because replicate()'s pixel refresh is commented out (petri_dish.cpp:647).
  // This port refreshes it — the newborn is unshifted to become bugs[0], the
  // bug every per-bug view mode renders, so it must be drawn. See
  // DIVERGENCES.md.
  //
  // This is the strongest form of the cache claim: every phase runs, in every
  // view mode, with births actually happening. Its sibling below removes births
  // to show the other three phases are complete without them.
  const dish = new PetriDish(DEFAULT_PARAMS, new Rng(77));

  for (const mode of ALL_VIEW_MODES) {
    dish.setViewMode(mode);
    for (let i = 0; i < 150; i++) {
      dish.step();
      assert.equal(staleCells(dish), 0, `view mode ${ViewMode[mode]}, tick ${i}`);
    }
  }

  assert.ok(dish.births > 0, 'the fixture must actually produce births');
  assert.ok(dish.population > 0, 'and must still be a live world');
});

test("per-bug view modes read the cell's first bug", () => {
  const dish = run(200, {}, 31);
  dish.setViewMode(ViewMode.ENERGY);

  let multiBug = 0;
  let discriminating = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    const bugs = dish.bugsAt(hash);
    if (bugs.length < 2) continue;
    multiBug++;

    const first = energyColour(bugs[0].energy);
    if (first !== energyColour(bugs[bugs.length - 1].energy)) discriminating++;

    assert.equal(dish.viewCol[hash], first, `cell ${hash} should show its first bug`);
  }

  assert.ok(multiBug > 0, 'the fixture must contain multi-bug cells');
  assert.ok(
    discriminating > 0,
    'every multi-bug cell agreed, so this test could not tell first from last',
  );
});

test('the terrain view is unreadable where a bug stands (upstream quirk)', () => {
  const dish = run(200, {}, 51);
  dish.setViewMode(ViewMode.TERRAIN);

  let withBugs = 0;
  let flat = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    if (dish.bugsAt(hash).length > 0) {
      withBugs++;
      assert.equal(
        dish.viewCol[hash],
        ENERGY_COLOR,
        `cell ${hash} holds a bug, so TERRAIN cannot show its terrain`,
      );
      continue;
    }
    if (dish.terrainAt(hash) === TERRAIN_FLAT) {
      flat++;
      // Upstream rendered flat ground as BKG_COLOR (black), because flat was a
      // special value rather than a level. It is a level now, so it takes its
      // place just past mid-ramp (139: the ramp is scaled to TERRAIN_RAMP_SCALE,
      // and flat is one level above sea level) — and the absolute number here is
      // what can tell the two behaviours apart.
      assert.equal(dish.viewCol[hash], 139, `flat ground at ${hash} should sit just past mid-ramp`);
    }
  }

  assert.ok(withBugs > 0, 'the fixture must contain bugs');
  assert.ok(flat > 0, 'the fixture must contain untouched flat ground');
});


// -------------------------------------------------------------------- terrain
//
// Terrain is a signed byte here (-127..+127, flat at 1) rather than upstream's
// int running up from 0. Two things follow that are worth testing separately:
// the encoding the VM receives, which is two's-complemented, and whether the
// population can actually reach the range at all — it turns out it barely can,
// which is why the landscape has to be seeded. See DIVERGENCES.md.

test('elevation is a signed byte: a hole reaches the VM as a value above flat ground', () => {
  // The VM reads its input slots as plain bytes, so a signed elevation arrives
  // two's-complemented: down is numerically up. That encoding is what a bug
  // evolves against, and it is why flat ground (1) and a hole one deep (255) are
  // about as far apart as two readings can be.
  assert.equal(elevationByte(TERRAIN_FLAT), 1);
  assert.equal(elevationByte(0), 0);
  assert.equal(elevationByte(-1), 255);
  assert.equal(elevationByte(TERRAIN_MIN), 129); // -127

  // And the clamp is what keeps that encoding from flipping. A signed byte
  // cannot hold 128, so an unclamped write does not saturate — it stores -128,
  // turning the highest ground in the world into the deepest pit.
  assert.equal(clampElevation(128), TERRAIN_MAX);
  assert.equal(clampElevation(TERRAIN_MAX + 1000), TERRAIN_MAX);
  assert.equal(clampElevation(-128), TERRAIN_MIN);
  assert.equal(clampElevation(0), 0);
  assert.equal(clampElevation(TERRAIN_FLAT), TERRAIN_FLAT);

  // The reachable path to that overflow is removeBug(): a dying bug's payload
  // goes back onto the ground with no guard at all (petri_dish.cpp:481), and a
  // bug can die anywhere. That is argued from the source rather than from a run,
  // because reaching an edge takes 126 deposits onto one cell.
  const byte = new Int8Array(1);
  byte[0] = 128;
  assert.equal(byte[0], -128, 'the wrap this clamp exists to prevent');

  // So the clamp has to sit at the store, not at each call site — and the store
  // can be driven past both ends directly, by seeding well beyond the range with
  // the blur switched off. Unblurred, a spread of ±200 lands thousands of cells
  // beyond each end on a grid this size, so saturation at exactly the two
  // extremes is what a clamped store produces and what a wrapping one cannot:
  // wrapped, +128 becomes -128 and the highest ground on the map turns into a
  // pit that is out of range at the bottom.
  const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(1));
  dish.seedTerrain(200, new Rng(2), 0);

  let min = TERRAIN_FLAT;
  let max = TERRAIN_FLAT;
  for (let hash = 0; hash < CELLS; hash++) {
    const e = dish.terrainAt(hash);
    assert.ok(e >= TERRAIN_MIN && e <= TERRAIN_MAX, `seeded cell ${hash} holds ${e}`);
    if (e < min) min = e;
    if (e > max) max = e;
  }
  assert.equal(min, TERRAIN_MIN, 'the floor saturates rather than wrapping');
  assert.equal(max, TERRAIN_MAX, 'the ceiling saturates rather than wrapping');
});

test('the view ramps saturate at the ends of the ramp instead of wrapping', () => {
  // Upstream returned `unsigned char` from every view mode, so a value past the
  // top of the ramp wrapped to the bottom: the most energetic bug in the world
  // would render as the least. Saturation is plainly what the formula reaches
  // for, and it keeps the reserved sentinels out of reach — otherwise energy,
  // age and DNA size would collide with poison and energy.
  assert.equal(clampByteRamp(0), 1);
  assert.equal(clampByteRamp(-500), 1);
  assert.equal(clampByteRamp(1), 1);
  assert.equal(clampByteRamp(200), 200);
  assert.equal(clampByteRamp(MAX_BUG_COLOR), MAX_BUG_COLOR);
  assert.equal(clampByteRamp(MAX_BUG_COLOR + 1), MAX_BUG_COLOR);
  assert.equal(clampByteRamp(1000), MAX_BUG_COLOR);

  for (let v = -1000; v <= 1000; v++) {
    const c = clampByteRamp(v);
    assert.ok(c >= 1 && c <= MAX_BUG_COLOR, `clampByteRamp(${v}) = ${c}`);
  }
});

test('the terrain view maps elevation monotonically, holes at the red end', () => {
  let previous = 0;
  for (let e = TERRAIN_MIN; e <= TERRAIN_MAX; e++) {
    const c = terrainColor(e);
    assert.ok(c >= previous, `terrainColor must not decrease with elevation (at ${e})`);
    assert.ok(c >= 1 && c <= MAX_BUG_COLOR, `terrainColor(${e}) = ${c}`);
    previous = c;
  }

  // The readability property, and the one that was actually broken: a single
  // level of elevation must move the colour a *visible* distance. Mapping the
  // signed byte's full range gave one palette index per level, so a seeded
  // world's relief of -11..+14 occupied palette 116..141 — a flat-looking yellow
  // field in the one view whose job is to show relief. Revert the scale to
  // `elevation + 127` and every step here drops to 1, so this fails.
  // Both ends of the ramp saturate one level early (terrain -10 computes 0 and
  // is held at 1; terrain 10 computes 254 and is held at 252), so the steps that
  // count are the ones fully inside the range, -9..8.
  for (let e = -(TERRAIN_RAMP_SCALE - 1); e <= TERRAIN_RAMP_SCALE - 2; e++) {
    const step = terrainColor(e + 1) - terrainColor(e);
    assert.ok(
      step >= 12,
      `one level of elevation must be visible: terrainColor(${e + 1}) - terrainColor(${e}) = ${step}`,
    );
  }
  // The last step up is shorter, and only because the top of the ramp is a
  // saturation rather than a wrap: the formula reaches 254 at terrain 10 and
  // MAX_BUG_COLOR is 252 (253/254/255 being cyan, poison and energy). Stated
  // rather than absorbed into a looser bound.
  assert.equal(
    terrainColor(TERRAIN_RAMP_SCALE) - terrainColor(TERRAIN_RAMP_SCALE - 1),
    11,
    'the final step is short by exactly the two reserved indices at the top',
  );

  // The ramp is scaled to the relief it is meant to resolve, and saturates
  // outside it. upstream: terrain 0 landed at 127 and 10 at 254, so flat ground
  // (1) sits just past mid-ramp and the extremes are the ramp's ends.
  assert.equal(terrainColor(0), 127, 'sea level is the middle of the ramp');
  assert.equal(terrainColor(TERRAIN_FLAT), 139, 'flat ground sits just past mid-ramp');
  assert.equal(terrainColor(-TERRAIN_RAMP_SCALE), 1, 'rock bottom is the red end');
  assert.equal(terrainColor(TERRAIN_RAMP_SCALE), MAX_BUG_COLOR, 'the ramp top is the green end');

  assert.equal(terrainColor(TERRAIN_MIN), 1, 'the type floor saturates at the red end');
  assert.equal(terrainColor(TERRAIN_MAX), MAX_BUG_COLOR, 'the type ceiling saturates at the green end');
});

test('seeded terrain gives the world relief, and the population does not flatten it', () => {
  // Upstream starts flat and a flat world stays flat: measured over 2000 ticks,
  // the population disturbs ~2% of the grid and digs no more than 1-2 below flat
  // ground, because a bug that digs is left carrying the payload it must put
  // back down before it can dig again (tools/terrain-probe shows the numbers).
  // So the terrain view has nothing to show unless the ground is seeded, and the
  // seeded ground has to survive contact with the bugs to be worth showing.
  const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(4242));
  dish.setViewMode(ViewMode.TERRAIN);
  dish.seedTerrain(20, new Rng(99));

  const relief = () => {
    let holes = 0;
    let hills = 0;
    let min = TERRAIN_FLAT;
    let max = TERRAIN_FLAT;
    for (let hash = 0; hash < CELLS; hash++) {
      const e = dish.terrainAt(hash);
      if (e < TERRAIN_FLAT) holes++;
      else if (e > TERRAIN_FLAT) hills++;
      if (e < min) min = e;
      if (e > max) max = e;
    }
    return { holes, hills, spread: max - min };
  };

  const seeded = relief();
  assert.ok(seeded.holes > 1000, `seeded ground has holes: ${seeded.holes}`);
  assert.ok(seeded.hills > 1000, `seeded ground has hills: ${seeded.hills}`);
  assert.ok(seeded.spread >= 8, `seeded relief: ${seeded.spread}`);

  // Seeding refreshes the pixel cache, so the first painted frame is the seeded
  // ground rather than the flat map the array held a moment before.
  for (let hash = 0; hash < CELLS; hash++) {
    if (dish.bugsAt(hash).length > 0) continue;
    assert.equal(dish.viewCol[hash], terrainColor(dish.terrainAt(hash)));
  }

  // Same seed, same ground: seeding is part of the deterministic world.
  const twin = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(4242));
  twin.seedTerrain(20, new Rng(99));
  for (let hash = 0; hash < CELLS; hash++) {
    assert.equal(twin.terrainAt(hash), dish.terrainAt(hash), `cell ${hash} differs`);
  }

  const before = relief();
  for (let t = 0; t < 1000; t++) dish.step();
  const after = relief();
  assert.ok(after.holes > 1000, `holes left after 1000 ticks: ${after.holes}`);
  assert.ok(after.hills > 1000, `hills left after 1000 ticks: ${after.hills}`);
  assert.ok(
    after.spread > before.spread / 2,
    `relief collapsed from ${before.spread} to ${after.spread}`,
  );
});

test('seeded ground is rolling, not spiky — the world moves by climbing', () => {
  // A per-cell random field is not terrain: the cost of every step would be an
  // independent draw, and the climb rule would have nothing to be a gradient of.
  // So the seeding blurs. Stated as a comparison between this code's own blurred
  // and unblurred output, which needs no invented constant — the measured gap at
  // roughness 20 is 1.26 against 13.7, roughly 11x.
  const meanGradient = (passes: number) => {
    const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(1));
    dish.seedTerrain(20, new Rng(99), passes);

    const { width, height } = DEFAULT_PARAMS;
    let sum = 0;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        // Neighbour slot 5 is (x+1, y) in the macros' layout: d / 3 picks the
        // row and d % 3 the column, so slot 4 is the cell itself.
        const right = wrapX(5, x, width) * height + wrapY(5, y, height);
        sum += Math.abs(dish.terrainAt(x * height + y) - dish.terrainAt(right));
      }
    }
    return sum / CELLS;
  };

  const spiky = meanGradient(0);
  const rolling = meanGradient(2);
  assert.ok(rolling > 0, 'there must be some gradient left to climb');
  assert.ok(
    rolling < spiky / 4,
    `blurred ground should be far smoother than white noise (${rolling} vs ${spiky})`,
  );
});

test('elevation stays inside the signed byte under both sensory models', () => {
  // The invariant the clamp exists for, checked over a real run rather than
  // argued. It is not what exercises the clamp — reaching an edge needs 126
  // deposits onto one cell — but it would catch a path that wrote terrain
  // directly and skipped the bound, which is the mistake this replaced.
  for (const senseModel of [SenseModel.SIGHTED, SenseModel.AS_SHIPPED]) {
    const dish = run(600, { senseModel }, 31);
    for (let hash = 0; hash < CELLS; hash++) {
      const e = dish.terrainAt(hash);
      assert.ok(e >= TERRAIN_MIN && e <= TERRAIN_MAX, `${senseModel} cell ${hash} holds ${e}`);
    }
  }
});

test('a seed fixes the whole trajectory', () => {
  assert.equal(snapshot(run(200, {}, 5)), snapshot(run(200, {}, 5)));
  assert.notEqual(snapshot(run(200, {}, 5)), snapshot(run(200, {}, 6)));
});

/** findViewColorAt's ENERGY branch, restated so this test can disagree with it. */
function energyColour(energy: number): number {
  return (
    Math.trunc(
      ((MAX_BUG_COLOR - 1) * (energy - DEFAULT_PARAMS.minEnergy)) /
        (DEFAULT_PARAMS.maxEnergy - DEFAULT_PARAMS.minEnergy),
    ) + 1
  );
}

/**
 * setParams: the one way a world's rules can change without being rebuilt.
 *
 * Upstream's Settings dialog rebuilt the struct and copied it, so which fields
 * took effect was decided by whether the step phase happened to read them. The
 * tests below hold the port to the reported contract instead: live fields change
 * behaviour on the next tick, per-bug fields reach the next generation, fields the
 * constructor owns are refused outright, and an invalid set changes nothing at all.
 */

function firstBug(dish: PetriDish): Bug {
  let found: Bug | undefined;
  dish.forEachBug((bug) => {
    found ??= bug;
  });
  assert.ok(found !== undefined, 'the fixture must contain a bug');
  return found;
}

function countPoisoned(dish: PetriDish): number {
  let poisoned = 0;
  for (let hash = 0; hash < CELLS; hash++) if (dish.isPoisoned(hash)) poisoned++;
  return poisoned;
}

test('setParams makes a live field live, in both directions', () => {
  // minBugEnergy is read by balance() on every tick, which makes it the cleanest
  // field to prove liveness with: lower it and the top-ups stop, raise it and they
  // start again. Both directions, because a one-way test can pass for the wrong
  // reason — a world with no bugs has nothing to top up either.
  const dish = run(300);
  const injectedAtStart = dish.injected;
  assert.ok(injectedAtStart > 0, 'the default world is topped up as it establishes itself');

  assert.deepEqual(dish.setParams({ minBugEnergy: 0 }).applied, ['minBugEnergy']);
  for (let i = 0; i < 100; i++) dish.step();
  assert.equal(dish.injected, injectedAtStart, 'a lowered minimum stops the top-ups');

  // A raised minimum needs energy to hand out. Deaths have been returning it to
  // the undistributed pool while the minimum was zero, and the fixture needs at
  // least one top-up's worth of headroom or this test cannot fail.
  const headroom = dish.totalEnergy - dish.bugEnergy - dish.energyEnergy;
  assert.ok(headroom >= DEFAULT_PARAMS.maxEnergy, `fixture needs headroom, has ${headroom}`);

  // One above the current income, so the loop must fire at least once.
  const update = dish.setParams({ minBugEnergy: dish.bugEnergy + 1 });
  assert.deepEqual(update.applied, ['minBugEnergy']);
  assert.deepEqual(update.refused, []);

  dish.step();
  assert.ok(
    dish.injected > injectedAtStart,
    'the raised minimum must reach balance() on the next tick — a setParams that ' +
      'stored the struct without the step reading it leaves this unchanged',
  );
});

test('setParams refuses an inverted range atomically', () => {
  const dish = run(100);
  const before = dish.worldParams;

  // minEnergy above maxEnergy is the pair the energy view divides by, and the
  // moveEnergy beside it is perfectly valid on its own.
  const update = dish.setParams({ minEnergy: 900, moveEnergy: 7 });

  assert.equal(update.refused.length, 1);
  assert.match(update.refused[0], /minEnergy \(900\) must be below maxEnergy \(800\)/);
  assert.deepEqual(update.applied, [], 'a refused call applies nothing');
  assert.deepEqual(dish.worldParams, before, 'and leaves the world exactly as it was');
  assert.equal(
    dish.worldParams.moveEnergy,
    before.moveEnergy,
    'the valid half of a refused set must not leak in',
  );
});

test('setParams defers per-bug fields to the next generation', () => {
  const dish = run(600);
  const living = firstBug(dish);
  assert.equal(living.processor.stepsPerUpdate, DEFAULT_PARAMS.stepsPerUpdate);

  const update = dish.setParams({ stepsPerUpdate: 8 });
  assert.deepEqual(update.deferred, ['stepsPerUpdate']);
  assert.deepEqual(update.applied, []);

  // Nobody alive is rebuilt: a Processor takes its budget at construction and has
  // no setter, so the living generation keeps the one it was built with.
  const now = new Set<number>();
  dish.forEachBug((bug) => now.add(bug.processor.stepsPerUpdate));
  assert.deepEqual([...now], [DEFAULT_PARAMS.stepsPerUpdate]);

  // The next bug into the world — born or topped up — is built with the new one.
  const before = new Set<Bug>();
  dish.forEachBug((bug) => before.add(bug));

  let newcomer: Bug | undefined;
  for (let i = 0; i < 300 && newcomer === undefined; i++) {
    dish.step();
    dish.forEachBug((bug) => {
      if (!before.has(bug)) newcomer ??= bug;
    });
  }

  assert.ok(newcomer !== undefined, 'no bug arrived within 300 ticks — fixture too quiet');
  assert.equal(newcomer.processor.stepsPerUpdate, 8);
  assert.equal(
    living.processor.stepsPerUpdate,
    DEFAULT_PARAMS.stepsPerUpdate,
    'and the bug that was alive at the change still has its own',
  );
});

test('setParams ignores fields the constructor owns, without half-applying them', () => {
  const dish = run(100);
  const poisonedBefore = countPoisoned(dish);

  const update = dish.setParams({ width: 10, height: 10, poison: 999 });

  assert.deepEqual(update.ignored.sort(), ['height', 'poison', 'width']);
  assert.deepEqual(update.applied, []);
  assert.deepEqual(update.deferred, []);
  assert.equal(dish.width, DEFAULT_PARAMS.width, 'the grid keeps its shape');
  assert.equal(dish.viewCol.length, CELLS);
  assert.equal(countPoisoned(dish), poisonedBefore, 'and no cells were poisoned');

  // The half that matters: a naive merge stores what it was given, so every later
  // reader of params.width disagrees with the grid it describes.
  assert.equal(dish.worldParams.width, DEFAULT_PARAMS.width);
  assert.equal(dish.worldParams.height, DEFAULT_PARAMS.height);
  assert.equal(dish.worldParams.poison, DEFAULT_PARAMS.poison);
});

test('forEachBug yields the whole population, stacked cells included', () => {
  // Bugs do share cells, but only a handful at a time and not at any particular
  // tick, so the walk is held to its invariant on every tick until one appears
  // rather than at a step count that happened to work.
  const dish = run(120);
  const seen = new Set<Bug>();
  let count = 0;
  let tickOfSharedCell = -1;

  for (let tick = 1; tick <= 600 && tickOfSharedCell < 0; tick++) {
    dish.step();

    count = 0;
    let misplaced = 0;
    let stackedBugs = 0;
    seen.clear();
    dish.forEachBug((bug, hash) => {
      count++;
      if (seen.has(bug)) misplaced++;
      seen.add(bug);
      const here = dish.bugsAt(hash);
      if (!here.includes(bug)) misplaced++;
      if (here.length > 1) stackedBugs++;
    });

    assert.equal(
      count,
      dish.population,
      `walk disagreed with the population counter at tick ${tick}`,
    );
    assert.equal(misplaced, 0, `a bug was misplaced in the walk at tick ${tick}`);
    if (stackedBugs > 0) tickOfSharedCell = tick;
  }

  assert.ok(
    tickOfSharedCell > 0,
    'no cell was shared within 600 ticks, so the inner loop over a cell never ran',
  );
  assert.equal(dish.checkIntegrity().bugCount, count, 'the independent walk agrees');
});

test('injected counts balance() top-ups — and the world has no other source', () => {
  // The counter exists to separate top-ups from reproduction, and the difference
  // turns out to be most of the world's turnover: balance() is the only way bugs
  // arrive in the first place. With the minimum set to zero nothing is ever added,
  // and because a world with no bugs cannot reproduce, it stays empty.
  const barren = run(300, { minBugEnergy: 0 });
  assert.equal(barren.injected, 0);
  assert.equal(barren.population, 0, 'no bugs, no births, no population');
  assert.equal(barren.births, 0);

  const world = run(300);
  assert.ok(world.injected > 0, 'a world held at its minimum is topped up repeatedly');
  assert.ok(world.births > 0, 'and it reproduces as well');
  assert.ok(
    world.injected > world.births,
    `top-ups dominate the turnover: ${world.injected} injected against ${world.births} born`,
  );
});
