/**
 * Why do bugs die, and where does the energy go?
 *
 * The question came out of a stall report: a world whose population never
 * recovers. Before blaming the rules it is worth knowing what the rules actually
 * kill bugs for — the balance() counter shows the population is mostly injectate,
 * so the death rate is what decides whether injectate can ever be replaced by
 * offspring.
 *
 * Attribution has to happen at the move phase, and that is a fact about the sim
 * rather than a convenience. A direction is not known until the bug's VM has run,
 * and the VM runs inside doEatingAndSeeing — earlier in the SAME tick than the
 * death check. A probe that watches only tick boundaries therefore holds a stale
 * direction for every bug that died, and the first version of this tool was wrong
 * that way: it could name 94.8% of deaths and had to shrug at the remaining 5.2%,
 * whose only distinguishing feature was that their direction had changed since the
 * previous tick. The fix is to read the bugs' state immediately after
 * doEatingAndSeeing returns for their cell, which is exactly what the death check
 * reads: post-eat energy, post-VM direction, post-increment age.
 *
 * The probe hooks a private method to do that. It is the only place the branch is
 * visible at all: the move phase removes a bug and says nothing about which clause
 * did it, and two of the four clauses are the mutually-exclusive outcome of one
 * decision (where the bug tried to go). The classifier therefore repeats the port's
 * expression rather than re-deriving it, including the poison test at the bug's
 * DESTINATION (`poison[nx * height + ny]`, upstream petri_dish.cpp:744) and the
 * precedence of the bounds clause over it, which upstream's `||` chain also gives.
 *
 * Two controls, both of which can fail:
 *   - `unexplained` must be 0. A death the classifier cannot name means the
 *     classifier is wrong or a fifth removal path exists.
 *   - `attributed` must equal dish.deaths, an independent count kept by the sim.
 *
 *   node dist/tools/death-cause-probe.mjs [ticks] [seed]
 */

import { offX, offY, PetriDish, wrapX, wrapY } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, type WorldParams } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import { DIR_STAY, type Bug } from '../src/sim/bug.js';

interface State {
  energy: number;
  age: number;
  dir: number;
  hash: number;
}

type Cause = 'age' | 'energy' | 'leftGrid' | 'poison' | 'unexplained';

const CAUSES: readonly Cause[] = ['age', 'energy', 'leftGrid', 'poison', 'unexplained'];

/** State of every bug that reached this tick's move phase, keyed by identity. */
let midTick = new Map<Bug, State>();

const eatAndSee = (
  PetriDish.prototype as unknown as { doEatingAndSeeing(hash: number): void }
).doEatingAndSeeing;

(
  PetriDish.prototype as unknown as { doEatingAndSeeing(hash: number): void }
).doEatingAndSeeing = function (this: PetriDish, hash: number): void {
  eatAndSee.call(this, hash);
  // Returns having fed every bug in the cell, run its VM and aged it. The move
  // phase will then read exactly these fields.
  for (const bug of this.bugsAt(hash)) {
    midTick.set(bug, { energy: bug.energy, age: bug.age, dir: bug.dir, hash });
  }
};

/** The port's own move-phase expression, clause for clause, in its own order. */
function classify(dish: PetriDish, p: WorldParams, s: State): Cause {
  const x = Math.trunc(s.hash / dish.height);
  const y = s.hash % dish.height;

  let nx: number;
  let ny: number;
  let moveCost: number;

  if (s.dir === DIR_STAY) {
    moveCost = p.stayEnergy;
    nx = x;
    ny = y;
  } else if (p.killOnEdge) {
    nx = offX(s.dir, x);
    ny = offY(s.dir, y);
    moveCost = p.moveEnergy;
  } else {
    nx = wrapX(s.dir, x, dish.width);
    ny = wrapY(s.dir, y, dish.height);
    moveCost = p.moveEnergy;
  }

  if (s.age >= p.maxAge) return 'age';
  if (s.energy - moveCost < p.minEnergy) return 'energy';
  if (nx < 0 || nx >= dish.width || ny < 0 || ny >= dish.height) return 'leftGrid';
  if (dish.isPoisoned(nx * dish.height + ny)) return 'poison';
  return 'unexplained';
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.trunc(s.length / 2)];
};

function run(label: string, ticks: number, seed: number, overrides: Partial<WorldParams>): void {
  const p = { ...DEFAULT_PARAMS, ...overrides };
  const dish = new PetriDish(p, new Rng(seed));

  const counts: Record<Cause, number> = { age: 0, energy: 0, leftGrid: 0, poison: 0, unexplained: 0 };
  const energies: Record<Cause, number[]> = { age: [], energy: [], leftGrid: [], poison: [], unexplained: [] };
  const allEnergies: number[] = [];
  const allAges: number[] = [];
  let populationSum = 0;
  let sawTheWholeMovePhase = 0;

  for (let t = 0; t < ticks; t++) {
    midTick = new Map();
    dish.step();
    populationSum += dish.population;

    const alive = new Set<Bug>();
    dish.forEachBug((bug) => alive.add(bug));

    // Every bug in midTick reached the move phase. Bugs absent from `alive` were
    // removed there — the only other splice is a move, which re-adds the bug to
    // its destination cell and so keeps it visible.
    for (const [bug, state] of midTick) {
      sawTheWholeMovePhase++;
      if (alive.has(bug)) continue;
      const cause = classify(dish, p, state);
      counts[cause]++;
      energies[cause].push(state.energy);
      allEnergies.push(state.energy);
      allAges.push(state.age);
    }
  }

  const totalDeaths = CAUSES.reduce((a, c) => a + counts[c], 0);
  const meanPopulation = populationSum / ticks;

  console.log(`\n=== ${label} — ${ticks} ticks, seed ${seed} ===`);
  console.log(
    `params: minEnergy=${p.minEnergy} maxEnergy=${p.maxEnergy} childEnergy=${p.childEnergy} ` +
      `moveEnergy=${p.moveEnergy} killOnEdge=${String(p.killOnEdge)}`,
  );
  console.log(
    `        totalEnergy=${p.totalEnergy} minBugEnergy=${p.minBugEnergy} ` +
      `minEnergyEnergy=${p.minEnergyEnergy} poison=${p.poison} maxAge=${p.maxAge}`,
  );
  console.log(
    `population=${dish.population} meanPopulation=${meanPopulation.toFixed(1)} ` +
      `maxGen=${dish.maxGen} births=${dish.births} injected=${dish.injected}`,
  );
  console.log(
    `attributed=${totalDeaths} (dish.deaths=${dish.deaths})  ` +
      `${totalDeaths === dish.deaths ? 'MATCH' : '*** MISMATCH ***'}` +
      `   [state captured for ${sawTheWholeMovePhase} bug-ticks]`,
  );

  for (const cause of CAUSES) {
    const n = counts[cause];
    const share = totalDeaths === 0 ? 0 : (100 * n) / totalDeaths;
    console.log(
      `  ${cause.padEnd(12)} ${String(n).padStart(7)}  ${share.toFixed(1).padStart(5)}%` +
        `  energy at death: median ${String(median(energies[cause])).padStart(4)}` +
        ` mean ${mean(energies[cause]).toFixed(0).padStart(4)}`,
    );
  }
  if (counts.unexplained !== 0) {
    console.log('  *** UNEXPLAINED IS NOT ZERO — the attribution above is not to be trusted ***');
  }

  console.log(
    `deaths per bug-tick: ${(totalDeaths / Math.max(1, populationSum)).toFixed(5)}` +
      `   (${meanPopulation.toFixed(1)} bugs alive on average)`,
  );
  console.log(
    `energy held at death: median ${median(allEnergies)} mean ${mean(allEnergies).toFixed(0)}` +
      `   age at death: median ${median(allAges)} mean ${mean(allAges).toFixed(1)} against maxAge=${p.maxAge}`,
  );

  // bugTotal is upstream's cached per-cell total of its bugs' energy, and it is a
  // carried-over defect: energy handed to bugs is never credited back (DIVERGENCES.md
  // §14), so the cache only ever falls behind the bugs it describes. Summed over every
  // cell, including the empty ones the drift leaves negative.
  let summedBugTotal = 0;
  for (let h = 0; h < dish.width * dish.height; h++) summedBugTotal += dish.bugTotalAt(h);

  const report = dish.checkIntegrity();
  console.log(
    `integrity: bugs ${report.bugCount} carrying ${report.summedBugEnergy} (counter ${report.bugEnergy}),` +
      ` grid ${report.summedCellEnergy} (counter ${report.energyEnergy}),` +
      ` anomalies=${report.listedButEmpty + report.unlistedOccupied + report.overfullBugs + report.underfullBugs}`,
  );
  // bugEnergy + energyEnergy can never exceed totalEnergy — a test asserts it — so a
  // split that does means the split came from the wrong fields and the run is void.
  console.log(
    `world energy: bugs ${dish.bugEnergy} + grid ${dish.energyEnergy} = ` +
      `${dish.bugEnergy + dish.energyEnergy} of total ${p.totalEnergy}`,
  );
  console.log(
    `bugTotal cache: ${summedBugTotal} against the bugs' real ${report.summedBugEnergy}` +
      ` — drift ${summedBugTotal - report.summedBugEnergy}`,
  );
}

const ticks = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? 2024);

run('default (minEnergy 20, killOnEdge)', ticks, seed, {});
run('floor 5', ticks, seed, { minEnergy: 5 });
run('wrap instead of edge death', ticks, seed, { killOnEdge: false });
