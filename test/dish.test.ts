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
  offX,
  offY,
  PetriDish,
  senseByte,
  ViewMode,
  wrapX,
  wrapY,
} from '../src/sim/dish.js';
import {
  DEFAULT_PARAMS,
  EnergyLayout,
  MAX_BUG_COLOR,
  type WorldParams,
} from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import { Bug } from '../src/sim/bug.js';
import { INPUTS } from '../src/sim/processor.js';

const CELLS = DEFAULT_PARAMS.width * DEFAULT_PARAMS.height;

const ALL_VIEW_MODES = [
  ViewMode.DEFAULT,
  ViewMode.BUGS,
  ViewMode.ENERGY,
  ViewMode.AGE,
  ViewMode.DNA_SIZE,
  ViewMode.DNA_VALUE,
];

function run(steps: number, overrides: Partial<WorldParams> = {}, seed = 1234): PetriDish {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, ...overrides }, new Rng(seed));
  for (let i = 0; i < steps; i++) dish.step();
  return dish;
}

/**
 * Everyone alive, by genome (as hex) and by identity, with the top generation.
 *
 * Holding the Bug references is the point: a die-off leaves them unreachable from
 * the dish, so if one of them is alive again afterwards it was returned by
 * something rather than created.
 */
function census(dish: PetriDish): { genomes: Set<string>; bugs: Set<Bug>; maxGeneration: number } {
  const genomes = new Set<string>();
  const bugs = new Set<Bug>();
  let maxGeneration = 0;
  dish.forEachBug((bug) => {
    genomes.add(Buffer.from(bug.dna.data).toString('hex'));
    bugs.add(bug);
    if (bug.generation > maxGeneration) maxGeneration = bug.generation;
  });
  return { genomes, bugs, maxGeneration };
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
  {
    const dish = run(400, {}, 4242);
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

// ------------------------------------------------------- the sensory layout
//
// DIVERGENCES.md §13. The VM has 20 inputs: colour 0-8, grid energy 9-17, and the
// bug's own energy as a little-endian pair at 18-19. Upstream had 29, with a
// nine-slot altitude group in the middle that this world has nothing to put in.
// The numbers are pinned rather than left to be derived from constants, because a
// slot index is the genome's interface: moving one silently changes what every
// program means.

test('a bug fills colour, energy and its own energy, at the pinned slots', () => {
  assert.equal(INPUTS, 20, 'the input layout changed size');

  const bug = Bug.createRandom(DEFAULT_PARAMS, new Rng(1));
  bug.energy = 1234;
  bug.update();

  // The VM reads `in` and never writes it, so these survive the 64 steps update()
  // runs. 1234 = 4 * 256 + 210.
  assert.equal(bug.processor.readIn(18), 4, 'own energy, high byte');
  assert.equal(bug.processor.readIn(19), 210, 'own energy, low byte');
});

test('the energy window carries a real 3x3 reading, not one value repeated', () => {
  // This is the integration-level guard for §1: the shipped build passed the
  // altitude array where the energy array belonged, so nine slots read as the
  // same value (or as nothing at all). Any return of that shape fails here.
  const dish = run(400, {}, 77);
  const energy = new Set<number>();
  const vision = new Set<number>();
  let bugs = 0;
  let nonUniform = 0;

  dish.forEachBug((bug) => {
    bugs++;
    const first = bug.processor.readIn(9);
    let varies = false;
    for (let d = 0; d < 9; d++) {
      const reading = bug.processor.readIn(9 + d);
      energy.add(reading);
      if (reading !== first) varies = true;
    }
    if (varies) nonUniform++;
    for (let d = 0; d < 9; d++) vision.add(bug.processor.readIn(d));
  });

  assert.ok(bugs > 50, `the fixture must contain bugs to sense (${bugs})`);
  assert.ok(energy.size > 1, 'the energy channel must differ across the world');
  assert.ok(nonUniform > 0, 'at least one bug must see a gradient rather than a flat window');
  assert.ok(
    vision.size > 1,
    `control: the same probe sees the vision channel vary (${vision.size} distinct readings)`,
  );
});

test('a sensory reading saturates at both ends instead of wrapping (upstream UB)', () => {
  // senseByte is upstream's float -> unsigned char conversion with the edge
  // behaviour pinned: the caller scales a value into 0..255 first, and the upper
  // edge is reachable in ordinary play because energy deposits are additive with
  // no cap. Energy is the only caller now that terrain is gone (DIVERGENCES.md
  // §12), so the divisors below are explicit rather than read from a constant the
  // two channels used to share.
  //
  // The failure mode is not merely arbitrary. Wrapped mod 256, a reading of -1
  // comes back as 255, near-maximum, which inverts the signal the VM evolves
  // against rather than blurring it.
  const M = 10; // an arbitrary divisor: the scaling must not depend on which one

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

// ------------------------------------------------------- view ramps
//
// The one thing that outlived the terrain feature in the view code: the ramps
// saturate rather than wrapping — upstream's `unsigned char` return, fixed, and it
// applies to every view mode rather than only the one that used to show ground
// (DIVERGENCES.md §9).

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

test('setParams defers mutation, because only a new Dna reads it', () => {
  const dish = run(400);
  const living = firstBug(dish);
  const rateWas = living.dna.mutationRate;

  const update = dish.setParams({ mutation: 0.125 });
  assert.deepEqual(update.deferred, ['mutation'], 'a rate the living generation ignores is not a live change');
  assert.deepEqual(update.applied, []);

  // Bug.createRandom/createChild copy params.mutation into a new Dna, and nothing
  // in the simulation ever writes to a living bug's rate, so the rate it was built
  // with is the rate it mutates at. Reported as live, this dial would have been
  // describing a rate no living bug was using.
  assert.equal(living.dna.mutationRate, rateWas);

  const known = new Set<Bug>();
  dish.forEachBug((bug) => known.add(bug));

  let newcomer: Bug | undefined;
  for (let i = 0; i < 400 && newcomer === undefined; i++) {
    dish.step();
    dish.forEachBug((bug) => {
      if (!known.has(bug)) newcomer ??= bug;
    });
  }

  assert.ok(newcomer !== undefined, 'no bug arrived within 400 ticks — fixture too quiet');
  assert.equal(newcomer.dna.mutationRate, 0.125, 'a bug born after the change is built with the new rate');
  assert.equal(living.dna.mutationRate, rateWas, 'and the bug that was alive at the change keeps its own');
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


test('balance() injects fresh founders — a die-off is not undone by recycling', () => {
  // Top-ups are most of the world's turnover (the test above), so what a top-up
  // IS decides whether a world can change at all. balance() calls
  // Bug.createRandom: a genome drawn from the rng, generation 0. It keeps no pool
  // of the dead, so a world that loses its population does not get that
  // population back — it gets strangers.
  //
  // That is exactly the difference between a world that can outgrow a bad genome
  // and one that cannot. Recycling would re-mint the dead, generation and all,
  // and the world would be pinned to whatever it last held no matter how often it
  // were refilled. So this asserts the two things a recycling implementation
  // breaks: the generation counter returning to zero, and every genome on the
  // grid being one that nobody had before.
  const dish = run(2000);
  const before = census(dish);
  assert.ok(
    before.maxGeneration > 0,
    'the world must have bred before the die-off, or there is nothing to inherit',
  );

  // maxAge 0 kills every bug: age >= 0 holds for all of them. The die-off and the
  // refill fall in the SAME tick — balance() runs last, and with no bug energy
  // left it puts a fresh population back immediately — so the census taken after
  // this step is entirely founders, and there is no empty tick to observe.
  const deathsBefore = dish.deaths;
  const injectedBefore = dish.injected;
  dish.setParams({ maxAge: 0 } satisfies Partial<WorldParams>);
  dish.step();
  const after = census(dish);

  assert.equal(dish.deaths - deathsBefore, before.bugs.size, 'every bug alive was killed');
  assert.ok(after.bugs.size > 0, 'and the world was refilled on the same tick');
  assert.equal(dish.injected - injectedBefore, dish.population, 'every arrival was an injection');
  assert.equal(after.maxGeneration, 0, 'founders are generation 0, not the dead population');
  assert.equal(dish.maxGen, 0, 'and the tick records no generation higher than they carry');

  for (const bug of before.bugs) {
    assert.ok(!after.bugs.has(bug), 'a bug that died is not alive again');
  }
  const recycled = [...after.genomes].filter((genome) => before.genomes.has(genome));
  assert.deepEqual(recycled, [], 'and no genome on the grid is one that had died');
});
