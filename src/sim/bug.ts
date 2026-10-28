/**
 * A single creature: genome, virtual machine, and the state it carries.
 *
 * Ported from bug.h / bug.cpp / energy_node.h.
 *
 * NOT PORTED, DELIBERATELY: `EnergyNode`'s x/y (it derives from QPoint). They
 * are written from the mother in the child constructors and never read by any
 * simulation logic — positions live in the cell lists, keyed by hash. They are
 * dead state upstream. The `mum`/`dad` QPointers are likewise display-only, and
 * carrying them here would keep dead creatures reachable from live ones.
 */

import { Dna } from './dna.js';
import { Processor } from './processor.js';
import type { ProcessorState } from './processor.js';
import type { RandomSource } from './rng.js';
import type { WorldParams } from './params.js';

/**
 * Everything a Bug is, as `snapshotState()` produces it.
 *
 * The genome and the processor state are separate because they are separate
 * things in the model: the machine starts with a copy of the genome and diverges
 * from it wherever the program stores over itself. A snapshot that carried only
 * one of them would restore a bug that either forgets what it inherited or forgets
 * what it has done.
 */
export interface BugState {
  genome: Uint8Array;
  mutationRate: number;
  processor: ProcessorState;
  dir: number;
  color: number;
  split: number;
  age: number;
  children: number;
  generation: number;
  energy: number;
  /** Set by the move phase; cleared at the top of the next tick's run phase. */
  marked: boolean;
}

/** Sense channels are 3x3 windows. */
export const SENSE_SLOTS = 9;

/** bug.cpp: direction output is offset by 4 so that all-zero output means "stay". */
export const DIR_STAY = 4;

export class Bug {
  readonly dna: Dna;
  readonly processor: Processor;

  /** 0-8: 0-2 left, 3-5 stay, 6-8 right, crossed with up/stay/down. */
  dir: number;
  /** VM output 1, written raw on update — note the constructor clamps it, update does not. */
  color: number;
  split: number;
  age = 0;
  children = 0;
  generation = 0;
  /** Set by the move phase so a bug that has moved is not processed twice. */
  marked = false;
  energy = 0;

  private constructor(dna: Dna, processor: Processor) {
    this.dna = dna;
    this.processor = processor;
    // All four outputs are zero on a fresh processor.
    this.dir = (processor.readOut(0) + DIR_STAY) % 9;
    this.color = (processor.readOut(1) % 254) + 1;
    this.split = processor.readOut(2);
  }

  /** bug.cpp:30 — a founder: `max_data`-bounded random genome, random bytes. */
  static createRandom(params: WorldParams, rng: RandomSource): Bug {
    // `qrand() % (max - min)`, never the whole closed range.
    const dataSize = params.maxData > params.minData
      ? rng.int(params.maxData - params.minData) + params.minData
      : params.minData;

    const genome = new Uint8Array(dataSize);
    // `qrand() % 256` here, unlike the mutation path's `% 0xff`.
    for (let i = 0; i < dataSize; i++) genome[i] = rng.int(256);

    const dna = new Dna(genome, params.mutation, rng);
    return new Bug(dna, new Processor(genome, params.stepsPerUpdate, params.stackSize, rng));
  }

  /** bug.cpp:57 — a child of two parents. */
  static createChild(mum: Bug, dad: Bug, params: WorldParams, rng: RandomSource): Bug {
    const dna = new Dna(new Uint8Array(0), params.mutation, rng);
    dna.blend(mum.dna, dad.dna, params.maxData, params.minData);

    mum.children++;
    dad.children++;

    const child = new Bug(
      dna,
      new Processor(dna.data, params.stepsPerUpdate, params.stackSize, rng),
    );
    child.generation = Math.max(mum.generation, dad.generation) + 1;
    return child;
  }

  /**
   * bug.cpp:105, minus the altitude channel that no longer exists (DIVERGENCES.md
   * §13) — colour 0-8, energy 9-17. Upstream's method is `set_vision`, which
   * named one of the three channels it carried; two channels in, it is renamed
   * for what it does.
   */
  setSenses(vision: Uint8Array, energy: Uint8Array): void {
    this.processor.setInMulti(0, vision);
    this.processor.setInMulti(9, energy);
  }

  /** bug.cpp:116 — one VM tick and its consequences. */
  update(): void {
    // The bug's own energy is exposed as 16 bits split HIGH byte first: slot 18
    // is energy / 256, slot 19 is energy % 256, so it is read as in18*256 + in19.
    // Not the low-byte-first order the two-byte ADDRESS operands use — those are
    // low first, this is not, and calling both "little-endian" is how a program
    // written against this comment reads its own energy as (lo<<8)+hi. It is also
    // not a 16-bit word the VM can load: only these two bytes carry it.
    // Upstream's slots 27/28, moved down with the altitude group's removal (§13).
    this.processor.setIn(18, Math.trunc(this.energy / 256) & 0xff);
    this.processor.setIn(19, this.energy % 256);

    this.processor.run();

    this.dir = (this.processor.readOut(0) + DIR_STAY) % 9;
    this.color = this.processor.readOut(1);
    this.split = this.processor.readOut(2);
    this.age++;
  }

  /**
   * Write one byte of this bug's program, and say what was there before.
   *
   * A byte of code lives in two places on a bug, and they are not the same place:
   * the processor runs its own copy of the genome (processor.ts note 3), while the
   * children this bug produces are built from its Dna. Writing only the machine
   * changes what runs and is discarded the moment the world is saved and reloaded
   * through the genome; writing only the Dna changes what is inherited and is not
   * executed by the bug itself, which is the shape of a fix that appears to do
   * nothing. An editor means both, so this writes both and the two arrays keep the
   * length they started with — the processor is built from this Dna's buffer, so
   * they are the same array length by construction (the check in `restore` is the
   * same invariant, and a snapshot that broke it is refused there).
   *
   * The returned previous byte is what makes an edit reportable: the page says
   * what it replaced, rather than asserting that something changed.
   */
  patchCode(address: number, value: number): number {
    const previous = this.processor.writeRam(address, value);
    this.dna.data[address] = value;
    return previous;
  }

  /** This bug, whole, as data that can be put back with `restore`. */
  snapshotState(): BugState {
    return {
      genome: this.dna.data.slice(),
      mutationRate: this.dna.mutationRate,
      processor: this.processor.snapshotState(),
      dir: this.dir,
      color: this.color,
      split: this.split,
      age: this.age,
      children: this.children,
      generation: this.generation,
      energy: this.energy,
      marked: this.marked,
    };
  }

  /**
   * Rebuild a bug from `snapshotState()`. Throws on a state that could not have
   * come from one — a state whose genome and program disagree in length, or whose
   * fields are not the shapes the simulation indexes.
   *
   * The processor's own restore does the same check for its half and names what
   * failed; this one adds the two cross-checks that span both halves.
   */
  static restore(state: BugState, params: WorldParams, rng: RandomSource): Bug {
    if (state.genome.length === 0) throw new Error('bug state has an empty genome');
    if (state.processor.ram.length !== state.genome.length) {
      throw new Error(
        `genome is ${state.genome.length} bytes but the program is ${state.processor.ram.length} — ` +
        'a bug whose genome and machine differ in length was not built by this simulation',
      );
    }
    for (const [name, value] of [
      ['dir', state.dir], ['color', state.color], ['split', state.split], ['age', state.age],
      ['children', state.children], ['generation', state.generation], ['energy', state.energy],
    ] as const) {
      if (!Number.isFinite(value)) throw new Error(`bug state field ${name} is ${value}`);
    }

    // Copied, not adopted: a Dna holds the array it is given, so adopting the
    // snapshot's would make the snapshot a live part of the world — and restoring
    // the same snapshot twice would hand the second restore a genome the first
    // had already changed.
    const dna = new Dna(state.genome.slice(), state.mutationRate, rng);
    const processor = Processor.restore(
      state.processor, params.stepsPerUpdate, params.stackSize, rng,
    );
    const bug = new Bug(dna, processor);

    // The constructor derives these three from the outputs; a snapshot is
    // authoritative about them because `update` writes `color` raw while the
    // constructor clamps it, so the two disagree for the same outputs.
    bug.dir = state.dir;
    bug.color = state.color;
    bug.split = state.split;
    bug.age = state.age;
    bug.children = state.children;
    bug.generation = state.generation;
    bug.energy = state.energy;
    bug.marked = state.marked;
    return bug;
  }

  /** energy_node.h — plain ints with no clamping, upstream included. */
  incEnergy(amount: number): void {
    this.energy += amount;
  }

  decEnergy(amount: number): void {
    this.energy -= amount;
  }
}
