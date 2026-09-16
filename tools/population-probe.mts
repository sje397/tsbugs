/**
 * Where a population's bugs come from, and what its statistics are hiding.
 *
 * A world that looks like it is barely evolving can be one where everything is
 * going fine and the counters cannot say so. `maxGen` is reset to zero at the top
 * of every tick (petri_dish.cpp:672), so it reports only the best generation
 * *alive* — and balance() adds generation-0 bugs to hold the world at its energy
 * minimum, which drags the mean generation down and caps how high maxGen can look
 * no matter how well the population is reproducing. Nothing upstream separates
 * the two, so this prints births against injections side by side, which is the
 * only way to see which of them is actually setting the population's turnover.
 *
 * Run:  node dist/tools/population-probe.mjs [steps] [seed]
 *   The world is flat: there is no terrain to seed and no roughness to pass.
 *   fingerprint world does.
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1234);

const dish = new PetriDish({ ...DEFAULT_PARAMS }, new Rng(seed));

const pad = (v: number, w: number) => String(v).padStart(w);
const pad2 = (v: number, w: number) => v.toFixed(2).padStart(w);

function line(): string {
  let bugs = 0;
  let generationTotal = 0;
  let oldest = 0;
  dish.forEachBug((bug) => {
    bugs++;
    generationTotal += bug.generation;
    if (bug.age > oldest) oldest = bug.age;
  });

  const remaining = dish.totalEnergy - dish.bugEnergy - dish.energyEnergy;

  return [
    pad(dish.time, 6),
    pad(bugs, 6),
    pad(dish.births, 8),
    pad(dish.injected, 9),
    pad(dish.deaths, 8),
    pad(dish.maxGen, 8),
    pad2(bugs === 0 ? 0 : generationTotal / bugs, 8),
    pad(oldest, 7),
    pad(Math.round(dish.bugEnergy), 8),
    pad(Math.round(dish.energyEnergy), 8),
    pad(Math.round(remaining), 8),
  ].join(' ');
}

console.log(
  '  tick    pop   births  injected   deaths   maxGen   meanGen   oldest  bugEner  gridEner  undist',
);
console.log(line());

const every = Math.max(1, Math.floor(steps / 10));
for (let i = 0; i < steps; i++) {
  dish.step();
  if ((i + 1) % every === 0) console.log(line());
}

const bugs = dish.population;
const ratio = dish.births === 0 ? Infinity : dish.injected / dish.births;
console.log(
  `\nover ${steps} ticks: ${dish.births} births, ${dish.injected} injected ` +
    `(${ratio.toFixed(2)} top-ups per birth), ${dish.deaths} deaths, ` +
    `population ${bugs}, maxGen ${dish.maxGen}`,
);
