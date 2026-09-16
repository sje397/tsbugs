/**
 * Can this world sustain itself, or is injection the only thing holding it up?
 *
 * Scott's report: the population dies off and sometimes never reproduces again.
 * The stall probe showed the world sitting at ~100 bugs with only ~0.7
 * co-occupied cells per tick — one bug per cell, so the sexual gate
 * (`if(size <= 1) return;`, petri_dish.cpp:624) is almost always shut, and
 * births run far below deaths. That predicts something testable and severe:
 * remove the injection and the population should go extinct, from a perfectly
 * healthy starting state, with no defect required.
 *
 * So: warm the world up with injection on, then turn it off mid-flight and
 * watch. balance() is the only source of new bugs other than sex, and its two
 * feeders are minBugEnergy (bugs) and minEnergyEnergy (grid energy), so setting
 * both to zero disables it completely without touching anything else.
 *
 * Then turn it back on, to show what injection actually buys.
 *
 * Run:  node dist/tools/self-sustain-probe.mjs [warmup] [offSteps] [backOn] [seed]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const warmup = Number(process.argv[2] ?? 5000);
const offSteps = Number(process.argv[3] ?? 15000);
const backOn = Number(process.argv[4] ?? 5000);
const seed = Number(process.argv[5] ?? 2024);
const windowSize = 500;

const params = { ...DEFAULT_PARAMS };
const dish = new PetriDish(params, new Rng(seed));

interface Snapshot {
  pop: number;
  cells: number;
  paired: number;
  opps: number;
  gen0: number;
  maxGen: number;
  meanEnergy: number;
}

function snapshot(): Snapshot {
  const perCell = new Map<number, [number, number, number]>();
  let pop = 0;
  let energySum = 0;
  let gen0 = 0;
  let maxGen = 0;
  dish.forEachBug((bug, hash) => {
    pop++;
    energySum += bug.energy;
    if (bug.generation === 0) gen0++;
    if (bug.generation > maxGen) maxGen = bug.generation;
    const rich = bug.energy >= params.childEnergy + params.minEnergy;
    const splitter = bug.split < 128;
    let cell = perCell.get(hash);
    if (cell === undefined) {
      cell = [0, 0, 0];
      perCell.set(hash, cell);
    }
    cell[0]++;
    if (splitter) cell[1]++;
    if (rich && splitter) cell[2]++;
  });
  let paired = 0;
  let opps = 0;
  for (const [, [n, splitLow, rickety]] of perCell) {
    if (n >= 2) paired++;
    if (splitLow >= 2 && rickety >= 1) opps++;
  }
  return {
    pop,
    cells: perCell.size,
    paired,
    opps,
    gen0,
    maxGen,
    meanEnergy: pop ? energySum / pop : 0,
  };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);
let born = 0;
let died = 0;
let injected = 0;
/** Tick at which the population first reads zero, measured rather than narrated. */
let extinctAt: number | null = null;

function runPhase(label: string, steps: number): void {
  console.log('');
  console.log(`--- ${label} (${steps} steps) ---`);
  console.log('      t    pop  cells  pairs   opps  born  died   inj  gen0   maxGen   meanE');
  for (let t = 1; t <= steps; t++) {
    const b0 = dish.births;
    const d0 = dish.deaths;
    const i0 = dish.injected;
    dish.step();
    if (dish.population === 0 && extinctAt === null) extinctAt = dish.time;
    born += dish.births - b0;
    died += dish.deaths - d0;
    injected += dish.injected - i0;

    if (t % windowSize === 0) {
      const s = snapshot();
      console.log(
        `${pad(dish.time, 7)}${pad(s.pop, 7)}${pad(s.cells, 7)}${pad(s.paired, 7)}${pad(s.opps, 7)}` +
          `${pad(born, 6)}${pad(died, 6)}${pad(injected, 6)}${pad(s.gen0, 6)}${pad(s.maxGen, 9)}${pad(s.meanEnergy.toFixed(0), 8)}`,
      );
      born = 0;
      died = 0;
      injected = 0;
    }
  }
}

runPhase('A: default parameters, injection on (warm-up)', warmup);

const off = dish.setParams({ ...params, minBugEnergy: 0, minEnergyEnergy: 0 });
console.log('');
console.log(`injection OFF -> applied ${JSON.stringify(off.applied)}`);
const offSnapshot = snapshot();
console.log(
  `state at switch-off: pop ${offSnapshot.pop}, gen0 ${offSnapshot.gen0} (${((100 * offSnapshot.gen0) / Math.max(1, offSnapshot.pop)).toFixed(0)}% injected), maxGen ${offSnapshot.maxGen}`,
);

runPhase('B: injection disabled — can the population hold itself up?', offSteps);

const final = snapshot();
console.log('');
console.log(
  final.pop === 0
    ? `population reached ZERO at t=${extinctAt} (${extinctAt! - warmup} ticks after injection stopped) — ` +
      `the world cannot sustain itself without injection`
    : `population survived at ${final.pop}`,
);

const on = dish.setParams({ ...params, minBugEnergy: params.minBugEnergy, minEnergyEnergy: params.minEnergyEnergy });
console.log('');
console.log(`injection ON again -> applied ${JSON.stringify(on.applied)}`);
runPhase('C: injection restored', backOn);

const recovered = snapshot();
console.log('');
console.log(
  `after ${dish.time} ticks total: pop ${recovered.pop}, maxGen ${recovered.maxGen}, ` +
    `totals births ${dish.births}, deaths ${dish.deaths}, injected ${dish.injected}`,
);
