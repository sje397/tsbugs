/**
 * Why a population can stop replicating and never start again.
 *
 * Reported symptom: the bugs die down, and sometimes never reproduce again. The
 * hypothesis offered was that balance() recycles dead bugs instead of injecting
 * fresh randomised ones. It does not — balance() calls Bug.createRandom, which
 * is upstream's random-genome constructor (bug.cpp:30: random size in
 * [min_data, max_data), every byte qrand() % 256, generation 0). So fresh
 * genomes do keep arriving, and the real question is what stops them mating.
 *
 * Replication needs three things at once, all inside ONE cell
 * (petri_dish.cpp:616-665, ported verbatim):
 *   1. at least two bugs in that cell          (`if(size <= 1) return;`)
 *   2. a mother with energy >= child_energy + min_energy   (160 + 20 = 180)
 *   3. a different bug in the same cell whose split output is below the
 *      literal threshold 128 — the mother must clear it too.
 *
 * This counts, per tick, how many cells satisfy all three ("opportunities")
 * and reports births against that. The three ways a world can be stuck are
 * then distinguishable rather than guessed at:
 *   - opportunities > 0 while births == 0  -> the blocker is neither energy nor
 *     encounter rate; something after the gate forbids the birth.
 *   - opportunities == 0 with pairs present -> the split/energy condition.
 *   - opportunities == 0 with no pairs     -> injected bugs are not meeting at
 *     all: the encounter structure itself is the problem.
 *
 * Run:  node dist/tools/stall-probe.mjs [steps] [seed] [window]
 *   Defaults match the acceptance world: 40000 steps, seed 2024.
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 40000);
const seed = Number(process.argv[3] ?? 2024);
const windowSize = Number(process.argv[5] ?? 500);

/** petri_dish.cpp:626 — the live value is the literal 128, not a draw. */
const SPLIT_THRESHOLD = 128;

const params = { ...DEFAULT_PARAMS };
const dish = new PetriDish(params, new Rng(seed));

const motherEnergy = params.childEnergy + params.minEnergy;

interface Census {
  bugs: number;
  cells: number;
  pairedCells: number;
  opportunities: number;
  energySum: number;
  rich: number;
  splitters: number;
  maxGen: number;
}

/** Count whose cells could actually produce a birth on this tick. */
function census(): Census {
  const perCell = new Map<number, [number, number, number]>(); // n, split<128, rich & split<128
  let bugs = 0;
  let energySum = 0;
  let rich = 0;
  let splitters = 0;
  let maxGen = 0;

  dish.forEachBug((bug, hash) => {
    bugs++;
    energySum += bug.energy;
    if (bug.generation > maxGen) maxGen = bug.generation;
    const isRich = bug.energy >= motherEnergy;
    const isSplitter = bug.split < SPLIT_THRESHOLD;
    if (isRich) rich++;
    if (isSplitter) splitters++;
    let cell = perCell.get(hash);
    if (cell === undefined) {
      cell = [0, 0, 0];
      perCell.set(hash, cell);
    }
    cell[0]++;
    if (isSplitter) cell[1]++;
    if (isRich && isSplitter) cell[2]++;
  });

  let pairedCells = 0;
  let opportunities = 0;
  for (const [, [n, splitLow, rickety]] of perCell) {
    if (n >= 2) pairedCells++;
    // A mother needs a *different* bug as partner, so one splitter alone is not enough.
    if (splitLow >= 2 && rickety >= 1) opportunities++;
  }

  return { bugs, cells: perCell.size, pairedCells, opportunities, energySum, rich, splitters, maxGen };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);

interface Row {
  t: number;
  c: Census;
  born: number;
  died: number;
  injected: number;
  oppTicks: number;
  pairTicks: number;
  bugEnergy: number;
  energyEnergy: number;
}

const rows: Row[] = [];
let born = 0;
let died = 0;
let injected = 0;
let oppTicks = 0;
let pairTicks = 0;
let lastCensus: Census | null = null;

let streak = 0;
let longest = { length: 0, start: 0, end: 0 };
let streakStart = 0;

const t0 = Date.now();

for (let t = 1; t <= steps; t++) {
  const c = census();
  lastCensus = c;
  if (c.opportunities > 0) oppTicks++;
  if (c.pairedCells > 0) pairTicks++;

  const b0 = dish.births;
  const d0 = dish.deaths;
  const i0 = dish.injected;
  dish.step();
  born += dish.births - b0;
  died += dish.deaths - d0;
  injected += dish.injected - i0;

  const thisTickBorn = dish.births - b0;
  if (thisTickBorn === 0) {
    if (streak === 0) streakStart = dish.time;
    streak++;
    if (streak > longest.length) longest = { length: streak, start: streakStart, end: dish.time };
  } else {
    streak = 0;
  }

  if (t % windowSize === 0) {
    rows.push({
      t: dish.time,
      c,
      born,
      died,
      injected,
      oppTicks,
      pairTicks,
      bugEnergy: dish.bugEnergy,
      energyEnergy: dish.energyEnergy,
    });
    born = 0;
    died = 0;
    injected = 0;
    oppTicks = 0;
    pairTicks = 0;
  }
}

const elapsed = (Date.now() - t0) / 1000;
const last = lastCensus!;

console.log(
  `stall probe: ${steps} steps, seed ${seed}, flat world, window ${windowSize}  (${elapsed.toFixed(1)}s)`,
);
console.log(
  `params: totalEnergy ${params.totalEnergy} minBugEnergy ${params.minBugEnergy} minEnergyEnergy ${params.minEnergyEnergy} ` +
    `childEnergy ${params.childEnergy} minEnergy ${params.minEnergy} maxEnergy ${params.maxEnergy} maxAge ${params.maxAge} ` +
    `minData ${params.minData} maxData ${params.maxData}  -> mother needs energy >= ${motherEnergy}, split < ${SPLIT_THRESHOLD}`,
);
console.log('');
console.log(
  '      t   pop  cells  pairs   opps   born   died    inj  oppT  pairT   meanE  richS  splS    bugE    gridE   gen',
);

for (const r of rows) {
  const c = r.c;
  const meanE = c.bugs ? (c.energySum / c.bugs).toFixed(0) : '0';
  const mark =
    r.born === 0 && r.c.bugs > 0 && r.oppTicks === 0 && r.pairTicks > 0
      ? ' <- no opportunities'
      : r.born === 0 && r.c.bugs > 0 && r.oppTicks > 0
        ? ' <- OPPORTUNITIES BUT NO BIRTHS'
        : '';
  console.log(
    `${pad(r.t, 7)}${pad(c.bugs, 6)}${pad(c.cells, 7)}${pad(c.pairedCells, 7)}${pad(c.opportunities, 7)}` +
      `${pad(r.born, 7)}${pad(r.died, 7)}${pad(r.injected, 7)}${pad(r.oppTicks, 6)}${pad(r.pairTicks, 7)}` +
      `${pad(meanE, 8)}${pad(c.rich, 7)}${pad(c.splitters, 7)}${pad(r.bugEnergy, 8)}${pad(r.energyEnergy, 8)}${pad(c.maxGen, 6)}${mark}`,
  );
}

console.log('');
console.log(
  `longest run of ticks with no births: ${longest.length}` +
    (longest.length > 0 ? ` (t=${longest.start} to t=${longest.end})` : ''),
);
console.log(
  `final: pop ${last.bugs}, cells ${last.cells}, paired cells ${last.pairedCells}, ` +
    `opportunities ${last.opportunities}, mean energy ${(last.energySum / Math.max(1, last.bugs)).toFixed(1)}, ` +
    `rich ${last.rich}, splitters ${last.splitters}, maxGen ${last.maxGen}`,
);
console.log(
  `totals: births ${dish.births}, deaths ${dish.deaths}, injected ${dish.injected} ` +
    `(${(dish.injected / Math.max(1, dish.births)).toFixed(2)} injected per birth)`,
);
