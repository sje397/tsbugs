/**
 * What a tick of the real simulation costs, and where that time goes.
 *
 * The figures that decide whether any of this belongs on a GPU have to come from
 * the interpreter, not from a model of it: a model says what the arithmetic
 * should cost, and this says what it does cost with a live population, the real
 * grid, and the real list churn.
 *
 * Three things are measured, because they have different prospects in parallel:
 *
 *   tick    PetriDish.step() -- the simulation itself
 *   redraw  updateAllPixels() -- every cell, which is what a page must do per
 *           frame; independent per cell, so it is the friendliest part
 *   flat    a tick on an unseeded world. This is NOT a controlled comparison
 *           with `tick`: the ground differs and so does the population the world
 *           settles at, so read the population line before reading the cost.
 *
 * Population is sampled *inside* the measured window. A measurement that only
 * reports the population at the end cannot be interpreted -- a world can boom
 * and crash within one window and end where it began -- and the first version of
 * this tool did exactly that, which is why it reported the same flat world at
 * 177us and 747us per tick in two consecutive runs.
 *
 * Modes exist so a CPU profile can attribute time to one loop at a time: with
 * only `tick` selected, every sample belongs to the simulation.
 *
 * Run:          node dist/tools/bench.mjs [steps] [seed] [mode] [size]
 *               mode: all (default) | tick | redraw
 *               size: world edge in cells (default 240). Quadrupling it
 *                     quadruples the grid and, if a tick's cost tracks the
 *                     population rather than the world, should not change the
 *                     per-tick figure at all.
 * Attribution:  node --cpu-prof --cpu-prof-dir=/tmp/prof dist/tools/bench.mjs 20000 2024 tick
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 5000);
const seed = Number(process.argv[3] ?? 2024);
const mode = process.argv[4] ?? 'all';
const size = Number(process.argv[5] ?? DEFAULT_PARAMS.width);

const warmup = 2000;
const cells = size * size;

function build() {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, width: size, height: size }, new Rng(seed));
  // The first thousand ticks run at a different population and before the JIT
  // has settled on the hot paths; neither belongs in a throughput figure.
  for (let t = 0; t < warmup; t++) dish.step();
  return dish;
}

/** Ticks, with the population trajectory that gives the cost meaning. */
function tick(dish: PetriDish, reps: number) {
  const pops: number[] = [];
  const every = Math.max(1, Math.floor(reps / 10));
  const start = process.hrtime.bigint();
  for (let t = 0; t < reps; t++) {
    dish.step();
    if (t % every === 0) pops.push(dish.population);
  }
  const secs = Number(process.hrtime.bigint() - start) / 1e9;
  pops.push(dish.population);
  return { secs, reps, pops };
}

function redraw(dish: PetriDish, reps: number) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) dish.updateAllPixels();
  return { secs: Number(process.hrtime.bigint() - start) / 1e9, reps, pops: [dish.population] };
}

const us = (r: { secs: number; reps: number }) => ((r.secs / r.reps) * 1e6).toFixed(1).padStart(8);
const rate = (r: { secs: number; reps: number }) => (r.reps / r.secs).toFixed(0).padStart(6);
const popLine = (pops: number[]) =>
  `pop ${Math.min(...pops)}..${Math.max(...pops)} (mean ${(pops.reduce((a, b) => a + b) / pops.length).toFixed(0)})`;

console.log(`seed ${seed}, ${size}x${size} world, ${warmup} warm-up ticks`);

if (mode === 'all' || mode === 'tick') {
  const r = tick(build(), steps);
  console.log(`  tick    ${rate(r)} /s   ${us(r)} us   ${popLine(r.pops)}`);
}

if (mode === 'all' || mode === 'redraw') {
  const reps = Math.max(1, Math.floor(steps / 10));
  const r = redraw(build(), reps);
  console.log(`  redraw  ${rate(r)} /s   ${us(r)} us   ${cells} cells, one pass each`);
}

console.log(`  genesis ${Number(DEFAULT_PARAMS.stepsPerUpdate)} VM steps per bug per tick`);
