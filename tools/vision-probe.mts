/**
 * Does a bug's 3x3 window read the cells it claims to?
 *
 * The existing integration guard (`test/dish.test.ts`, "the energy window carries
 * a real 3x3 reading") asserts that the nine slots are not all the same value. A
 * transposed window, a window shifted one cell, or a wrong own-cell slot all pass
 * that: they produce nine varying readings too. This checks the mapping itself,
 * against a grid where every one of the nine cells carries a different value.
 *
 * HOW. A crafted world is restored with exactly one bug, and the nine cells
 * around it are given energies 0, 10, 20 ... 80 in WINDOW order — so slot d holds
 * a reading no other slot holds, and any permutation or offset is visible. One of
 * the nine is poisoned, which fixes the vision channel's index too (254 there,
 * 255 on the other energy cells, the bug's own colour at its own cell).
 *
 * The expected window is computed here from the public API with this tool's own
 * modular arithmetic — `wrapX`/`wrapY` are deliberately NOT used, because
 * comparing them with themselves would prove nothing. Positions include the four
 * corners and two edges, where the wrap is the whole question.
 *
 * ONE SLOT NEEDS A FIXTURE HACK, AND THE REASON IS WORTH KNOWING. The window is
 * sampled AFTER the cell's energy has flowed into its bugs, not before — upstream
 * does the same and says so ("we have changed the energy but we still all see the
 * same because only energy hidden under bugs has changed"). So a bug standing on
 * food never reads that food in slot 4; what it reads there is the surplus it
 * could not absorb, usually 0. The first version of this probe expected the
 * pre-eating value and reported a defect on all six cases. The own cell is
 * therefore given no energy here, which makes slot 4's reading 0 both before and
 * after the tick and leaves the OTHER eight slots as the thing under test.
 *
 *   node dist/tools/vision-probe.mjs
 */

import { PetriDish } from '../src/sim/dish.js';
import { BKG_COLOR, ENERGY_COLOR, MAX_BUG_COLOR, POISON_COLOR } from '../src/sim/params.js';
import { DEFAULT_PARAMS, EnergyLayout, type WorldParams } from '../src/sim/params.js';
import { Bug } from '../src/sim/bug.js';
import { Rng } from '../src/sim/rng.js';
import type { WorldSnapshot } from '../src/sim/dish.js';

const SIZE = 9;

/** Window slot index -> (column,row) step, as a table written out by hand. */
const STEP: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [0, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

interface Case {
  x: number;
  y: number;
  what: string;
}

const CASES: Case[] = [
  { x: 4, y: 4, what: 'centre' },
  { x: 0, y: 0, what: 'top-left corner (wraps both axes)' },
  { x: SIZE - 1, y: SIZE - 1, what: 'bottom-right corner (wraps both axes)' },
  { x: 0, y: 4, what: 'left edge (wraps x only)' },
  { x: 4, y: 0, what: 'top edge (wraps y only)' },
  { x: 3, y: 7, what: 'off-centre, unwrapped' },
];

/**
 * Nine values chosen so that senseByte(v, 80) is nine distinct readings once the
 * own cell's post-eating 0 is counted. Plain multiples of ten do not work: 80 and
 * 90 both saturate at 255, so two slots would read alike.
 */
const WINDOW_ENERGY = [10, 20, 30, 40, 0, 50, 60, 70, 76];

/**
 * The fixture's ground energy at a cell: WINDOW_ENERGY[d] if the cell is slot d of
 * the window around (x, y), and nothing anywhere else. A 9x9 world gives nine
 * distinct window cells for every position, so the first match is the only one.
 *
 * One function for the fixture and for the control, so the two cannot drift.
 */
function fixtureEnergy(x: number, y: number, nx: number, ny: number): number {
  for (let d = 0; d < 9; d++) {
    const [dx, dy] = STEP[d]!;
    if ((((x + dx) % SIZE) + SIZE) % SIZE === nx && (((y + dy) % SIZE) + SIZE) % SIZE === ny) {
      return WINDOW_ENERGY[d]!;
    }
  }
  return 0;
}

function params(): WorldParams {
  return {
    ...DEFAULT_PARAMS,
    width: SIZE,
    height: SIZE,
    poison: 0,
    // Nothing may be added to the world during the tick under test: balance()
    // would otherwise inject founders and ground, and the window would describe a
    // grid this tool did not build.
    totalEnergy: 0,
    minBugEnergy: 0,
    minEnergyEnergy: 1_000_000,
    energyLayout: EnergyLayout.RANDOM,
  };
}

function craft(x: number, y: number, seed: number): PetriDish {
  const p = params();
  const base = new PetriDish(p, new Rng(seed));
  const snapshot: WorldSnapshot = base.snapshot();

  const energy = new Int32Array(SIZE * SIZE);
  const poison = new Uint8Array(SIZE * SIZE);

  for (let nx = 0; nx < SIZE; nx++) {
    for (let ny = 0; ny < SIZE; ny++) energy[nx * SIZE + ny] = fixtureEnergy(x, y, nx, ny);
  }
  // One poisoned cell, so the vision channel identifies its own slot. Slot 1 is
  // north; using a non-central slot means an own-cell mix-up cannot hide.
  {
    const [dx, dy] = STEP[1]!;
    const px = (((x + dx) % SIZE) + SIZE) % SIZE;
    const py = (((y + dy) % SIZE) + SIZE) % SIZE;
    poison[px * SIZE + py] = 1;
  }

  const bugState = Bug.createRandom(p, new Rng(seed + 1)).snapshotState();
  bugState.energy = 400; // comfortably above min_energy, so it survives the tick
  bugState.color = 77; // not a value any ground type produces

  let groundSum = 0;
  for (let i = 0; i < energy.length; i++) groundSum += energy[i]!;

  snapshot.params = p;
  snapshot.energy = energy;
  snapshot.poison = poison;
  snapshot.bugTotal = new Int32Array(SIZE * SIZE);
  snapshot.cells = [{ hash: x * SIZE + y, bugs: [bugState] }];
  snapshot.counters = {
    ...snapshot.counters,
    population: 1,
    bugEnergy: bugState.energy,
    energyEnergy: groundSum,
  };

  return PetriDish.restore(snapshot);
}

function expectedVision(dish: PetriDish, nx: number, ny: number): number {
  const hash = nx * SIZE + ny;
  const bugs = dish.bugsAt(hash);
  if (bugs.length > 0) return (bugs[0]!.color % MAX_BUG_COLOR) + 1;
  if (dish.isPoisoned(hash)) return POISON_COLOR;
  if (dish.energyAt(hash) !== 0) return ENERGY_COLOR;
  return BKG_COLOR;
}

function senseByte(value: number, max: number): number {
  const scaled = Math.trunc((value / max) * 255);
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

let failures = 0;
/** Windows the sim really produced, for the transposition control below. */
const produced: number[][] = [];

for (const testCase of CASES) {
  const { x, y } = testCase;
  const dish = craft(x, y, 4242);
  const ownHash = x * SIZE + y;
  const bug = dish.bugsAt(ownHash)[0]!;

  // The expected windows are computed BEFORE the tick, from a grid that has not
  // moved. The bug's own VM reads the window without writing it, so the slots
  // survive the 64 steps and can be read afterwards.
  const wantVision: number[] = [];
  const wantEnergy: number[] = [];
  for (let d = 0; d < 9; d++) {
    const [dx, dy] = STEP[d]!;
    const nx = (((x + dx) % SIZE) + SIZE) % SIZE;
    const ny = (((y + dy) % SIZE) + SIZE) % SIZE;
    wantVision.push(expectedVision(dish, nx, ny));
    // Read from the fixture function, not from the dish: the own cell reads
    // post-eating, which is 0 because the fixture put nothing there, and every
    // other cell is untouched by the tick. Deriving it from `dish.energyAt` would
    // be reading the sim's own array to predict the sim's own answer.
    wantEnergy.push(senseByte(fixtureEnergy(x, y, nx, ny), dish.worldParams.maxEEnergy));
  }

  dish.step();

  const gotVision = Array.from({ length: 9 }, (_, d) => bug.processor.readIn(d));
  const gotEnergy = Array.from({ length: 9 }, (_, d) => bug.processor.readIn(9 + d));

  // A window of nine equal readings would make the comparison vacuous.
  if (new Set(wantEnergy).size !== 9) {
    console.log(`${testCase.what}: FIXTURE DEAD — expected energy readings are not nine distinct values`);
    failures++;
  }
  if (new Set(wantVision).size < 3) {
    console.log(`${testCase.what}: FIXTURE DEAD — expected vision readings identify at most two cells`);
    failures++;
  }
  produced.push(gotEnergy);

  for (let d = 0; d < 9; d++) {
    if (gotVision[d] !== wantVision[d]) {
      console.log(
        `${testCase.what}: vision slot ${d} read ${gotVision[d]}, expected ${wantVision[d]} ` +
          `(window ${wantVision.join(',')}; got ${gotVision.join(',')})`,
      );
      failures++;
    }
    if (gotEnergy[d] !== wantEnergy[d]) {
      console.log(
        `${testCase.what}: energy slot ${d} read ${gotEnergy[d]}, expected ${wantEnergy[d]} ` +
          `(window ${wantEnergy.join(',')}; got ${gotEnergy.join(',')})`,
      );
      failures++;
    }
  }
  if (failures === 0) console.log(`${testCase.what}: window matches the grid at all 18 slots`);
}

// THE CONTROL, and it can fail: the window is re-read with the STEP table
// transposed, which is the mistake this probe exists to catch. If a transposed
// expectation also matches what the sim produced, the probe is agreeing with
// whatever the sim does and proves nothing.
{
  let caught = 0;
  for (const testCase of CASES) {
    const { x, y } = testCase;
    const transposed: number[] = [];
    for (let d = 0; d < 9; d++) {
      const [dx, dy] = STEP[d]!;
      const nx = (((x + dy) % SIZE) + SIZE) % SIZE; // axes swapped on purpose
      const ny = (((y + dx) % SIZE) + SIZE) % SIZE;
      transposed.push(senseByte(fixtureEnergy(x, y, nx, ny), DEFAULT_PARAMS.maxEEnergy));
    }
    const index = CASES.indexOf(testCase);
    if (transposed.join(',') !== produced[index]!.join(',')) caught++;
  }
  if (caught !== CASES.length) {
    console.log(
      `CONTROL DEAD — a transposed window matched what the sim produced in ` +
        `${CASES.length - caught} of ${CASES.length} cases, so this probe cannot detect one`,
    );
    failures++;
  } else {
    console.log(`control: a transposed window is distinguishable in all ${CASES.length} cases`);
  }
}

console.log(failures === 0 ? 'clean' : `${failures} failures`);
if (failures > 0) process.exitCode = 1;
