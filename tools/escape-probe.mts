/**
 * After a die-off, does the population start reproducing again?
 *
 * The question is not whether a world can die — it can, and that is ordinary.
 * The question is whether reproduction restarts afterwards, and that is a
 * question about a rate, not about one run. A single seed that recovers, or one
 * that does not, says almost nothing: the escape looks fluctuation-driven, so
 * the reportable figure is the fraction of seeds that escape and how long they
 * take.
 *
 * Definitions used, stated here because the whole probe turns on them:
 *
 *   BREEDING  = the first 1000-tick window after the die-off in which
 *               births > deaths
 *   REPRODUCING = population >= 250 held for five consecutive windows (5000
 *               ticks)
 *
 * REPRODUCING is the claim worth reporting, and the population threshold is what
 * makes it mean something. Injection alone cannot build a large population:
 * balance() adds bugs only until the population's total energy reaches
 * minBugEnergy (40000), so the injection-maintained state saturates around 100
 * bugs. A world holding 250+ is therefore breeding, not being propped up.
 *
 * An earlier version of this probe used "no injection for five windows" as the
 * marker instead, and it was wrong: a die-off leaves the world freshly topped up
 * to minBugEnergy, so injections stay silent for thousands of ticks before the
 * stock drains, and the flag fired in worlds that were plainly dying. Injection
 * silence is a *stock* measurement; population is a *flow* measurement. Measure
 * the flow.
 *
 * `injected == 0` is not an arbitrary marker. balance() injects only while the
 * population's total energy is below minBugEnergy, so a window with no injection
 * means the population carried enough energy to sustain itself for 1000 ticks —
 * and `births > deaths` means it was doing so by breeding. Together they are
 * "this world is now reproducing on its own", not merely "this world is alive".
 *
 * Injection stays ON throughout both phases: the question is whether a world
 * that is being propped up can ever stop needing it. Turning injection off would
 * confound the measurement with a second question.
 *
 * Phases:
 *   A. N ticks from a fresh world, injection on
 *   B. forced die-off, then M ticks, injection on
 *
 * By default the measured phase is B — the question asked was about re-ignition
 * after a die-off. With --fresh the measured phase is A instead (pass the tick
 * count as phaseA and any value for phaseB), which answers the other half: can a
 * brand-new world ignite at all? Both matter, because they are not the same
 * question and, measured, they do not have the same answer.
 *
 * The die-off is the same clean instrument reseed-probe uses: maxAge 0 for one
 * step removes every bug, and balance() re-seeds within that same step.
 *
 * Run:  node dist/tools/escape-probe.mts [phaseA] [phaseB] [seeds] [timelineSeed]
 *       seeds: comma-separated, e.g. 2024,1,2,3,4,5,6,7
 *       timelineSeed: optional; prints a 1000-tick timeline for that one seed
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const phaseA = Number(process.argv[2] ?? 10_000);
const phaseB = Number(process.argv[3] ?? 40_000);
const seeds = (process.argv[4] ?? '2024').split(',').map(Number);
const timelineSeed = process.argv[5] === undefined ? null : Number(process.argv[5]);
const freshOnly = process.argv.includes('--fresh');

const WINDOW = 1000;
const REPRODUCING_POP = 250;

interface Outcome {
  seed: number;
  liveAtDieOff: number;
  liveAfterDieOff: number;
  breedingAt: number | null;
  reproducingAt: number | null;
  peakPop: number;
  peakAt: number;
  finalPop: number;
  finalGen: number;
  heldToEnd: boolean;
  maxInjectionFreeTicks: number;
  totals: { births: number; deaths: number; injected: number };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);

function probe(seed: number, timeline: boolean): Outcome {
  const params = { ...DEFAULT_PARAMS };
  const dish = new PetriDish(params, new Rng(seed));

  // Rolling window history: population (for the breeding test) and injection
  // counts (only to report how long the world went without being topped up).
  const popHistory: number[] = [];
  const injHistory: number[] = [];
  let reproducingAt: number | null = null;
  let injectionFreeTicks = 0;
  let maxInjectionFreeTicks = 0;
  let windowBorn = 0;
  let windowDied = 0;
  let windowInjected = 0;
  let lastBirths = 0;
  let lastDeaths = 0;
  let lastInjected = 0;
  let breedingAt: number | null = null;
  let peakPop = 0;
  let peakAt = 0;

  const tick = (t: number, phase: 'A' | 'B'): void => {
    dish.step();
    if (dish.population > peakPop) {
      peakPop = dish.population;
      peakAt = dish.time;
    }
    windowBorn = dish.births - lastBirths;
    windowDied = dish.deaths - lastDeaths;
    windowInjected = dish.injected - lastInjected;
    if (breedingAt === null && t % WINDOW === 0 && windowBorn > windowDied) breedingAt = dish.time;
    lastBirths = dish.births;
    lastDeaths = dish.deaths;
    lastInjected = dish.injected;
    if (t % WINDOW !== 0) return;
    if (phase === 'B') {
      popHistory.push(dish.population);
      injHistory.push(windowInjected);
      if (injHistory.length > 5) injHistory.shift();
      if (windowInjected === 0) {
        injectionFreeTicks += WINDOW;
        if (injectionFreeTicks > maxInjectionFreeTicks) maxInjectionFreeTicks = injectionFreeTicks;
      } else {
        injectionFreeTicks = 0;
      }
      if (
        reproducingAt === null &&
        popHistory.length >= 5 &&
        popHistory.slice(-5).every((p) => p >= REPRODUCING_POP)
      ) {
        reproducingAt = dish.time - (5 - 1) * WINDOW;
      }
    }
    if (timeline) {
      const pairs = pairsOf(dish);
      console.log(
        `${pad(dish.time, 7)}${pad(dish.population, 7)}${pad(pairs.cells, 7)}${pad(pairs.paired, 7)}` +
          `${pad(windowBorn, 6)}${pad(windowDied, 6)}${pad(windowInjected, 6)}` +
          `${pad(windowBorn / Math.max(1, windowDied), 6)}${pad(gen0Share(dish), 7)}${pad(dish.maxGen, 8)}`,
      );
    }
  };

  if (timeline) printTimelineHeader(`A: fresh world, injection on (${phaseA} ticks)`);
  for (let t = 1; t <= phaseA; t++) tick(t, freshOnly ? 'B' : 'A');

  const liveAtDieOff = dish.population;
  let liveAfterDieOff = dish.population;

  if (!freshOnly) {
    // One step at maxAge 0 kills every bug; balance() re-seeds within the same step.
    dish.setParams({ ...params, maxAge: 0 });
    dish.step();
    dish.setParams({ ...params, maxAge: params.maxAge });
    liveAfterDieOff = dish.population;
  }

  if (timeline && !freshOnly) printTimelineHeader(`B: same world, re-seeded (${phaseB} ticks)`);
  for (let t = 1; t <= (freshOnly ? 0 : phaseB); t++) {
    tick(t, 'B');
  }

  return {
    seed,
    liveAtDieOff,
    liveAfterDieOff,
    breedingAt,
    reproducingAt,
    peakPop,
    peakAt,
    finalPop: dish.population,
    heldToEnd: dish.population >= REPRODUCING_POP,
    maxInjectionFreeTicks,
    finalGen: dish.maxGen,
    totals: {
      births: dish.births,
      deaths: dish.deaths,
      injected: dish.injected,
    },
  };
}

function pairsOf(dish: PetriDish): { cells: number; paired: number } {
  const perCell = new Map<number, number>();
  dish.forEachBug((_bug, hash) => perCell.set(hash, (perCell.get(hash) ?? 0) + 1));
  let paired = 0;
  for (const [, n] of perCell) if (n >= 2) paired++;
  return { cells: perCell.size, paired };
}

function gen0Share(dish: PetriDish): string {
  let pop = 0;
  let gen0 = 0;
  dish.forEachBug((bug) => {
    pop++;
    if (bug.generation === 0) gen0++;
  });
  return pop ? `${((100 * gen0) / pop).toFixed(0)}%` : '0%';
}

function printTimelineHeader(label: string): void {
  console.log('');
  console.log(`--- ${label} ---`);
  console.log('      t    pop  cells  pairs  born  died   inj   b/d  gen0%  maxGen');
}

const outcomes: Outcome[] = [];
for (const seed of seeds) outcomes.push(probe(seed, seed === timelineSeed));

console.log('');
console.log(
  `breeding = a ${WINDOW}-tick window with births > deaths; ` +
    `reproducing = population >= ${REPRODUCING_POP} held for ${5 * WINDOW} ticks. ` +
    (freshOnly ? `fresh world, ${phaseA} ticks, no die-off` : `phase B: ${phaseB} ticks after the die-off`),
);
console.log('');
console.log('   seed  after  breed@t  repro@t  peakPop  endPop  endGen  heldEnd  injFree  births  deaths  injected');
const where = freshOnly ? 'from a fresh world' : 'after the die-off';
for (const o of outcomes) {
  console.log(
    `${pad(o.seed, 7)}${pad(o.liveAfterDieOff, 7)}${pad(o.breedingAt ?? 'never', 9)}` +
      `${pad(o.reproducingAt ?? 'never', 9)}${pad(o.peakPop, 9)}` +
      `${pad(o.finalPop, 8)}${pad(o.finalGen, 8)}${pad(o.heldToEnd ? 'yes' : 'no', 9)}` +
      `${pad(o.maxInjectionFreeTicks, 9)}` +
      `${pad(o.totals.births, 8)}${pad(o.totals.deaths, 8)}${pad(o.totals.injected, 10)}`,
  );
}

const breeding = outcomes.filter((o) => o.breedingAt !== null);
const reproducing = outcomes.filter((o) => o.reproducingAt !== null);
const held = outcomes.filter((o) => o.heldToEnd);
const ticksAfter = (v: number) => Math.round(v - (phaseA + 1));
console.log('');
console.log(
  `breeding (any window with births > deaths) ${where}: ` +
    `${breeding.length}/${outcomes.length}`,
);
console.log(
  `reproducing (pop >= ${REPRODUCING_POP} held 5000 ticks) ${where}: ` +
    `${reproducing.length}/${outcomes.length}` +
    (reproducing.length
      ? ` — seeds ${reproducing.map((o) => `${o.seed}@+${ticksAfter(o.reproducingAt!)}`).join(', ')}`
      : ''),
);
console.log(
  `still >= ${REPRODUCING_POP} at the end: ${held.length}/${outcomes.length}` +
    (held.length ? ` — seeds ${held.map((o) => o.seed).join(', ')}` : ''),
);
console.log(
  `peaks: ${outcomes.map((o) => `${o.seed}:${o.peakPop}`).join(' ')}`,
);
