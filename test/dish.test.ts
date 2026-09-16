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

import { offX, offY, PetriDish, senseByte, ViewMode, wrapX, wrapY } from '../src/sim/dish.js';
import {
  BKG_COLOR,
  DEFAULT_PARAMS,
  ENERGY_COLOR,
  EnergyLayout,
  MAX_BUG_COLOR,
  MAX_TERRAIN,
  SenseModel,
  type WorldParams,
} from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

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
  // Upstream converts a float straight to unsigned char, which is undefined
  // behaviour outside 0..255 — and both edges are reachable in ordinary play:
  // bugs dig terrain negative, and energy deposits are additive with no cap.
  //
  // The failure mode is not merely arbitrary. Wrapped mod 256, terrain of -1
  // reads as 231/255 — near-maximum altitude — which inverts the signal the VM
  // evolves against rather than blurring it.
  const M = MAX_TERRAIN;

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
  let bareTerrain = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    if (dish.bugsAt(hash).length > 0) {
      withBugs++;
      assert.equal(
        dish.viewCol[hash],
        ENERGY_COLOR,
        `cell ${hash} holds a bug, so TERRAIN cannot show its terrain`,
      );
    } else if (dish.terrainAt(hash) === 1) {
      bareTerrain++;
      assert.equal(dish.viewCol[hash], BKG_COLOR);
    }
  }

  assert.ok(withBugs > 0, 'the fixture must contain bugs');
  assert.ok(bareTerrain > 0, 'the fixture must contain untouched terrain');
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
