/**
 * Initial population vs re-seeded population, in the same flat world.
 *
 * Scott's framing: the world does replicate and evolve for a while, so it *is*
 * self-sustaining; the failure is that after a die-off the re-seeded bugs never
 * find a configuration that survives again. That is a claim about an asymmetry
 * between the first seeding and later ones — either the bugs differ, or the
 * world does.
 *
 * The bug side is settled by reading the code: balance() calls Bug.createRandom()
 * for every injection, which draws a fresh random genome of fresh random length
 * with generation 0. There is no pool, no reuse, no inheritance.
 *
 * The world side used to be the interesting half: terrain was the one thing a
 * lived-in world carried that a fresh one did not. The world has no terrain any
 * more (DIVERGENCES.md §9), so what remains is the energy state and the RNG
 * stream positions. If the re-seeded ecology still differs from the initial one,
 * the world's shape is not the reason.
 *
 * Two phases, measured the same way:
 *
 *   A. fresh world, N ticks      -> the initial ecology
 *   B. force a die-off, then N   -> the re-seeded ecology, same world
 *
 * A forced die-off is a clean instrument: with maxAge 0 every bug fails
 * `age >= max_age` on the next step and is removed, and balance() then re-seeds
 * within that same step, so the bugs in B are indistinguishable from the ones a
 * real crash would leave — fresh random genome, generation 0, dropped into a
 * world that has already been lived in.
 *
 * Run:  node dist/tools/reseed-probe.mjs [stepsPerPhase] [seed]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const phaseSteps = Number(process.argv[2] ?? 15_000);
const seed = Number(process.argv[3] ?? 2024);

const params = { ...DEFAULT_PARAMS };
const dish = new PetriDish(params, new Rng(seed));

interface Ecology {
  pop: number;
  cells: number;
  paired: number;
  gen0: number;
  maxGen: number;
  meanEnergy: number;
  gridEnergy: number;
}

function ecology(): Ecology {
  const { width, height } = dish;
  let pop = 0;
  let gen0 = 0;
  let maxGen = 0;
  let energySum = 0;
  let gridEnergy = 0;
  const perCell = new Map<number, number>();
  dish.forEachBug((bug, hash) => {
    pop++;
    energySum += bug.energy;
    if (bug.generation === 0) gen0++;
    if (bug.generation > maxGen) maxGen = bug.generation;
    perCell.set(hash, (perCell.get(hash) ?? 0) + 1);
  });
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) gridEnergy += dish.energyAt(x * height + y);
  }
  let paired = 0;
  for (const [, n] of perCell) if (n >= 2) paired++;
  return {
    pop,
    cells: perCell.size,
    paired,
    gen0,
    maxGen,
    meanEnergy: pop ? energySum / pop : 0,
    gridEnergy,
  };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);

function runPhase(label: string, steps: number): void {
  console.log('');
  console.log(`--- ${label} ---`);
  console.log('      t    pop  cells  pairs    born   died    inj   b/d  gen0%  maxGen   meanE   gridE');
  let born = 0;
  let died = 0;
  let injected = 0;
  let peakPop = 0;
  let peakAt = 0;
  for (let t = 1; t <= steps; t++) {
    const b0 = dish.births;
    const d0 = dish.deaths;
    const i0 = dish.injected;
    dish.step();
    born += dish.births - b0;
    died += dish.deaths - d0;
    injected += dish.injected - i0;

    const e = ecology();
    if (e.pop > peakPop) {
      peakPop = e.pop;
      peakAt = dish.time;
    }

    // Dense sampling while the world is establishing itself, sparse afterwards.
    const every = t <= 2000 ? 250 : 1000;
    if (t % every === 0) {
      const ratio = died > 0 ? born / died : 0;
      console.log(
        `${pad(dish.time, 7)}${pad(e.pop, 7)}${pad(e.cells, 7)}${pad(e.paired, 7)}` +
          `${pad(born, 7)}${pad(died, 7)}${pad(injected, 7)}${pad(ratio.toFixed(2), 6)}` +
          `${pad(e.pop ? ((100 * e.gen0) / e.pop).toFixed(0) : '0', 7)}${pad(e.maxGen, 8)}` +
          `${pad(e.meanEnergy.toFixed(0), 8)}${pad(e.gridEnergy, 8)}`,
      );
      born = 0;
      died = 0;
      injected = 0;
    }
  }
  console.log(`  peak population ${peakPop} at t=${peakAt}`);
}

runPhase('A: fresh world (the initial seeding)', phaseSteps);

// One step at maxAge 0 kills every bug; balance() re-seeds in the same step.
dish.setParams({ ...params, maxAge: 0 });
dish.step();
dish.setParams({ ...params, maxAge: params.maxAge });
const after = ecology();
console.log('');
console.log(
  `forced die-off at t=${dish.time}: pop ${after.pop}, gen0 ${after.gen0} (all injected at this instant)`,
);

runPhase('B: same world, re-seeded (the reported failure case)', phaseSteps);
