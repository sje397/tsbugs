/**
 * The logic audit: does the world stay internally consistent while it runs?
 *
 * `check_integrity()` covers the counters the original warns about — population,
 * cell totals, and whether a cell is listed or holds bugs but not both. That is
 * four questions. This asks the rest of them, every tick, and treats a single
 * disagreement as a failure rather than a statistic.
 *
 * WHY IT CAN FAIL. Every check below is a property the model CLAIMS, either in a
 * comment or by construction:
 *
 *   - bugEnergy is the bugs' real total, maintained separately from them. If the
 *     two diverge, one of the six paths that move energy between a bug and the
 *     world has the wrong sign or the wrong amount, and every downstream number
 *     (the budget in balance(), the panel, the equilibrium) is measuring a
 *     counter rather than the world.
 *   - energyEnergy is the ground's real total, same argument.
 *   - population == injected + births - deaths. Every bug either arrived from
 *     balance() or was born, and every departure is a death. A world where this
 *     fails has a bug that appeared or vanished without a counter noticing.
 *   - the energy CEILING. `total_energy` is not an endowment, and reading it as
 *     one is the first mistake this probe made. balance() tops the world up to
 *     `totalEnergy - bugEnergy - energyEnergy` at the end of every tick, so the
 *     budget a death frees is immediately re-allocatable: the world is a flow,
 *     not a stock, which is why it is not dying of entropy. The property that
 *     does hold, and the one worth guarding, is that a tick never stands above
 *     the ceiling: `bugEnergy + energyEnergy <= totalEnergy`, always.
 *
 *     (The version of this probe that treated the budget as a finite endowment
 *     reported a world "creating energy from nothing" on tick 1 of every run.
 *     It was reporting a falsehood about the world and a true one about the
 *     model it had in its head.)
 *   - a living bug is inside its own limits: age below max_age, energy between
 *     min_energy and max_energy, a register set that indexes its own arrays, and
 *     a genome the same length as the program it runs.
 *
 * WHAT IT CANNOT SEE. The two dropped-energy paths are measured as one residual,
 * so this can prove no energy was invented and cannot say how much was thrown
 * away by which. `energySubmerged` is a local inside doEatingAndSeeing with no
 * observer, and inventing one would mean editing the thing under audit.
 *
 *   node dist/tools/audit-probe.mjs [ticks] [seed]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, EnergyLayout, type WorldParams } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import type { Bug } from '../src/sim/bug.js';

interface Hidden {
  removeBug: (e: number, hash: number) => void;
  energy: Int32Array;
  cells: Map<number, Bug[]>;
  activeCells: number[];
}

interface Anomaly {
  tick: number;
  what: string;
}

function deepCheck(dish: PetriDish, tick: number): Anomaly[] {
  const hidden = dish as unknown as Hidden;
  const found: Anomaly[] = [];
  const add = (what: string): void => {
    found.push({ tick, what });
  };

  const seen = new Set<Bug>();
  let bugCount = 0;
  let summedBugEnergy = 0;
  let summedCellEnergy = 0;
  let onPoison = 0;
  let underfull = 0;
  let overfull = 0;
  let tooOld = 0;
  let badRegisters = 0;
  let badProgram = 0;

  for (const [hash, bugs] of hidden.cells) {
    if (bugs.length === 0) continue;
    if (dish.isPoisoned(hash)) onPoison += bugs.length;
    for (const bug of bugs) {
      if (seen.has(bug)) add(`the same bug object is in two cells (at ${hash})`);
      seen.add(bug);
      bugCount++;
      summedBugEnergy += bug.energy;
      if (bug.energy < dish.worldParams.minEnergy) underfull++;
      if (bug.energy > dish.worldParams.maxEnergy) overfull++;
      if (bug.age >= dish.worldParams.maxAge) tooOld++;

      const { ip, sp, bp } = bug.processor.state;
      if (ip >= bug.processor.programLength || sp > bug.processor.stackSize || bp > sp || sp < 0 || bp < 0) {
        badRegisters++;
      }
      if (bug.processor.programLength !== bug.dna.size) badProgram++;
    }
  }

  for (let hash = 0; hash < hidden.energy.length; hash++) summedCellEnergy += hidden.energy[hash];

  // The counters, against the world they count.
  if (bugCount !== dish.population) add(`population ${dish.population} but ${bugCount} bugs`);
  if (summedBugEnergy !== dish.bugEnergy) add(`bugEnergy ${dish.bugEnergy} but bugs hold ${summedBugEnergy}`);
  if (summedCellEnergy !== dish.energyEnergy) {
    add(`energyEnergy ${dish.energyEnergy} but ground holds ${summedCellEnergy}`);
  }
  if (dish.population !== dish.injected + dish.births - dish.deaths) {
    add(
      `population ${dish.population} but ${dish.injected} injected + ${dish.births} born - ${dish.deaths} dead = ` +
        `${dish.injected + dish.births - dish.deaths}`,
    );
  }

  // The cell index, against the map it indexes.
  const listed = new Set(hidden.activeCells);
  if (listed.size !== hidden.activeCells.length) add('activeCells holds a duplicate hash');
  if (hidden.activeCells.length !== [...hidden.cells.values()].filter((b) => b.length > 0).length) {
    add(`activeCells lists ${hidden.activeCells.length} cells but ${[...hidden.cells.values()].filter((b) => b.length > 0).length} hold bugs`);
  }
  for (const hash of hidden.activeCells) {
    const bugs = hidden.cells.get(hash);
    if (bugs === undefined || bugs.length === 0) add(`active cell ${hash} holds no bugs`);
  }

  if (onPoison) add(`${onPoison} bugs stand on poisoned cells`);
  if (underfull) add(`${underfull} bugs are below min_energy`);
  if (overfull) add(`${overfull} bugs are above max_energy`);
  if (tooOld) add(`${tooOld} bugs are at or past max_age`);
  if (badRegisters) add(`${badRegisters} bugs have a register that indexes nothing`);
  if (badProgram) add(`${badProgram} bugs have a genome and program of different lengths`);

  return found;
}

function run(ticks: number, seed: number, overrides: Partial<WorldParams>): void {
  const params: WorldParams = { ...DEFAULT_PARAMS, ...overrides };
  const rng = new Rng(seed);
  const dish = new PetriDish(params, rng);

  // Every path that removes energy from a bug leaves through removeBug, so
  // shadowing it is how the audit sees what the world discarded.
  let cededEnergy = 0;
  let deaths = 0;
  const hidden = dish as unknown as Hidden;
  const realRemove = hidden.removeBug.bind(dish);
  hidden.removeBug = (e: number, hash: number): void => {
    cededEnergy += e;
    deaths++;
    realRemove(e, hash);
  };

  const anomalies: Anomaly[] = [];
  let peakPopulation = 0;
  let peakGen = 0;
  let peakStanding = 0;

  for (let tick = 0; tick < ticks; tick++) {
    dish.step();
    const found = deepCheck(dish, tick);
    anomalies.push(...found);
    if (deaths !== dish.deaths) {
      anomalies.push({ tick, what: `removeBug ran ${deaths} times, deaths counter says ${dish.deaths}` });
    }

    const standing = dish.bugEnergy + dish.energyEnergy;
    if (standing > params.totalEnergy) {
      anomalies.push({
        tick,
        what: `standing energy ${standing} is above the ${params.totalEnergy} ceiling`,
      });
    }
    if (standing > peakStanding) peakStanding = standing;
    if (dish.population > peakPopulation) peakPopulation = dish.population;
    if (dish.maxGen > peakGen) peakGen = dish.maxGen;

    if (anomalies.length > 20) break;
  }

  const label = `${params.width}x${params.height} seed ${seed} ${ticks} ticks`;
  if (anomalies.length === 0) {
    console.log(
      `${label}: clean. population ${dish.population} (peak ${peakPopulation}), ` +
        `injected ${dish.injected} born ${dish.births} dead ${dish.deaths}, ` +
        `maxGen ${peakGen}, peak standing energy ${peakStanding}/${params.totalEnergy}, ` +
        `ceded by death ${cededEnergy}`,
    );
  } else {
    console.log(`${label}: ${anomalies.length} anomalies`);
    for (const a of anomalies) console.log(`  tick ${a.tick}: ${a.what}`);
    process.exitCode = 1;
  }
}

const ticks = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1234);
const layoutArg = process.argv[4];

if (layoutArg === 'layouts') {
  for (const layout of [
    EnergyLayout.RANDOM, EnergyLayout.DOT, EnergyLayout.TWODOTS, EnergyLayout.RING,
    EnergyLayout.RECT, EnergyLayout.MANYDOTS, EnergyLayout.CHANGE,
  ] as const) {
    run(ticks, seed, { energyLayout: layout });
  }
} else if (layoutArg !== undefined) {
  run(ticks, seed, { energyLayout: Number(layoutArg) as EnergyLayout });
} else {
  run(ticks, seed, {});
}
