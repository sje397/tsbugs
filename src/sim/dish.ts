/**
 * The world: a grid sharing one flat byte-address space with the creatures.
 *
 * Ported from petri_dish.cpp / petri_dish.h.
 *
 * THE STEP FUNCTION, in the order the original runs it:
 *
 *   1. per active cell — energy flows into bugs, then every bug in that cell
 *      samples its 3x3 senses and runs one VM tick
 *   2. per active cell — bugs move, pay for it, or die
 *   3. per active cell — bugs that want to split reproduce
 *   4. balance() — top up population and grid energy from the world budget
 *   5. time++
 *
 * Upstream runs phases 1-3 through QtConcurrent::blockingMap — one task per
 * active cell. That is a genuine data race, not a performance choice: cells
 * share their borders (a bug's 3x3 window reads its neighbours' bugCol, and
 * balance() did not take the lock at all). This port runs them serially, in
 * listHash order, which is one member of the ensemble the original samples.
 *
 * CELL LISTS. Upstream keys bugs by a `ha sh = x * height + y`, and iterates a
 * flat `listHash` of the occupied cells. Two list mechanics are load-bearing:
 *
 *   - newborns are PREPENDED, movers are APPENDED, so a cell's first bug is
 *     normally its youngest. That matters, because every view mode that shows a
 *     per-bug quantity reads `.first()`.
 *   - a moved bug is marked, and the move phase skips marked bugs. Without it a
 *     bug could be moved again by a later cell, or twice by its own.
 */

import { Bug, DIR_STAY } from './bug.js';
import { CoordPicker } from './coords.js';
import type { RandomSource } from './rng.js';
import { BKG_COLOR, ENERGY_COLOR, MAX_BUG_COLOR, POISON_COLOR, type WorldParams } from './params.js';

/** petri_dish.h:38 — ordinals match the original's menu order. */
export enum ViewMode {
  DEFAULT = 0,
  BUGS = 1,
  ENERGY = 2,
  AGE = 3,
  DNA_SIZE = 4,
  DNA_VALUE = 5,
}

/**
 * The three scalar view modes — energy, age and DNA size — can compute past the
 * end of the bug ramp whenever their value lies outside its configured range,
 * and that is reachable: energy above max_energy, age beyond max_age, DNA size
 * above max_data. Upstream's `unsigned char` return wrapped those mod 256, which
 * puts a maximum-energy bug at the *bottom* of the ramp; saturation is plainly
 * what the formula is reaching for. Held at 1..MAX_BUG_COLOR so the reserved
 * sentinels (253 cyan, 254 poison, 255 energy) stay unreachable.
 */
export function clampByteRamp(value: number): number {
  return value < 1 ? 1 : value > MAX_BUG_COLOR ? MAX_BUG_COLOR : value;
}

/**
 * A sensory reading, scaled into the 0..255 range the VM's input slots hold.
 *
 * Upstream writes `(unsigned char)(value / max * 255)` straight from a float,
 * which is **undefined behaviour in C** whenever that float leaves 0..255. Both
 * channels reach that edge in ordinary play, for different reasons:
 *
 * The energy channel reaches that edge in ordinary play, because deposits are
 * additive with no cap, so a cell's energy can exceed `max_e_energy` (80).
 *
 * Clamping is the intent the formula is reaching for — monotonic in `value`,
 * saturating at both ends. Truncation toward zero is kept, so every in-range
 * reading is identical to the original's. A wrap would not merely be arbitrary:
 * ground of 11 would arrive as 24/255, a hill read as a hollow, inverting the
 * signal the VM evolves against.
 *
 * Terrain used to be the other caller, and the second way to reach the edge: a cell
 * climbing past its nominal divisor on the positive side, one level per death, and a
 * dug hollow on the negative side (DIVERGENCES.md §8). There is no terrain in this
 * port now (§12), so energy is the only caller and only the positive end is reachable
 * from the code as it stands. The negative branch is kept because the formula's
 * failure is symmetric and a caller that scaled a signed quantity would hit it — not
 * because anything in this world does today.
 */
export function senseByte(value: number, max: number): number {
  const scaled = Math.trunc((value / max) * 255);
  return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

/** Shared empty list, so reading an unoccupied cell never allocates. */
const EMPTY: readonly Bug[] = [];

/**
 * What setParams() did with each field it was offered. See the method: `applied`
 * is live on the next tick, `deferred` reaches bugs born after the change,
 * `ignored` cannot mean anything mid-world, and a non-empty `refused` means the
 * whole call was dropped and nothing was applied.
 */
export interface ParamUpdate {
  applied: string[];
  deferred: string[];
  ignored: string[];
  refused: string[];
}

/** Fields the constructor consumes: they size or populate the world's arrays. */
const REBUILD_ONLY = new Set<string>(['width', 'height', 'poison']);

/**
 * Fields each bug's Processor is built with, so a change reaches the next
 * generation rather than the living one.
 */
const PER_BUG = new Set<string>(['stepsPerUpdate', 'stackSize']);

/**
 * The ranges the simulation's own arithmetic needs. Every one of these pairs is
 * divided or scaled by its difference — the energy view by
 * `maxEnergy - minEnergy`, the DNA-size view by `maxData - minData`, and the
 * energy sense by `maxEEnergy` — so a zero or negative span is not a preference
 * to be honoured, it is a division by zero or a sign nobody intended.
 */
const VALID_RANGES: readonly (readonly [keyof WorldParams, keyof WorldParams])[] = [
  ['minData', 'maxData'],
  ['minEnergy', 'maxEnergy'],
  ['minEEnergy', 'maxEEnergy'],
];

/** What check_integrity() reports. Every field is a count or a total it warns on. */
export interface IntegrityReport {
  /** The maintained population counter. */
  population: number;
  /** Bugs actually found on the grid. */
  bugCount: number;
  /** The maintained bug-energy counter. */
  bugEnergy: number;
  /** The bugs' real total energy. */
  summedBugEnergy: number;
  /** The maintained grid-energy counter. */
  energyEnergy: number;
  /** The grid's real total energy. */
  summedCellEnergy: number;
  /** Cells holding bugs but missing from activeCells. */
  unlistedOccupied: number;
  /** Cells listed in activeCells but holding no bugs. */
  listedButEmpty: number;
  overfullBugs: number;
  underfullBugs: number;
  overfullNodes: number;
  underfullNodes: number;
}

export class PetriDish {
  readonly width: number;
  readonly height: number;

  /** Palette index per cell — the original's `viewCol`, and what the renderer blits. */
  readonly viewCol: Uint8Array;

  /**
   * The running parameters. Not readonly: setParams() replaces the struct in
   * place, which is the one way a world's rules can change without rebuilding it.
   */
  private params: WorldParams;
  private readonly rng: RandomSource;

  private readonly energy: Int32Array;
  /** Running total of bug energy per cell. Upstream lets it drift; see removeBug. */
  private readonly bugTotal: Int32Array;
  private readonly poison: Uint8Array;
  /** Per-cell colour of the cell's first bug — the original's `bugCol`. */
  private readonly bugCol: Uint8Array;

  private readonly cells = new Map<number, Bug[]>();
  private readonly activeCells: number[] = [];
  private readonly activeSet = new Set<number>();

  private readonly coords = new CoordPicker();
  /** VM input slots 0-8: the 3x3 window of view colours. */
  private readonly vision = new Uint8Array(9);
  /** VM input slots 9-17: the 3x3 window of grid-energy readings. */
  private readonly energySense = new Uint8Array(9);

  bugEnergy = 0;
  energyEnergy = 0;
  population = 0;
  time = 0;
  maxGen = 0;
  maxAge = 0;

  viewMode: ViewMode = ViewMode.DEFAULT;
  showByte = 0;

  /** Cumulative reproduction births, and deaths of all causes. */
  births = 0;
  deaths = 0;

  /**
   * Bugs balance() added to hold the world at its minimum energy — not in
   * upstream, which reports no such figure.
   *
   * It earns its place because without it the population statistics lie about what
   * the population is doing. balance() tops the world back up with *generation 0*
   * bugs whenever bug energy falls below minBugEnergy, and that turns out to be
   * most of what a world does: over 2000 ticks of the flat fingerprint world, 583
   * bugs were injected against 178 births — 3.3 top-ups per birth — while the mean
   * generation sat below 0.5 and maxGen, which is reset at the top of every tick,
   * wandered between 2 and 5. A mean generation under 0.5 means most of the
   * population is generation zero by arithmetic, since generations are
   * non-negative integers — which is why nothing looks like it is evolving.
   * Measured by tools/population-probe.mts.
   */
  injected = 0;

  constructor(params: WorldParams, rng: RandomSource) {
    this.params = params;
    this.rng = rng;
    this.width = params.width;
    this.height = params.height;

    const cellCount = this.width * this.height;
    this.energy = new Int32Array(cellCount);
    this.bugTotal = new Int32Array(cellCount);
    this.poison = new Uint8Array(cellCount);
    this.bugCol = new Uint8Array(cellCount);
    this.viewCol = new Uint8Array(cellCount);

    let count = params.poison;
    while (count > 0) {
      const hash = rng.int(this.width) * this.height + rng.int(this.height);
      if (!this.poison[hash]) {
        this.poison[hash] = 1;
        count--;
      }
    }

    this.updateAllPixels();
  }

  get activeCellCount(): number {
    return this.activeCells.length;
  }

  get totalEnergy(): number {
    return this.params.totalEnergy;
  }

  /**
   * The live parameters, as a copy — setParams is the only writer, and a caller
   * that could hold the struct could also quietly change the world's rules
   * without any of setParams' reporting. A copy costs an object per read and
   * makes that impossible rather than merely discouraged.
   */
  get worldParams(): Readonly<WorldParams> {
    return { ...this.params };
  }

  /**
   * Change a world's parameters in place, and say what that meant.
   *
   * Upstream's Settings dialog rebuilt a `WorldParams` and called
   * `set_world_params()`, which copied the struct and did nothing else — so a
   * field the step phase happens to read took effect at once, and a field
   * consumed at construction time silently did nothing at all. The dialog offered
   * both kinds with no way to tell them apart. That distinction is real, so it is
   * returned rather than rediscovered:
   *
   *  - `applied`  — read by the step phase or balance(); live on the next tick.
   *  - `deferred` — stepsPerUpdate and stackSize, which each bug's Processor is
   *                 built with; they reach bugs born after the change, and leave
   *                 the living generation as it was built.
   *  - `ignored`  — width, height and poison, which size or populate the arrays in
   *                 the constructor. They are refused rather than half-applied:
   *                 a `params.width` that disagrees with the grid is worse than a
   *                 field that plainly did nothing, so the merge leaves them out
   *                 and the caller rebuilds the world if it wants them.
   *
   * Atomic. If the merged set breaks a range the simulation's own arithmetic needs
   * (minData/maxData, minEnergy/maxEnergy, minEEnergy/maxEEnergy), it refuses the
   * whole set and names why — half a world applied is a state nobody can reason
   * about afterwards.
   */
  setParams(next: Partial<WorldParams>): ParamUpdate {
    const applied: string[] = [];
    const deferred: string[] = [];
    const ignored: string[] = [];

    const merged: WorldParams = { ...this.params };
    const writable = merged as unknown as Record<string, unknown>;
    for (const key of Object.keys(next) as (keyof WorldParams)[]) {
      const value = next[key];
      if (value === undefined) continue;
      if (REBUILD_ONLY.has(key)) {
        ignored.push(key);
        continue;
      }
      if (PER_BUG.has(key)) deferred.push(key);
      else applied.push(key);
      writable[key] = value;
    }

    const refused: string[] = [];
    for (const [low, high] of VALID_RANGES) {
      const min = merged[low];
      const max = merged[high];
      if (!(min < max)) refused.push(`${low} (${min}) must be below ${high} (${max})`);
    }
    // A refusal changes nothing, so nothing is reported as applied.
    if (refused.length > 0) return { applied: [], deferred: [], ignored: [], refused };

    this.params = merged;
    return { applied, deferred, ignored, refused };
  }

  /** petri_dish.cpp:667 */
  step(): void {
    this.maxGen = 0;
    this.maxAge = 0;

    // 1. eating and seeing. Nothing here adds or removes cells, so iterating
    //    the live array is safe (upstream parallelises this phase instead).
    for (const hash of this.activeCells) this.doEatingAndSeeing(hash);

    // 2. update, move, charge energy, remove the dead
    const newPositions = new Set<number>();

    for (let index = 0; index < this.activeCells.length; ) {
      const hash = this.activeCells[index];
      const bugs = this.cells.get(hash);
      if (bugs === undefined) throw new Error(`active cell ${hash} has no bug list`);

      const x = Math.trunc(hash / this.height);
      const y = hash % this.height;
      let emptied = false;

      for (let j = 0; j < bugs.length; ) {
        const bug = bugs[j];

        if (bug.marked) {
          j++;
          continue;
        }

        const e = bug.energy;
        const dir = bug.dir;
        let nx: number;
        let ny: number;
        let moveCost: number;

        if (dir === DIR_STAY) {
          moveCost = this.params.stayEnergy;
          nx = x;
          ny = y;
        } else {
          if (this.params.killOnEdge) {
            nx = offX(dir, x);
            ny = offY(dir, y);
          } else {
            nx = wrapX(dir, x, this.width);
            ny = wrapY(dir, y, this.height);
          }

          // Flat ground: a move costs one price, whatever the destination.
          moveCost = this.params.moveEnergy;
        }

        if (
          bug.age >= this.params.maxAge ||
          e - moveCost < this.params.minEnergy ||
          nx < 0 || nx >= this.width || ny < 0 || ny >= this.height ||
          this.poison[nx * this.height + ny]
        ) {
          bugs.splice(j, 1);
          if (bugs.length === 0) emptied = true;
          this.removeBug(e, hash);
          continue; // the next bug has shifted into slot j
        }

        this.bugEnergy -= moveCost;
        bug.decEnergy(moveCost);
        if (bug.age > this.maxAge) this.maxAge = bug.age;
        if (bug.generation > this.maxGen) this.maxGen = bug.generation;

        if (dir === DIR_STAY) {
          // Energy stays in the cell but the running total still pays the cost,
          // so bugTotal drifts down for every staying bug, every tick.
          this.bugTotal[hash] -= moveCost;
          bug.marked = true;
          j++;
        } else {
          this.bugTotal[hash] -= e;
          bugs.splice(j, 1);
          if (bugs.length === 0) emptied = true;

          const destination = nx * this.height + ny;
          newPositions.add(destination);
          const arrivals = this.cells.get(destination);
          if (arrivals === undefined) this.cells.set(destination, [bug]);
          else arrivals.push(bug);
          this.bugTotal[destination] += e - moveCost;

          bug.marked = true;
          // j is unchanged: the next bug has shifted into slot j.
        }
      }

      if (emptied) {
        this.activeSet.delete(hash);
        this.activeCells.splice(index, 1);
      } else {
        index++;
      }
      this.updatePixel(hash);
    }

    for (const hash of newPositions) {
      if (!this.activeSet.has(hash)) {
        this.activeSet.add(hash);
        this.activeCells.push(hash);
        this.updatePixel(hash);
      }
    }

    // 3. have babies
    for (const hash of this.activeCells) this.replicate(hash);

    // 4. top up from the world budget
    this.balance();

    this.time++;
  }

  /** petri_dish.cpp:495 */
  private doEatingAndSeeing(hash: number): void {
    const bugs = this.cells.get(hash);
    // Upstream prints "0!!!(1)" here. The guard is unreachable in steady state —
    // checkIntegrity() asserts the matching invariant (listedButEmpty) rather
    // than counting a branch that upstream only ever reaches defensively.
    if (bugs === undefined || bugs.length === 0) return;

    const size = bugs.length;
    const { maxEnergy, minEEnergy } = this.params;

    // Energy flows from the cell into its bugs, in list order, stopping early
    // for each bug once it is full.
    let energyToBugs = 0;
    let energySubmerged = 0;

    if (this.energy[hash] > 0 && this.bugTotal[hash] < maxEnergy * size) {
      for (const bug of bugs) {
        const e = bug.energy;
        if (this.energy[hash] >= maxEnergy - e) {
          const amount = maxEnergy - e;
          bug.incEnergy(amount);
          energyToBugs += amount;
          this.energy[hash] -= amount;
        } else {
          bug.incEnergy(this.energy[hash]);
          energyToBugs += this.energy[hash];
          this.energy[hash] = 0;
        }
      }

      // Sub-threshold remainder in a cell with bugs is discarded outright.
      if (this.energy[hash] < minEEnergy) {
        energySubmerged += this.energy[hash];
        this.energy[hash] = 0;
      }
    }

    // NOTE: bugTotal is deliberately NOT updated here — upstream only ever adds
    // to it in balance() and subtracts in the move phase and removeBug. That is
    // a defect, and it is load-bearing for behaviour: bugTotal drifts, so the
    // `bugTotal < maxEnergy * size` gate above eventually stops constraining
    // anything. Carried over deliberately — see DIVERGENCES.md §14.
    this.bugEnergy += energyToBugs;
    this.energyEnergy -= energyToBugs + energySubmerged;

    // All bugs in a cell see the same window, sampled once before any of them
    // runs: a bug cannot observe the consequences of another bug's tick.
    const x = Math.trunc(hash / this.height);
    const y = hash % this.height;
    this.sampleSenses(x, y);

    for (const bug of bugs) {
      bug.setSenses(this.vision, this.energySense);
      bug.marked = false;
      bug.update();
    }
  }

  /**
   * petri_dish.cpp:589-592, reduced to the channels that still exist: the two
   * getters that were crossed there are now one correctly-routed reading each.
   *
   * There was a third group here — nine slots fed a constant, kept because
   * upstream's 29-slot layout was treated as the genome's contract. It is gone
   * (DIVERGENCES.md §13) along with the switch that chose between the intended
   * channels and the shipped ones: one sensory model, the intended one.
   */
  private sampleSenses(x: number, y: number): void {
    this.getVisionAt(x, y);
    this.getEnergyAt(x, y);
  }

  /**
   * petri_dish.cpp:308, 321, 334 — the three 3x3 sense windows.
   *
   * WRAP_X/WRAP_Y are total: they always return an in-range coordinate. The
   * `kill_on_edge` guard the original carries in all three getters is therefore
   * unreachable — that flag only bites in the move phase, which uses the raw
   * X/Y forms. The consequence is that a bug at the world edge sees through to
   * the opposite edge whatever kill_on_edge says.
   */
  private getVisionAt(x: number, y: number): void {
    for (let d = 0; d < 9; d++) {
      const nx = wrapX(d, x, this.width);
      const ny = wrapY(d, y, this.height);
      this.vision[d] = this.bugCol[nx * this.height + ny];
    }
  }

  private getEnergyAt(x: number, y: number): void {
    for (let d = 0; d < 9; d++) {
      const nx = wrapX(d, x, this.width);
      const ny = wrapY(d, y, this.height);
      this.energySense[d] = senseByte(this.energy[nx * this.height + ny], this.params.maxEEnergy);
    }
  }

  /** petri_dish.cpp:616 */
  private replicate(hash: number): void {
    const bugs = this.cells.get(hash);
    if (bugs === undefined) return;

    const size = bugs.length;
    if (size <= 1) return;

    // A bug is considered as a mother exactly once per tick, and the partner is
    // drawn from the pre-tick list. Upstream iterates bugList[hash] while
    // prepending newborns to it, and reads the partner from that same live list
    // via `.at(i2)`; whether the iterator or `at()` can see a newborn depends on
    // QList's internal layout and is not knowable from the source. The i1/i2
    // index juggling below only makes sense against a stable list, so that is
    // the reading this port takes — and it is the only one that makes "a bug
    // reproduces at most once per tick" true.
    const mothers = bugs.slice();
    let i1 = 0;

    for (const mum of mothers) {
      if (mum.energy >= this.params.childEnergy + this.params.minEnergy) {
        // Upstream's `r = qrand() % 255 + 1` is commented out; the live value is
        // a literal 128. So the threshold carries no draw, and a bug splits
        // whenever its split output is below 128 — i.e. half of all values.
        const threshold = 128;

        if (mum.split < threshold) {
          let i2 = this.rng.int(size - 1);
          if (i2 >= i1) i2++;
          const dad = mothers[i2];

          if (dad.split < threshold) {
            const child = Bug.createChild(mum, dad, this.params, this.rng);
            child.energy = this.params.childEnergy;
            mum.decEnergy(this.params.childEnergy);

            bugs.unshift(child);
            // Upstream's refresh here is commented out (:647, as is the x/y it
            // would need at :620, so it could not have compiled). A cell that
            // gains a newborn therefore keeps its pre-birth colour until the
            // next tick's move phase sweeps every active cell.
            //
            // That is a defect, not a behaviour. Unshifting the newborn exists
            // precisely so it becomes bugs[0] — the bug every per-bug view mode
            // renders — so leaving the cell stale means the newborn is invisible
            // for a tick. This port refreshes it. See DIVERGENCES.md.
            this.updatePixel(hash);
            this.population++;
            this.births++;
            if (child.generation > this.maxGen) this.maxGen = child.generation;
          }
        }
      }
      i1++;
    }
  }

  /** petri_dish.cpp:410 */
  private balance(): void {
    const { maxEnergy, minEnergy, maxEEnergy } = this.params;
    let remainingEnergy = this.params.totalEnergy - this.bugEnergy - this.energyEnergy;
    let hash = 0;

    // New bugs, until the population carries enough energy to sustain itself.
    while (this.bugEnergy < this.params.minBugEnergy && remainingEnergy >= maxEnergy) {
      const e = Math.trunc(this.rng.float() * (maxEnergy - minEnergy)) + minEnergy;

      do {
        this.coords.pick(this.params.energyLayout, this.width, this.height, this.time, this.rng);
        hash = this.coords.x * this.height + this.coords.y;
      } while (this.poison[hash]);

      this.bugEnergy += e;
      remainingEnergy -= e;

      const bug = Bug.createRandom(this.params, this.rng);
      bug.energy = e;
      this.bugTotal[hash] += e;
      this.population++;
      this.injected++;

      if (!this.activeSet.has(hash)) {
        this.activeSet.add(hash);
        this.activeCells.push(hash);
      }
      const list = this.cells.get(hash);
      if (list === undefined) this.cells.set(hash, [bug]);
      else list.unshift(bug);

      this.updatePixel(hash);
    }

    // New grid energy, until the world holds its target reserve.
    while (this.energyEnergy < this.params.minEnergyEnergy && remainingEnergy >= maxEEnergy) {
      do {
        this.coords.pick(this.params.energyLayout, this.width, this.height, this.time, this.rng);
        hash = this.coords.x * this.height + this.coords.y;
      } while (this.poison[hash]);

      const maxE = maxEEnergy - this.energy[hash];
      const minE = minEnergy - this.energy[hash];

      let e: number;
      if (minE > 0) {
        e = maxE > minE ? Math.trunc(this.rng.float() * (maxE - minE)) + minE : minE;
      } else {
        // Already holding at least minEnergy: pick another spot without
        // consuming any budget.
        continue;
      }

      this.energyEnergy += e;
      remainingEnergy -= e;
      this.energy[hash] += e;
      this.updatePixel(hash);
    }
  }

  /**
   * petri_dish.cpp:474-484.
   *
   * A dead bug's energy simply vanishes — it is subtracted from bugEnergy and
   * from the cell total but is not returned to `energy`, so the world's total is
   * not conserved. Upstream also deposits the dying bug's payload onto the
   * ground here; there is no ground to deposit onto.
   */
  private removeBug(e: number, hash: number): void {
    this.bugEnergy -= e;
    this.population--;
    this.deaths++;
    this.bugTotal[hash] -= e;
  }

  // -------------------------------------------------------------- inspection

  energyAt(hash: number): number {
    return this.energy[hash];
  }

  /**
   * The cell's running bug-energy total. Upstream lets this drift away from the
   * bugs' real energy (see doEatingAndSeeing), which is worth being able to see
   * rather than infer.
   */
  bugTotalAt(hash: number): number {
    return this.bugTotal[hash];
  }

  isPoisoned(hash: number): boolean {
    return this.poison[hash] === 1;
  }

  /** The bugs standing on a cell, in list order — first is normally the youngest. */
  bugsAt(hash: number): readonly Bug[] {
    return this.cells.get(hash) ?? EMPTY;
  }

  /**
   * Every live bug, walking the grid in the order the step phase does, with the
   * cell each one stands on. There is no flat list of bugs to hand out, and the
   * population statistics and the gene histogram both need the whole population,
   * so this is the one walk they share.
   */
  forEachBug(visit: (bug: Bug, hash: number) => void): void {
    for (const hash of this.activeCells) {
      for (const bug of this.cells.get(hash) ?? EMPTY) visit(bug, hash);
    }
  }

  /**
   * petri_dish.cpp:888. Upstream reports each anomaly with qDebug(); this
   * returns them, so the invariants can be asserted rather than watched for.
   */
  checkIntegrity(): IntegrityReport {
    let bugCount = 0;
    let summedBugEnergy = 0;
    let overfullBugs = 0;
    let underfullBugs = 0;
    let summedCellEnergy = 0;
    let overfullNodes = 0;
    let underfullNodes = 0;
    let unlistedOccupied = 0;

    for (const [hash, bugs] of this.cells) {
      if (bugs.length === 0) continue;
      if (!this.activeSet.has(hash)) unlistedOccupied++;
      for (const bug of bugs) {
        bugCount++;
        summedBugEnergy += bug.energy;
        if (bug.energy > this.params.maxEnergy) overfullBugs++;
        if (bug.energy < this.params.minEnergy) underfullBugs++;
      }
    }

    for (let hash = 0; hash < this.energy.length; hash++) {
      const e = this.energy[hash];
      if (e === 0) continue;
      summedCellEnergy += e;
      if (e > this.params.maxEEnergy) overfullNodes++;
      if (e < this.params.minEEnergy) underfullNodes++;
    }

    let listedButEmpty = 0;
    for (const hash of this.activeCells) {
      const bugs = this.cells.get(hash);
      if (bugs === undefined || bugs.length === 0) listedButEmpty++;
    }

    return {
      listedButEmpty,
      population: this.population,
      bugCount,
      bugEnergy: this.bugEnergy,
      summedBugEnergy,
      energyEnergy: this.energyEnergy,
      summedCellEnergy,
      unlistedOccupied,
      overfullBugs,
      underfullBugs,
      overfullNodes,
      underfullNodes,
    };
  }

  // ---------------------------------------------------------------- rendering

  private updatePixel(hash: number): void {
    this.bugCol[hash] = this.findBugColorAt(hash);
    this.viewCol[hash] = this.findViewColorAt(hash);
  }

  /** petri_dish.cpp:233 — x outer, y inner, which over this hash layout is 0..n. */
  updateAllPixels(): void {
    for (let hash = 0; hash < this.viewCol.length; hash++) this.updatePixel(hash);
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.updateAllPixels();
  }

  setShowByte(byte: number): void {
    this.showByte = byte;
    this.updateAllPixels();
  }

  /** petri_dish.cpp:247 */
  private findBugColorAt(hash: number): number {
    const bugs = this.cells.get(hash);
    if (bugs !== undefined && bugs.length > 0) {
      return (bugs[0].color % MAX_BUG_COLOR) + 1;
    }
    if (this.poison[hash]) return POISON_COLOR;
    if (this.energy[hash]) return ENERGY_COLOR;
    return BKG_COLOR;
  }

  /** petri_dish.cpp:261 — every per-bug mode reads the cell's FIRST bug. */
  private findViewColorAt(hash: number): number {
    const bugs = this.cells.get(hash);
    const hasBugs = bugs !== undefined && bugs.length > 0;

    switch (this.viewMode) {
      case ViewMode.DEFAULT:
        return this.bugCol[hash];

      case ViewMode.BUGS:
        if (hasBugs) return this.bugCol[hash];
        break;

      case ViewMode.ENERGY:
        if (hasBugs) {
          return clampByteRamp(
            Math.trunc(
              ((MAX_BUG_COLOR - 1) * (bugs[0].energy - this.params.minEnergy)) /
                (this.params.maxEnergy - this.params.minEnergy),
            ) + 1,
          );
        }
        break;

      case ViewMode.AGE:
        if (hasBugs) {
          return clampByteRamp(
            Math.trunc(
              (MAX_BUG_COLOR - 1) - ((MAX_BUG_COLOR - 1) * bugs[0].age) / this.params.maxAge,
            ) + 1,
          );
        }
        break;

      case ViewMode.DNA_SIZE:
        if (hasBugs) {
          return clampByteRamp(
            Math.trunc(
              ((MAX_BUG_COLOR - 1) * (bugs[0].dna.size - this.params.minData)) /
                (this.params.maxData - this.params.minData),
            ) + 1,
          );
        }
        break;

      case ViewMode.DNA_VALUE:
        if (hasBugs) {
          const dna = bugs[0].dna.data;
          if (dna.length > this.showByte) return (dna[this.showByte] % MAX_BUG_COLOR) + 1;
        }
        break;

    }

    return BKG_COLOR;
  }
}

// ------------------------------------------------------------------- macros

/** petri_dish.h:25 */
export function wrapX(d: number, x: number, width: number): number {
  if (d % 3 === 0) return x === 0 ? width - 1 : x - 1;
  if (d % 3 === 2) return x === width - 1 ? 0 : x + 1;
  return x;
}

/** petri_dish.h:26 */
export function wrapY(d: number, y: number, height: number): number {
  const q = Math.trunc(d / 3);
  if (q === 0) return y === 0 ? height - 1 : y - 1;
  if (q === 2) return y === height - 1 ? 0 : y + 1;
  return y;
}

/** petri_dish.h:28 */
export function offX(d: number, x: number): number {
  if (d % 3 === 0) return x - 1;
  if (d % 3 === 2) return x + 1;
  return x;
}

/** petri_dish.h:29 */
export function offY(d: number, y: number): number {
  const q = Math.trunc(d / 3);
  if (q === 0) return y - 1;
  if (q === 2) return y + 1;
  return y;
}
