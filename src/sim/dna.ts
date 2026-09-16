/**
 * Genome and mutation.
 *
 * Ported from dna.h / dna.cpp.
 *
 * The genome is a variable-length byte array: bug adds and removes chunks, so
 * it drifts inside [minData, maxData) across generations. That is why the VM's
 * operand fetch is both indirect AND variable-length — there is no fixed stride
 * anywhere in this simulation.
 *
 * NOT PORTED, DELIBERATELY: `set_from()` and the single-parent `Bug(parent, ...)`
 * constructor exist upstream but are unreachable — the only caller is inside a
 * commented-out block in petri_dish.cpp (the "just create copies" path). Carrying
 * them across would be porting dead code.
 */

import type { RandomSource } from './rng.js';

/** dna.cpp:4 — the value that marks a crossover point inside a genome. */
export const CROSSOVER_VAL = 0;

export interface MutationTable {
  addChunk: number;
  removeChunk: number;
  moveChunk: number;
  reverseSection: number;
  swapBit: number;
  randomByte: number;
  addCrossover: number;
}

/** dna.cpp:6-14 — `default_mutation_table`. */
export const DEFAULT_MUTATION_TABLE: MutationTable = {
  addChunk: 0.011,
  removeChunk: 0.009,
  moveChunk: 0.1,
  reverseSection: 0.01,
  swapBit: 0.58,
  randomByte: 0.29,
  addCrossover: 0,
};

export class Dna {
  private bytes: Uint8Array;
  private mutation: number;
  private readonly rng: RandomSource;
  private readonly table: MutationTable;

  /**
   * Length changes replace the buffer rather than maintaining capacity. Size
   * changes are ~6.5% of reproductions (half mutate, and only add/remove/move
   * change length out of the seven mutation kinds), so this costs a few small
   * allocations per tick and keeps every operation obviously correct.
   */
  constructor(bytes: Uint8Array, mutation: number, rng: RandomSource, table = DEFAULT_MUTATION_TABLE) {
    this.bytes = bytes;
    this.mutation = mutation;
    this.rng = rng;
    this.table = table;
  }

  get data(): Uint8Array {
    return this.bytes;
  }

  get size(): number {
    return this.bytes.length;
  }

  get mutationRate(): number {
    return this.mutation;
  }

  set mutationRate(value: number) {
    this.mutation = value;
  }

  /** dna.cpp:22 — the two-parent crossover. */
  blend(mum: Dna, dad: Dna, maxSize: number, minSize: number): void {
    const mumData = mum.bytes;
    const dadData = dad.bytes;
    const out = new Uint8Array(Math.max(mumData.length, dadData.length));

    let combo = this.rng.int(2);
    let current = combo ? mumData : dadData;
    let other = combo === 0 ? mumData : dadData;

    let i = 0;
    for (; i < current.length; i++) {
      if (i < other.length) {
        // Low nibble from `current`, high nibble from `other`.
        out[i] = (current[i] & 0x0f) + (other[i] & 0xf0);

        // Switch parents only where BOTH carry a crossover marker, so markers
        // cannot accumulate across generations.
        if (current[i] === CROSSOVER_VAL && other[i] === CROSSOVER_VAL) {
          combo = (combo + 1) % 2;
          current = combo ? mumData : dadData;
          other = combo === 0 ? mumData : dadData;
        }
      } else {
        out[i] = current[i];
      }
    }

    // The loop bound is the *current* parent's length, which may have shrunk
    // mid-pass when the parents were swapped.
    this.bytes = out.subarray(0, i);
    this.mutate(maxSize, minSize);
  }

  /** dna.cpp:57 — one mutation, chosen by the cumulative table. */
  mutate(maxSize: number, minSize: number): void {
    if (this.rng.float() >= this.mutation) return;

    // Thresholds are cumulative: subtract as you go, exactly as the original
    // does. Because the table sums to 1.0, addCrossover is unreachable — it is
    // 0.00f upstream and stays dead here rather than being quietly dropped, so
    // the table remains a faithful copy of the original's.
    let r = this.rng.float();

    if (r < this.table.addChunk) return this.addChunk(maxSize);
    r -= this.table.addChunk;

    if (r < this.table.removeChunk) return this.removeChunk(minSize);
    r -= this.table.removeChunk;

    if (r < this.table.moveChunk) return this.moveChunk();
    r -= this.table.moveChunk;

    if (r < this.table.reverseSection) return this.reverseSection();
    r -= this.table.reverseSection;

    if (r < this.table.swapBit) {
      const pos = this.rng.int(this.bytes.length);
      const mask = 1 << this.rng.int(8);
      this.bytes[pos] = this.bytes[pos] ^ mask;
      return;
    }
    r -= this.table.swapBit;

    if (r < this.table.randomByte) {
      // `qrand() % 0xff` — cannot produce 255.
      this.bytes[this.rng.int(this.bytes.length)] = this.rng.int(0xff);
      return;
    }
    r -= this.table.randomByte;

    if (r < this.table.addCrossover) {
      this.bytes[this.rng.int(this.bytes.length)] = CROSSOVER_VAL;
    }
  }

  /** dna.cpp:104. */
  private addChunk(maxSize: number): void {
    if (this.bytes.length >= maxSize) return;

    const size = this.bytes.length;
    // qMin(maxSize - size, size) is always >= 1 here: the guard above bounds
    // maxSize - size, and genomes are never shorter than minData.
    const len = this.rng.int(Math.min(maxSize - size, size));
    const pos2 = this.rng.int(size - len);
    const pos1 = this.rng.int(size);

    if (len > 0) this.insert(pos1, this.slice(pos2, len));
  }

  /** dna.cpp:114. */
  private removeChunk(minSize: number): void {
    if (this.bytes.length <= minSize) return;

    const size = this.bytes.length;
    const len = this.rng.int(size - minSize);
    const pos = this.rng.int(size - len);

    if (len > 0) this.remove(pos, len);
  }

  /** dna.cpp:123. */
  private moveChunk(): void {
    const size = this.bytes.length;
    const len = this.rng.int(size);
    const pos1 = this.rng.int(size - len);
    const pos2 = this.rng.int(size - len);

    if (len > 0) {
      const temp = this.slice(pos1, len);
      this.remove(pos1, len);
      this.insert(pos2, temp);
    }
  }

  /** dna.cpp:135. */
  private reverseSection(): void {
    const size = this.bytes.length;
    const len = this.rng.int(size);
    const pos = this.rng.int(size - len);

    if (len > 0) {
      // reverse() on a subarray mutates the underlying buffer in place.
      this.bytes.subarray(pos, pos + len).reverse();
    }
  }

  private slice(pos: number, len: number): Uint8Array {
    return this.bytes.slice(pos, pos + len);
  }

  private insert(pos: number, src: Uint8Array): void {
    const current = this.bytes;
    const next = new Uint8Array(current.length + src.length);
    next.set(current.subarray(0, pos), 0);
    next.set(src, pos);
    next.set(current.subarray(pos), pos + src.length);
    this.bytes = next;
  }

  private remove(pos: number, len: number): void {
    const current = this.bytes;
    const next = new Uint8Array(current.length - len);
    next.set(current.subarray(0, pos), 0);
    next.set(current.subarray(pos + len), pos);
    this.bytes = next;
  }
}
