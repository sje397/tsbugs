/**
 * How wide is the living population's generation spread, and does it hold two humps?
 *
 * This exists to size the generation histogram's axis. A histogram of a
 * monotonically increasing quantity has to choose a window, and the choice is only
 * defensible against the real distribution rather than an imagined one. Two numbers
 * decide it:
 *
 *   - the RANGE of generations among living bugs, which sets how many bins a
 *     full-range window needs;
 *   - whether that range is one hump or several, because a step wide enough to fit
 *     a wide range can also smooth two populations into one -- and the two-dot
 *     preset is the case where that matters.
 *
 * The population's spread is not obvious a priori. Bugs that never split die, so
 * everyone alive was born recently; but a long-lived successful bug keeps a low
 * generation in the population for as long as it survives, and how long that is
 * depends on the energy field. So: measure.
 *
 * Run:  node dist/tools/generation-spread-probe.mjs [ticks] [seed] [preset]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, EnergyLayout } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const ticks = Number(process.argv[2] ?? 200000);
const seed = Number(process.argv[3] ?? 1234);
const presetId = process.argv[4] ?? 'twodots';

const overrides =
  presetId === 'twodots' ? { mutation: 0.05, energyLayout: EnergyLayout.TWODOTS }
  : presetId === 'gentle' ? { mutation: 0.05 }
  : {};

const dish = new PetriDish({ ...DEFAULT_PARAMS, ...overrides }, new Rng(seed));

/** Every living generation, ascending. */
function gens(): number[] {
  const out: number[] = [];
  dish.forEachBug((bug) => out.push(bug.generation));
  return out.sort((a, b) => a - b);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Greedy gap split: a run of generations separated from its neighbour by more than
 * `gap` generations is a separate population. Reported because the whole question
 * is whether the spread is one hump or two, and a single median cannot say.
 */
function clusters(sorted: number[], gap: number): Array<{ lo: number; hi: number; n: number }> {
  const out: Array<{ lo: number; hi: number; n: number }> = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && g - last.hi <= gap) {
      last.hi = g;
      last.n += 1;
    } else {
      out.push({ lo: g, hi: g, n: 1 });
    }
  }
  return out;
}

const samples = 12;
const every = Math.max(1, Math.floor(ticks / samples));
console.log(`preset ${presetId}  seed ${seed}  ticks ${ticks}`);
console.log('tick      pop   minGen  medGen  maxGen  range   humps(gap>4)');

for (let t = 0; t <= ticks; t++) {
  if (t % every === 0 || t === ticks) {
    const sorted = gens();
    const lo = sorted[0] ?? 0;
    const hi = sorted[sorted.length - 1] ?? 0;
    const humps = clusters(sorted, 4).filter((c) => c.n > 1);
    const humpText = humps.length <= 1
      ? String(humps.length)
      : humps.map((c) => `${c.lo}-${c.hi}x${c.n}`).join(' ');
    console.log(
      `${String(dish.time).padStart(8)}  ${String(sorted.length).padStart(4)}  `
      + `${String(lo).padStart(6)}  ${String(quantile(sorted, 0.5)).padStart(6)}  `
      + `${String(hi).padStart(6)}  ${String(hi - lo).padStart(6)}  ${humpText}`,
    );
  }
  if (t < ticks) dish.step();
}

// One shape at the end, at a bin width chosen to fit 60 columns.
const final = gens();
const lo = final[0] ?? 0;
const hi = final[final.length - 1] ?? 0;
const span = Math.max(1, hi - lo);
const step = Math.max(1, Math.ceil(span / 60));
const counts = new Map<number, number>();
for (const g of final) {
  const bin = Math.floor((g - lo) / step);
  counts.set(bin, (counts.get(bin) ?? 0) + 1);
}
const bins = Math.floor(span / step) + 1;
let peak = 1;
for (let b = 0; b < bins; b++) peak = Math.max(peak, counts.get(b) ?? 0);
console.log(`\nshape at tick ${dish.time} — ${final.length} bugs, gen ${lo}..${hi}, ${step} gen/bin`);
for (let b = 0; b < bins; b++) {
  const n = counts.get(b) ?? 0;
  const bar = '#'.repeat(Math.round((n / peak) * 50));
  console.log(`${String(lo + b * step).padStart(6)} ${String(n).padStart(3)} ${bar}`);
}
