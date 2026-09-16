/**
 * Which regime can sustain itself, and is density the reason?
 *
 * Two facts from the stall and self-sustain probes:
 *   - sex needs two bugs in ONE cell (`if(size <= 1) return;`, petri_dish.cpp:624)
 *   - at the default energy split the world holds ~100 bugs, and it goes
 *     extinct in ~1,500 ticks once injection is switched off: births run at
 *     roughly a third of deaths.
 *
 * If the cause is encounter rate, it is a density effect and should scale
 * visibly: co-occupied cells go as the square of the population, and the
 * population itself is set by how much of the world's energy budget the bugs
 * are allowed to hold (balance() tops bug energy up to `minBugEnergy`, so
 * population ~= minBugEnergy / mean bug energy).
 *
 * So this raises `minBugEnergy` (and lowers `minEnergyEnergy` to match, since
 * the two together cannot exceed `totalEnergy`) and watches whether births
 * overtake deaths — a world that reproduces faster than it dies needs no
 * injection to persist. It also runs the other energy layouts, since a layout
 * that spreads the same population over more cells should starve contacts.
 *
 * Run:  node dist/tools/regime-probe.mts [steps] [seed]
 */

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, EnergyLayout, SenseModel } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? 2024);
/** Ignore the transient at the start; report the regime it settles into. */
const steadyFrom = Math.floor(steps / 2);

interface Config {
  label: string;
  overrides: Partial<typeof DEFAULT_PARAMS>;
}

const configs: Config[] = [
  { label: 'default      40k/76k dot', overrides: {} },
  { label: 'denser       70k/46k dot', overrides: { minBugEnergy: 70_000, minEnergyEnergy: 46_000 } },
  { label: 'densest     105k/11k dot', overrides: { minBugEnergy: 105_000, minEnergyEnergy: 11_000 } },
  { label: 'layout      40k/76k random', overrides: { energyLayout: EnergyLayout.RANDOM } },
  { label: 'layout      40k/76k manydots', overrides: { energyLayout: EnergyLayout.MANYDOTS } },
  { label: 'layout      40k/76k ring', overrides: { energyLayout: EnergyLayout.RING } },
  // The sense model is the port's one deliberate behavioural divergence, so the two
  // worlds it can build are the two ecologies worth comparing directly.
  { label: 'senses      as-shipped (blind)', overrides: { senseModel: SenseModel.AS_SHIPPED } },
  // Single knobs, to find what actually moves the reproduction/death ratio.
  { label: 'knob        move=1 stay=1', overrides: { moveEnergy: 1, stayEnergy: 1 } },
  { label: 'knob        child=40', overrides: { childEnergy: 40 } },
  { label: 'knob        minEnergy=5', overrides: { minEnergy: 5 } },
  { label: 'knob        maxAge=12000', overrides: { maxAge: 12_000 } },
];

interface Tally {
  pop: number;
  cells: number;
  paired: number;
  opps: number;
  gen0: number;
  maxGen: number;
}

function tally(dish: PetriDish): Tally {
  const perCell = new Map<number, number>();
  const splitters = new Map<number, [number, number]>();
  let pop = 0;
  let gen0 = 0;
  let maxGen = 0;
  dish.forEachBug((bug, hash) => {
    pop++;
    if (bug.generation === 0) gen0++;
    if (bug.generation > maxGen) maxGen = bug.generation;
    perCell.set(hash, (perCell.get(hash) ?? 0) + 1);
    const rich = bug.energy >= DEFAULT_PARAMS.childEnergy + DEFAULT_PARAMS.minEnergy;
    const splitter = bug.split < 128;
    let c = splitters.get(hash);
    if (c === undefined) {
      c = [0, 0];
      splitters.set(hash, c);
    }
    if (splitter) c[0]++;
    if (rich && splitter) c[1]++;
  });
  let paired = 0;
  let opps = 0;
  for (const [, n] of perCell) if (n >= 2) paired++;
  for (const [, [low, rickety]] of splitters) if (low >= 2 && rickety >= 1) opps++;
  return { pop, cells: perCell.size, paired, opps, gen0, maxGen };
}

const pad = (v: number | string, w: number) => String(v).padStart(w);
console.log(`regime scan: ${steps} steps each, seed ${seed}, flat world, steady state = last ${steps - steadyFrom}`);
console.log('');
console.log(
  'config                        pop  cells  pairs   opps   born   died    inj  b/d   gen0%  maxGen',
);

for (const cfg of configs) {
  const params = { ...DEFAULT_PARAMS, ...cfg.overrides };
  const dish = new PetriDish(params, new Rng(seed));

  let popSum = 0;
  let cellsSum = 0;
  let pairedSum = 0;
  let oppsSum = 0;
  let gen0Sum = 0;
  let samples = 0;
  let maxGen = 0;
  let bornBase = 0;
  let diedBase = 0;
  let injectedBase = 0;

  for (let t = 1; t <= steps; t++) {
    dish.step();
    if (t === steadyFrom) {
      bornBase = dish.births;
      diedBase = dish.deaths;
      injectedBase = dish.injected;
    }
    if (t > steadyFrom && t % 250 === 0) {
      const s = tally(dish);
      popSum += s.pop;
      cellsSum += s.cells;
      pairedSum += s.paired;
      oppsSum += s.opps;
      gen0Sum += s.gen0;
      samples++;
      if (s.maxGen > maxGen) maxGen = s.maxGen;
    }
  }

  const born = dish.births - bornBase;
  const died = dish.deaths - diedBase;
  const injected = dish.injected - injectedBase;
  const meanPop = popSum / samples;
  const gen0Pct = meanPop > 0 ? (100 * gen0Sum) / popSum : 0;
  const ratio = died > 0 ? born / died : born > 0 ? Infinity : 0;

  console.log(
    cfg.label.padEnd(28) +
      pad(meanPop.toFixed(0), 6) +
      pad((cellsSum / samples).toFixed(0), 7) +
      pad((pairedSum / samples).toFixed(2), 7) +
      pad((oppsSum / samples).toFixed(2), 7) +
      pad(born, 7) +
      pad(died, 7) +
      pad(injected, 7) +
      pad(ratio.toFixed(2), 6) +
      pad(gen0Pct.toFixed(0), 7) +
      pad(maxGen, 8),
  );
}
