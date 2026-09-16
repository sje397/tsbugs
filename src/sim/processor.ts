/**
 * The virtual machine.
 *
 * Ported from processor.h / processor.cpp. There are 27 opcodes, a single 8-bit
 * accumulator, no floating point, and a genome that is simultaneously the
 * address space (ram), so the program and its data share one flat array of
 * bytes whose length varies per bug (4096-8192).
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG

 * 1. `addy()` reads two operand bytes and packs them LOW BYTE FIRST. C++ leaves
 *    function-argument evaluation order unspecified, so this was ambiguous on
 *    paper — `make_addy(ram[inc_ip()], ram[inc_ip()])` could bind the first byte
 *    to `hi` instead of `lo`. It was settled by measurement rather than argument:
 *    a stand-in for these three functions was compiled with clang at both -O0
 *    and -O3, and both bind the first byte to `low` (addr 0x2211 from bytes
 *    11 22 33 44). It also matches the RET path, which only reads correctly
 *    under this interpretation. Caveat: order is still formally unspecified, so
 *    a non-clang build could differ.
 *
 * 2. `inc_ip()` returns the OLD instruction pointer and then advances it modulo
 *    the genome length. It is used inside operand reads, so every operand read
 *    mutates ip.
 *
 * 3. The processor does NOT share the genome. In the original, `ram = rom` shares
 *    the bug's QByteArray copy-on-write, and the first STORE detaches, so runtime
 *    writes land in private memory that is never inherited. This port copies
 *    eagerly, which is observably identical because nothing writes the genome
 *    after construction.
 */

import type { RandomSource } from './rng.js';

/**
 * processor.h defines INPUTS as 9 + 9 + 9 + 2 — colour, altitude, energy, and a
 * short carrying the bug's own energy (the comment there calls it "pain?").
 *
 * DIVERGENCE (DIVERGENCES.md §13): the altitude group is gone, so this is
 * 9 + 9 + 2 = 20. The world has no terrain and nothing can create any, so nine
 * slots holding one constant carry no information a program can act on — and a
 * channel that always reads 1 is worse than an absent one, because a program can
 * still branch on it and a reader can still mistake it for a measurement. The
 * survivors keep upstream's order with the hole closed: colour 0-8, energy 9-17,
 * own energy 18-19.
 */
export const INPUTS = 20;
/** processor.h: OUTPUTS = 4 (direction, colour, split, action). */
export const OUTPUTS = 4;

/** processor.h I_* enumeration — the ordinals are the wire format. */
export enum Instruction {
  NOOP = 0,
  PUSH = 1,
  POP = 2,
  PUSHA = 3,
  POPA = 4,
  SUBROUTINE = 5,
  RET = 6,
  IN = 7,
  OUT = 8,
  JMP = 9,
  JMPZ = 10,
  JMPNZ = 11,
  LOAD = 12,
  STORE = 13,
  INC = 14,
  DEC = 15,
  NOT = 16,
  AND = 17,
  OR = 18,
  NAND = 19,
  NOR = 20,
  XOR = 21,
  ADD = 22,
  SUB = 23,
  MUL = 24,
  DIV = 25,
  RAND = 26,
}

/** processor.h: MAX_I — opcodes are taken modulo this. */
export const MAX_I = 27;


/**
 * How many operand bytes each opcode consumes, indexed by opcode ordinal.
 *
 * This exists so the disassembler can walk a genome without duplicating
 * step()'s knowledge of instruction lengths — a second copy of that knowledge
 * would be a second place for it to be wrong. It is not authoritative on its
 * own: `test/processor.test.ts` measures the advancement ip actually makes for
 * every one of the 27 opcodes and fails if this table disagrees, so an edit to
 * step() that changes consumption cannot pass unnoticed.
 *
 * The consumption is unconditional per opcode: the branching instructions read
 * their operands before testing anything, so there is no opcode whose length
 * depends on the accumulator or on the stack.
 */
export const OPERAND_BYTES: readonly number[] = (() => {
  const table = new Array<number>(MAX_I).fill(0);
  for (const op of [Instruction.PUSHA, Instruction.POPA, Instruction.SUBROUTINE,
                    Instruction.JMP, Instruction.JMPZ, Instruction.JMPNZ,
                    Instruction.LOAD, Instruction.STORE]) {
    table[op] = 2;
  }
  for (const op of [Instruction.IN, Instruction.OUT, Instruction.AND, Instruction.OR,
                    Instruction.NAND, Instruction.NOR, Instruction.XOR, Instruction.ADD,
                    Instruction.SUB, Instruction.MUL, Instruction.DIV]) {
    table[op] = 1;
  }
  return table;
})();

export class Processor {
  private readonly ram: Uint8Array;
  private readonly stack: Uint8Array;
  private readonly inp: Uint8Array;
  /** Read by Bug each tick: [direction, colour, split, action]. */
  readonly out: Uint8Array;

  private ip = 0;
  private sp = 0;
  private bp = 0;
  private acc = 0;

  private readonly steps: number;
  private readonly rng: RandomSource;

  /** `rom` is copied, never aliased — see note 3 above. */
  constructor(rom: Uint8Array, stepsPerUpdate: number, stackSize: number, rng: RandomSource) {
    this.ram = rom.slice();
    this.stack = new Uint8Array(stackSize);
    this.inp = new Uint8Array(INPUTS);
    this.out = new Uint8Array(OUTPUTS);
    this.steps = stepsPerUpdate;
    this.rng = rng;
  }

  get accumulator(): number {
    return this.acc;
  }

  /**
   * The registers, for inspection. Upstream keeps all four private with no
   * reader at all, which is why "the machine is somewhere I cannot see" had to
   * be inferred from behaviour there. Read-only: the UI shows the machine, it
   * does not drive it.
   */
  get state(): { ip: number; sp: number; bp: number; accumulator: number } {
    return { ip: this.ip, sp: this.sp, bp: this.bp, accumulator: this.acc };
  }

  get programLength(): number {
    return this.ram.length;
  }

  /** Inspection hooks, used by the tests and by the UI's per-bug readout. */
  readRam(address: number): number {
    return this.ram[address];
  }

  readIn(index: number): number {
    return this.inp[index];
  }

  readOut(index: number): number {
    return this.out[index];
  }

  /** processor.cpp: `inp[i] = val`. */
  setIn(index: number, value: number): void {
    this.inp[index % INPUTS] = value;
  }

  /** processor.cpp: memcpy(in + start, vals, len) — no modulo, range is checked. */
  setInMulti(start: number, values: Uint8Array): void {
    this.inp.set(values.subarray(0, INPUTS - start), start);
  }

  /**
   * The instruction budget this Processor was built with — diagnostic, and the
   * only way to see a parameter that is captured per bug rather than read live
   * (see PetriDish.setParams). Upstream has the same field private and no way to
   * read it, which is why "changing it did nothing" was invisible there.
   */
  get stepsPerUpdate(): number {
    return this.steps;
  }

  /** processor.cpp: `for(i < steps_per_update) step();` */
  run(): void {
    for (let i = 0; i < this.steps; i++) this.step();
  }

  /**
   * processor.cpp inc_ip(). Returns the previous ip, then advances it modulo the
   * genome length — so a bug whose program walks off the end simply wraps.
   */
  private incIp(): number {
    const old = this.ip;
    this.ip = (this.ip + 1) % this.ram.length;
    return old;
  }

  /** processor.cpp make_addy(): ((hi << 8) + lo) modulo the genome length. */
  private makeAddy(low: number, high: number): number {
    return (((high << 8) + low) % this.ram.length);
  }

  /** Reads the next two operand bytes, low byte first. */
  private addy(): number {
    return this.makeAddy(this.ram[this.incIp()], this.ram[this.incIp()]);
  }

  /** processor.cpp step(). */
  private step(): void {
    const instruction = this.ram[this.incIp()] % MAX_I;

    switch (instruction) {
      case Instruction.PUSH:
        if (this.sp < this.stack.length) this.stack[this.sp++] = this.acc;
        break;

      case Instruction.POP:
        if (this.sp > this.bp) this.acc = this.stack[--this.sp];
        break;

      case Instruction.PUSHA: {
        const address = this.addy();
        if (this.sp < this.stack.length) this.stack[this.sp++] = this.ram[address];
        break;
      }

      case Instruction.POPA: {
        const address = this.addy();
        if (this.sp > this.bp) this.ram[address] = this.stack[--this.sp];
        break;
      }

      case Instruction.SUBROUTINE: {
        const address = this.addy();
        if (this.sp <= this.stack.length - 4) {
          this.stack[this.sp++] = this.ip >> 8;
          this.stack[this.sp++] = this.ip & 0xff;
          this.stack[this.sp++] = this.bp >> 8;
          this.stack[this.sp++] = this.bp & 0xff;
          this.bp = this.sp;
          this.ip = address;
        }
        break;
      }

      case Instruction.RET:
        if (this.bp >= 4) {
          // sp is set to bp first, and the pairs below read against that value.
          this.sp = this.bp;
          this.bp = this.makeAddy(this.stack[this.sp - 1], this.stack[this.sp - 2]);
          this.ip = this.makeAddy(this.stack[this.sp - 3], this.stack[this.sp - 4]);
          this.sp -= 4;
        }
        break;

      case Instruction.IN:
        this.acc = this.inp[this.ram[this.incIp()] % INPUTS];
        break;

      case Instruction.OUT:
        this.out[this.ram[this.incIp()] % OUTPUTS] = this.acc;
        break;

      case Instruction.JMP:
        this.ip = this.addy();
        break;

      case Instruction.JMPZ: {
        const address = this.addy();
        if (this.acc === 0) this.ip = address;
        break;
      }

      case Instruction.JMPNZ: {
        const address = this.addy();
        if (this.acc !== 0) this.ip = address;
        break;
      }

      case Instruction.LOAD:
        this.acc = this.ram[this.addy()];
        break;

      case Instruction.STORE:
        this.ram[this.addy()] = this.acc;
        break;

      case Instruction.INC:
        this.acc = (this.acc + 1) & 0xff;
        break;

      case Instruction.DEC:
        this.acc = (this.acc - 1) & 0xff;
        break;

      case Instruction.NOT:
        this.acc = ~this.acc & 0xff;
        break;

      case Instruction.AND:
        this.acc = this.acc & this.ram[this.incIp()];
        break;

      case Instruction.OR:
        this.acc = this.acc | this.ram[this.incIp()];
        break;

      case Instruction.NAND:
        // Unsigned char arithmetic in the original: 255 - (a & b).
        this.acc = 0xff - (this.acc & this.ram[this.incIp()]);
        break;

      case Instruction.NOR:
        this.acc = 0xff - (this.acc | this.ram[this.incIp()]);
        break;

      case Instruction.XOR:
        this.acc = this.acc ^ this.ram[this.incIp()];
        break;

      case Instruction.ADD:
        this.acc = (this.acc + this.ram[this.incIp()]) & 0xff;
        break;

      case Instruction.SUB:
        this.acc = (this.acc - this.ram[this.incIp()]) & 0xff;
        break;

      case Instruction.MUL:
        this.acc = (this.acc * this.ram[this.incIp()]) & 0xff;
        break;

      case Instruction.DIV: {
        // Integer division; the original guards against a zero divisor by simply
        // leaving the accumulator alone.
        const divisor = this.ram[this.incIp()];
        if (divisor !== 0) this.acc = (this.acc / divisor) | 0;
        break;
      }

      case Instruction.RAND:
        // `qrand() % 0xff` — note this cannot produce 255.
        this.acc = this.rng.next() % 0xff;
        break;

      case Instruction.NOOP:
        break;
    }
  }
}
