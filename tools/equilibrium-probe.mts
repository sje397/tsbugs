/**
 * Can a FRESH world escape the injection equilibrium, and what moves the odds?
 *
 * The world has two steady states and they are far apart. In one, `balance()` is
 * the population: bug energy is pinned at `minBugEnergy` and the ~100 bugs
 * standing there are mostly generation 0, because injection is what puts them
 * there (3.3 top-ups per birth over 2000 ticks — see PetriDish.injected). In the
 * other, the population is several hundred strong, births outrun deaths, nothing
 * needs injecting and generations climb into the hundreds.
 *
 * `tools/escape-probe.mts` measures which of those a world reaches after every
 * bug is killed — but it spends `phaseA` ticks getting there and `phaseB` ticks
 * recovering, so it cannot separate "the die-off helped" from "it needed longer".
 * This runs a fresh world for the whole window and nothing else, so the escape
 * rate is a rate and not a property of a two-phase schedule.
 *
 * The measured claim it exists to test: the escape is a lottery over the injected
 * genomes. Nothing about the world's rules changes when a world escapes, so the
 * only thing that can differ is whether a lineage that breeds well happens to be
 * drawn — which makes the escape rate a per-seed frequency, not a threshold.
 *
 * "Escaped" reuses escape-probe's bar: population >= 250 held for 5000 ticks.
 * Injection saturates near 100, so 250 is a density injection cannot reach, and
 * holding it for 5000 ticks rules out a transient bloom.
 *
 * Run:  node dist/tools/equilibrium-probe.mjs [ticks] [seeds] [configs]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const ticks = Number(process.argv[2] ?? 40_000);
const seeds = (process.argv[3] ?? '2024,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23')
  .split(',')
  .map(Number);
/** Comma-separated ids to run, or absent for all of them. */
const wanted = process.argv[4] === undefined ? null : process.argv[4].split(',');

/** Population that injection cannot reach; see the header. */
const ESCAPED_POP = 250;
const HELD_TICKS = 5_000;

interface Config {
  id: string;
  label: string;
  overrides: Partial<typeof DEFAULT_PARAMS>;
}

const allConfigs: Config[] = [
  { id: 'default', label: 'default    minEnergy 20', overrides: {} },
  { id: 'floor10', label: 'floor      minEnergy 10', overrides: { minEnergy: 10 } },
  { id: 'floor5', label: 'floor      minEnergy  5', overrides: { minEnergy: 5 } },
  { id: 'wrap', label: 'wrap       killOnEdge 0', overrides: { killOnEdge: false } },
  {
    id: 'dense',
    label: 'dense      minBug 70k',
    overrides: { minBugEnergy: 70_000, minEnergyEnergy: 46_000 },
  },
];

const configs = wanted === null ? allConfigs : allConfigs.filter((c) => wanted.includes(c.id));
if (configs.length === 0) {
  console.error(`no config matched; available: ${allConfigs.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

interface Outcome {
  seed: number;
  escaped: boolean;
  escapedAt: number | null;
  peakPop: number;
  endPop: number;
  endGen: number;
  births: number;
  deaths: number;
  injected: number;
}

function run(seed: number, overrides: Partial<typeof DEFAULT_PARAMS>): Outcome {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, ...overrides }, new Rng(seed));
  let peakPop = 0;
  let above = 0;
  let escapedAt: number | null = null;

  for (let t = 1; t <= ticks; t++) {
    dish.step();
    if (dish.population > peakPop) peakPop = dish.population;
    if (escapedAt === null) {
      above = dish.population >= ESCAPED_POP ? above + 1 : 0;
      if (above >= HELD_TICKS) escapedAt = dish.time - HELD_TICKS;
    }
  }

  return {
    seed,
    escaped: escapedAt !== null,
    escapedAt,
    peakPop,
    endPop: dish.population,
    endGen: dish.maxGen,
    births: dish.births,
    deaths: dish.deaths,
    injected: dish.injected,
  };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);

console.log(
  `equilibrium scan: fresh world, ${ticks} ticks, ${seeds.length} seeds, ` +
    `escaped = pop >= ${ESCAPED_POP} held ${HELD_TICKS} ticks`,
);

for (const cfg of configs) {
  const outcomes = seeds.map((seed) => run(seed, cfg.overrides));
  const escaped = outcomes.filter((o) => o.escaped);
  const endGen = outcomes.map((o) => o.endGen).sort((a, b) => a - b);
  const totalBirths = outcomes.reduce((n, o) => n + o.births, 0);
  const totalInjected = outcomes.reduce((n, o) => n + o.injected, 0);

  console.log('');
  console.log(`${cfg.label}  —  escaped ${escaped.length}/${outcomes.length}`);
  console.log(
    '   seed  esc  escAt  peak  endPop  endGen  births  deaths  injected',
  );
  for (const o of outcomes) {
    console.log(
      `${pad(o.seed, 7)}${pad(o.escaped ? 'yes' : 'no', 5)}${pad(o.escapedAt ?? '-', 7)}` +
        `${pad(o.peakPop, 6)}${pad(o.endPop, 8)}${pad(o.endGen, 8)}` +
        `${pad(o.births, 8)}${pad(o.deaths, 8)}${pad(o.injected, 10)}`,
    );
  }
  console.log(
    `  median endGen ${endGen[Math.floor(endGen.length / 2)]}` +
      `  injections per birth ${(totalInjected / Math.max(1, totalBirths)).toFixed(2)}`,
  );
}
