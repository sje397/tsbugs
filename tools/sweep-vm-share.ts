/**
 * Where does a tick actually go: the VM, or the world?
 *
 * `steps_per_update` is the only knob that varies VM work without changing the
 * world's shape, and every Processor reads it at construction — including
 * children and balance-spawned bugs — so a sweep of it separates the two by
 * linear fit. Cost per tick per bug against steps/bug is a straight line:
 *
 *     us_per_tick_per_bug = a + b * stepsPerUpdate
 *
 * `a` is everything that is not the VM (the occupied-cell loops, eating and
 * seeing, movement, balance, bookkeeping); `b` is one VM step. Dividing by
 * population is what makes the points comparable, because the sweep changes the
 * simulation's dynamics and therefore its population.
 *
 * This is the measurement that decides whether a GPU is the right shape for this
 * workload: the VM is a serial, branch-heavy scalar interpreter per bug, which is
 * the worst case for a GPU. A uniform per-cell grid pass would be the best case.
 */
import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const SEEDS = [2024, 7, 99];
const SPS = [0, 8, 16, 32, 64, 128];
const WARM = 1000;
const MEASURE = 1000;

interface Row {
  sps: number;
  seed: number;
  usPerTick: number;
  popMean: number;
  usPerTickPerBug: number;
}

function run(seed: number, stepsPerUpdate: number): Omit<Row, 'sps' | 'seed'> {
  const params = { ...DEFAULT_PARAMS, stepsPerUpdate };
  const dish = new PetriDish(params, new Rng(seed));
  for (let i = 0; i < WARM; i++) dish.step();

  let popSum = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < MEASURE; i++) {
    dish.step();
    popSum += dish.population;
  }
  const t1 = process.hrtime.bigint();

  const usPerTick = Number(t1 - t0) / 1000 / MEASURE;
  const popMean = popSum / MEASURE;
  return { usPerTick, popMean, usPerTickPerBug: usPerTick / popMean };
}

const rows: Row[] = [];
for (const sps of SPS) {
  for (const seed of SEEDS) {
    const r = run(seed, sps);
    rows.push({ sps, seed, ...r });
  }
}

console.log('steps/bug  seed   us/tick  pop    us/tick/bug');
for (const r of rows) {
  console.log(
    `${String(r.sps).padStart(9)}  ${String(r.seed).padStart(4)}  ${r.usPerTick.toFixed(2).padStart(7)}  ` +
    `${r.popMean.toFixed(1).padStart(5)}  ${r.usPerTickPerBug.toFixed(4).padStart(11)}`,
  );
}

// Least squares over every point, so the line is fitted to the data rather than
// to the per-sps averages — and report r^2, because a fit that explains nothing
// should not be quoted.
const n = rows.length;
const mx = rows.reduce((s, r) => s + r.sps, 0) / n;
const my = rows.reduce((s, r) => s + r.usPerTickPerBug, 0) / n;
let sxy = 0, sxx = 0, syy = 0;
for (const r of rows) {
  sxy += (r.sps - mx) * (r.usPerTickPerBug - my);
  sxx += (r.sps - mx) ** 2;
  syy += (r.usPerTickPerBug - my) ** 2;
}
const slope = sxy / sxx;
const intercept = my - slope * mx;
const r2 = (sxy * sxy) / (sxx * syy);

console.log(`\nfit: ${intercept.toFixed(4)} + ${slope.toFixed(5)} * steps_per_update  us/tick/bug  (r^2 ${r2.toFixed(4)})`);
console.log(`at steps_per_update=64: ${(intercept + slope * 64).toFixed(4)} us/tick/bug`);
console.log(`  VM share        : ${((slope * 64 / (intercept + slope * 64)) * 100).toFixed(1)}%`);
console.log(`  non-VM share    : ${((intercept / (intercept + slope * 64)) * 100).toFixed(1)}%`);
