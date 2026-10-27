/**
 * The genome as a picture: a horizontal strip, one band per instruction, coloured
 * by what the instruction does, plus the legend's arithmetic.
 *
 * WHY THIS IS NOT JUST A HEAT MAP OF BYTES
 *
 * The bytes of a genome are not equally much program. A JMP is three bytes and
 * one thing you can say about it; a NOOP is one byte and the same amount of
 * nothing. Colouring per byte would draw an operand-heavy genome as though its
 * arithmetic were as frequent as its branching, and it would draw the operands of
 * a JMP as if they were their own instructions. So the strip is built from the
 * LINEAR SWEEP in src/sim/disasm.ts — reused rather than re-implemented, because
 * a second copy of the opcode table is a second place for it to be wrong — and
 * each band covers every byte of one decoded instruction, operands included.
 *
 * What that sweep is a reading aid for, and what it cannot promise, is spelled
 * out in that file's header. The consequence here is narrow and worth stating:
 * the strip describes one pass over the bytes from address 0, not the set of
 * instructions that can execute. Bytes a jump lands in the middle of are drawn as
 * operands of the band that covers them, because that is the band the reader is
 * looking at. The picture is honest about the pass it shows; it is not a claim
 * about control flow.
 *
 * THE ONE INVARIANT, AND WHY IT IS THE ONE THAT MATTERS
 *
 * `genomeStrip` returns bands that cover `0 .. genome.length - 1` exactly once,
 * contiguously, in address order. That is what makes the strip drawable: a gap is
 * a pixel nobody fills, an overlap is a band that takes width from another, and
 * either one silently misplaces every band after it. Everything else here — the
 * classification, the totals, the wrapped flag — is decoration on that skeleton,
 * so the tests assert the coverage before they assert anything else.
 *
 * TWO THINGS ABOUT THE END OF THE GENOME
 *
 * 1. ip advances modulo the genome length, so the last instruction can read its
 *    operands from the START of the genome. Its bytes are then not contiguous: the
 *    opcode sits at the end, the operands at the front, and the front is already
 *    covered by the first band. Such a band is CLIPPED to run from its opcode to
 *    the last byte, and keeps the sweep's `wrapped` flag so the reader is told
 *    that the operands they are looking for are at the other end of the picture
 *    rather than missing. Clipping is not a loss: every byte of that instruction
 *    is still drawn exactly once, just not all in one band.
 *
 * 2. The sweep stops as soon as it has accounted for the genome's length, which
 *    for every genome it can be given means the last instruction's start is the
 *    byte after the previous band, so the bands are contiguous by construction.
 *    That is a fact about the current sweep, not a promise the sweep makes, so
 *    `genomeStrip` does not rely on it: after converting the listing it checks
 *    where it has got to and, if the tail is uncovered, appends ONE band covering
 *    the remainder, marked with TAIL_OPCODE / TAIL_NAME and class 'other'. The
 *    alternative — returning a strip that stops short — would be a picture whose
 *    last bands are missing while nothing said so. Nothing is invented for the
 *    tail: it is drawn as "bytes this pass did not decode", which is exactly what
 *    it is, and `stripFromListing` is exported so that case is testable with a
 *    deliberately short listing rather than by hoping a genome produces one.
 */

import { decodeLinear, type DecodedInstruction } from '../sim/disasm.js';
import { Instruction, MAX_I } from '../sim/processor.js';

/** What an opcode does, for colour-coding and for grouping in the legend. */
export type OpClass = 'control' | 'stack' | 'memory' | 'arith' | 'logic' | 'io' | 'other';

/**
 * The classes, in legend order.
 *
 * Control flow first because it is the smallest group and the one a reader looks
 * for; 'other' last because it is the residue and should not lead. The order is
 * fixed here rather than derived from opcode order, so the legend does not
 * reshuffle when the enum grows.
 */
export const CLASS_ORDER: readonly OpClass[] = ['control', 'stack', 'memory', 'arith', 'logic', 'io', 'other'];

/** Short human labels. The strip's tooltips and the legend print these verbatim. */
export const CLASS_LABEL: Record<OpClass, string> = {
  control: 'control flow',
  stack: 'stack',
  memory: 'memory',
  arith: 'arithmetic',
  logic: 'logic',
  io: 'input/output',
  other: 'other',
};

/**
 * The class of each opcode, indexed by ordinal.
 *
 * NOOP is 'other' by way of the initial fill, and deliberately: it does nothing,
 * so colouring it as control flow would draw the absence of structure as though
 * it were structure. Every other opcode is listed explicitly, because a class
 * that a new opcode falls into by default is a class nobody chose — the tests pin
 * the per-class counts so adding an opcode to the enum without classifying it
 * fails rather than quietly enlarging 'other'.
 */
const CLASS_OF: readonly OpClass[] = (() => {
  const table = new Array<OpClass>(MAX_I).fill('other');
  for (const op of [Instruction.PUSH, Instruction.POP, Instruction.PUSHA, Instruction.POPA]) {
    table[op] = 'stack';
  }
  for (const op of [Instruction.SUBROUTINE, Instruction.RET, Instruction.JMP, Instruction.JMPZ, Instruction.JMPNZ]) {
    table[op] = 'control';
  }
  for (const op of [Instruction.IN, Instruction.OUT]) {
    table[op] = 'io';
  }
  for (const op of [Instruction.LOAD, Instruction.STORE]) {
    table[op] = 'memory';
  }
  for (const op of [Instruction.INC, Instruction.DEC, Instruction.ADD, Instruction.SUB, Instruction.MUL,
                    Instruction.DIV, Instruction.RAND]) {
    table[op] = 'arith';
  }
  for (const op of [Instruction.NOT, Instruction.AND, Instruction.OR, Instruction.NAND, Instruction.NOR,
                    Instruction.XOR]) {
    table[op] = 'logic';
  }
  return table;
})();

/**
 * What an opcode does.
 *
 * Total for the opcodes the VM can execute (0 .. MAX_I-1). Anything else —
 * a negative ordinal, a fraction, a byte that has not yet been reduced modulo
 * MAX_I — is 'other' rather than a throw: the one place a value outside that
 * range reaches this function is the undecoded tail of a strip (TAIL_OPCODE), and
 * a picture is not worth an exception.
 */
export function opClass(opcode: number): OpClass {
  if (!Number.isInteger(opcode) || opcode < 0 || opcode >= MAX_I) return 'other';
  return CLASS_OF[opcode];
}

/**
 * Every opcode, by name, in enum order.
 *
 * Read out of the enum instead of written down, so the legend cannot drift from
 * the VM: a name here that is not an opcode is impossible, and a new opcode
 * appears in the legend the same build it appears in the machine.
 */
export function opcodeNames(): string[] {
  const names: string[] = [];
  for (let op = 0; op < MAX_I; op++) names.push(Instruction[op]);
  return names;
}

/** One contiguous run of the strip. */
export interface StripSegment {
  /** The first byte of the run. */
  address: number;
  /** Bytes covered, opcode and operands; at least 1 for a decoded band. */
  length: number;
  /** The opcode the VM would execute here, or TAIL_OPCODE for the undecoded tail. */
  opcode: number;
  /** The opcode's name, or TAIL_NAME. */
  name: string;
  /** What it does, for the colour. */
  klass: OpClass;
  /**
   * True when this instruction read its operands from the start of the genome,
   * so the band is clipped to the tail and its operands are drawn at the front.
   */
  wrapped: boolean;
}

/** The opcode ordinal used for bytes a linear sweep did not decode. Not a real opcode. */
export const TAIL_OPCODE = -1;

/** The name used for bytes a linear sweep did not decode. Not a real mnemonic. */
export const TAIL_NAME = 'tail';

/**
 * Turn a listing into a strip covering `length` bytes.
 *
 * The listing is walked in order and each row becomes a band clipped to the bytes
 * that are left, which is the whole of the wrapped-instruction handling: the
 * operands of a wrapped row live at the front of the genome and are already
 * covered, so only the row's opcode-to-end run belongs to it here. A row that
 * does not start where the previous band ended stops the walk — the listing is
 * then not describing a contiguous pass and continuing would place bands at
 * addresses that are not the bytes they came from.
 *
 * Whatever is left uncovered at that point becomes one tail band. For a listing
 * that covers the genome (which is what `decodeLinear` returns) there is no tail.
 * Exported so the tail case can be exercised with a short listing.
 */
export function stripFromListing(listing: readonly DecodedInstruction[], length: number): StripSegment[] {
  const segments: StripSegment[] = [];
  let at = 0;

  for (const ins of listing) {
    if (ins.address !== at) break;
    const room = length - at;
    if (room <= 0) break;
    const run = Math.min(ins.length, room);
    segments.push({
      address: at,
      length: run,
      opcode: ins.opcode,
      name: ins.name,
      klass: opClass(ins.opcode),
      wrapped: ins.wrapped,
    });
    at += run;
  }

  if (at < length) {
    segments.push({
      address: at,
      length: length - at,
      opcode: TAIL_OPCODE,
      name: TAIL_NAME,
      klass: 'other',
      wrapped: false,
    });
  }

  return segments;
}

/**
 * The genome as segments covering every byte exactly once and in address order.
 *
 * A genome of length 0 has no bytes, so it has no segments: the strip is empty
 * and the panel draws an empty track rather than a zero-width band at address 0.
 */
export function genomeStrip(genome: Uint8Array): StripSegment[] {
  return stripFromListing(decodeLinear(genome), genome.length);
}

/**
 * Total bytes per class.
 *
 * Every class is present with a count, including zero, so a legend does not have
 * to distinguish "absent from the population" from "absent from the object". The
 * undecoded tail counts as 'other' because that is the class it is drawn in; the
 * alternative would be a legend whose percentages do not add up to the strip.
 */
export function classTotals(strip: readonly StripSegment[]): Record<OpClass, number> {
  const totals = {
    control: 0, stack: 0, memory: 0, arith: 0, logic: 0, io: 0, other: 0,
  } satisfies Record<OpClass, number>;
  for (const segment of strip) totals[segment.klass] += segment.length;
  return totals;
}
