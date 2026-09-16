/**
 * Does the ground stop reproduction, and if so at what roughness?
 *
 * Scott's report: at roughness 0 the world is lively, at anything above it the
 * bugs seem never to reproduce. Two candidate mechanisms, both checkable:
 *
 *   1. COST. A move costs `move_energy * (climb + 1)` (petri_dish.cpp:729-731,
 *      ported verbatim) and then `*= payload + 1` (:737, also verbatim). Seeded
 *      ground has far more relief than the bugs ever build themselves, so a step
 *      can cost an order of magnitude more than the default 2.
 *   2. THRESHOLD. Reproduction needs `energy >= child_energy + min_energy`
 *      (180 by default). If income per tick cannot outrun the cost of moving to
 *      reach it, no bug ever gets there.
 *
 * So: sweep roughness, and for each one report the mean cost of a step in that
 * world alongside the population's energy distribution and the birth rate. The
 * point is to separate "the bugs cannot afford to reproduce" from "the bugs are
 * not choosing to", which look identical from the outside and have opposite fixes.
 *
 * Run:  node dist/tools/repro-probe.mjs [steps] [seed]
 *
 * Passing a fourth argument prints a time series for that roughness instead of
 * the sweep, because the interesting question turned out to be about *time*, not
 * about the end state: if two worlds differ only in the first few hundred ticks,
 * a table of final numbers cannot see it, and a person watching the page for ten
 * seconds cannot see past it either.
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 3000);
const seed = Number(process.argv[3] ?? 2024);
const W = DEFAULT_PARAMS.width;
const H = DEFAULT_PARAMS.height;
const CELLS = W * H;
const ROUGHNESS = [0, 1, 2, 3, 5, 10, 20, 40];
/** Step 1 of the run is transient (the world starts empty and is topped up). */
const SETTLE = 500;
const pad = (v: number | string, w: number) => String(v).padStart(w);

/**
 * The mean cost of one step anywhere in this world.
 *
 * Sampled over every cell and its four neighbours, using the same branch the
 * move phase uses — so it is the average a bug actually pays, not a proxy.
 * Downhill is charged stay_energy (`climb < 0`), level or uphill is charged by
 * the step. Payload is excluded: it multiplies the result and a bug carrying
 * ground is a separate, visible case.
 */
function meanStepCost(dish: PetriDish): number {
  const stepEnergy = DEFAULT_PARAMS.stayEnergy;
  const moveEnergy = DEFAULT_PARAMS.moveEnergy;
  let total = 0;
  let n = 0;

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const hash = x * H + y;
      const here = dish.terrainAt(hash);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const climb = dish.terrainAt(nx * H + ny) - here;
        total += climb < 0 ? stepEnergy : moveEnergy * (climb + 1);
        n++;
      }
    }
  }
  return total / n;
}

/** Population energy distribution, and the terrain's relief. */
function survey(dish: PetriDish) {
  let minE = Number.MAX_SAFE_INTEGER;
  let maxE = 0;
  let canReproduce = 0;
  let carrying = 0;
  let bugs = 0;
  const need = DEFAULT_PARAMS.childEnergy + DEFAULT_PARAMS.minEnergy;

  for (let hash = 0; hash < CELLS; hash++) {
    for (const bug of dish.bugsAt(hash)) {
      bugs++;
      if (bug.energy < minE) minE = bug.energy;
      if (bug.energy > maxE) maxE = bug.energy;
      if (bug.energy >= need) canReproduce++;
      if (bug.payload > 0) carrying++;
    }
  }

  let tMin = 0;
  let tMax = 0;
  for (let hash = 0; hash < CELLS; hash++) {
    const e = dish.terrainAt(hash);
    if (e < tMin) tMin = e;
    if (e > tMax) tMax = e;
  }

  return {
    bugs,
    minE: bugs ? minE : 0,
    maxE,
    meanE: bugs ? Math.round(dish.bugEnergy / bugs) : 0,
    pctFertile: bugs ? Math.round((canReproduce / bugs) * 100) : 0,
    pctCarrying: bugs ? Math.round((carrying / bugs) * 100) : 0,
    tMin,
    tMax,
  };
}

const seriesRoughness = process.argv[4] === undefined ? null : Number(process.argv[4]);

if (seriesRoughness !== null) {
  const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(seed));
  if (seriesRoughness > 0) dish.seedTerrain(seriesRoughness, new Rng(seed + 1));

  console.log(`${steps} steps, seed ${seed}, roughness ${seriesRoughness}, sampled every 200`);
  console.log('   time   pop   gen  births  deaths  meanE  %>=180  stepcost');
  for (let t = 0; t <= steps; t++) {
    if (t > 0) dish.step();
    if (t % 200 !== 0) continue;
    const s = survey(dish);
    console.log(
      `${pad(dish.time, 7)} ${pad(s.bugs, 5)} ${pad(dish.maxGen, 5)} ${pad(dish.births, 7)} ` +
        `${pad(dish.deaths, 7)} ${pad(s.meanE, 6)} ${pad(s.pctFertile, 7)} ` +
        `${pad(meanStepCost(dish).toFixed(2), 8)}`,
    );
  }
} else {
  console.log(`${steps} steps, seed ${seed}, defaults, SIGHTED senses`);
console.log(
  '  rough   stepcost   relief      pop  births/1k  deaths/1k  gen  meanE  maxE  %>=180  %carry',
);

for (const roughness of ROUGHNESS) {
  const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(seed));
  if (roughness > 0) dish.seedTerrain(roughness, new Rng(seed + 1));

  for (let t = 0; t < SETTLE; t++) dish.step();
  const birthsAtSettle = dish.births;
  const deathsAtSettle = dish.deaths;

  for (let t = SETTLE; t < steps; t++) dish.step();

  const s = survey(dish);
  const window = steps - SETTLE;
  const per1000 = (v: number) => Math.round((v / window) * 1000);

  console.log(
    `${pad(roughness, 7)} ${pad(meanStepCost(dish).toFixed(2), 11)} ` +
      `${pad(`${s.tMin}..${s.tMax}`, 9)} ${pad(s.bugs, 6)} ` +
      `${pad(per1000(dish.births - birthsAtSettle), 9)} ` +
      `${pad(per1000(dish.deaths - deathsAtSettle), 10)} ` +
      `${pad(dish.maxGen, 5)} ${pad(s.meanE, 6)} ${pad(s.maxE, 5)} ` +
      `${pad(s.pctFertile, 7)} ${pad(s.pctCarrying, 6)}`,
  );
}
}
