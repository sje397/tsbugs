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
import type { RandomSource } from './rng.js';
import type { WorldParams } from './params.js';

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
  action: number;

  /** Terrain currently being carried. */
  payload = 0;
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
    this.action = processor.readOut(3);
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

  /** bug.cpp:105 — the 3x3 senses, in channel order. */
  setVision(vision: Uint8Array, altitude: Uint8Array, energy: Uint8Array): void {
    this.processor.setInMulti(0, vision);
    this.processor.setInMulti(9, altitude);
    this.processor.setInMulti(18, energy);
  }

  /** bug.cpp:116 — one VM tick and its consequences. */
  update(): void {
    // The bug's own energy is exposed as a 16-bit little-endian pair.
    this.processor.setIn(27, Math.trunc(this.energy / 256) & 0xff);
    this.processor.setIn(28, this.energy % 256);

    this.processor.run();

    this.dir = (this.processor.readOut(0) + DIR_STAY) % 9;
    this.color = this.processor.readOut(1);
    this.split = this.processor.readOut(2);
    this.action = this.processor.readOut(3);
    this.age++;
  }

  /** energy_node.h — plain ints with no clamping, upstream included. */
  incEnergy(amount: number): void {
    this.energy += amount;
  }

  decEnergy(amount: number): void {
    this.energy -= amount;
  }
}
