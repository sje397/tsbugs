/**
 * Turning a decoded genome into the lines the inspector shows.
 *
 * The page holds the DOM; this holds the arithmetic, so the cases that are easy
 * to get quietly wrong can be asserted rather than eyeballed. The two that
 * matter: which listing row the instruction pointer is standing in, and what an
 * operand byte actually means to the machine.
 *
 * The listing is one linear sweep of the genome from address 0 (decodeLinear).
 * Execution is not a linear sweep — it is whatever addresses the program jumps
 * to — so the sweep and the machine can disagree about where instructions start.
 * Where they do, the row says so instead of re-decoding from ip and pretending
 * the stream is contiguous.
 */

import type { DecodedInstruction, Operand } from '../sim/disasm.js';

/**
 * The index of the row whose byte range contains `ip`, or -1 if there is none.
 *
 * A wrapped instruction (one whose operands run off the end of the genome) also
 * covers addresses at the start, but its row starts later, so `ip` at such an
 * address resolves to the row that *begins* there — the sweep's reading, which is
 * the one the listing is showing. Both are true statements about the same bytes;
 * the row is what the reader is looking at, so it is what gets highlighted.
 */
export function instructionIndexAt(listing: readonly DecodedInstruction[], ip: number): number {
  return listing.findIndex((ins) => ip >= ins.address && ip < ins.address + ins.length);
}

/** True when `ip` sits inside a row without being where that row begins. */
export function isMidInstruction(listing: readonly DecodedInstruction[], index: number, ip: number): boolean {
  return index >= 0 && listing[index].address !== ip;
}

export const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

export const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

/**
 * Where the listing decodes from.
 *
 * A listing is one sweep of the genome from some starting address, and WHICH
 * address matters: an opcode's length depends on which instruction it is, so a
 * sweep from 0 and the machine's own reading of the same bytes can disagree about
 * where instructions start. Where the machine jumps to an address the sweep read
 * as operand bytes, the code it runs is not a row of that listing at all.
 *
 * So the start is a choice the reader makes. 0 is the program in address order;
 * the instruction pointer is what is actually running; a jump target is how a call
 * is followed into its subroutine. This normalises an address into the genome,
 * because an anchor arrives from a click on a target that may be anything at all.
 */
export function normaliseAnchor(address: number, length: number): number {
  if (length <= 0) return 0;
  return ((address % length) + length) % length;
}

/**
 * The address an operand points at, or null when it points at nothing.
 *
 * Only an address-role operand is a place in the genome: the eight two-byte
 * opcodes read, write or jump to it, and a reader can follow it. An `input 5`, an
 * `output 2` or a bare value of 200 are numbers that look like addresses and are
 * not — making them clickable would send the listing to a place the row never
 * mentions.
 */
export function operandTarget(operand: Operand | null): number | null {
  return operand !== null && operand.role === 'address' ? operand.value : null;
}

/**
 * Every byte of a row, with the genome slot it occupies — the first part of the
 * line, and the part an editor has to address.
 *
 * The slot is carried on the row because a wrapped instruction reads its operands
 * from the start of the genome: its slots there run backwards, so the same slot
 * computed without the wrap is an address past the end of the genome rather than a
 * wrong one that looks right.
 */
export function rowBytes(ins: DecodedInstruction): Array<{ address: number; hex: string }> {
  return [ins.byte, ...ins.operandBytes].map((value, i) => ({
    address: ins.byteAddresses[i],
    hex: hex2(value),
  }));
}

/**
 * The operand, said in the terms the opcode means it in.
 *
 * An address is `#258` — a slot in the genome the program reads, writes or jumps
 * to. An input or an output is a channel number, and is named as one. An
 * arithmetic operand is the byte itself, as a value.
 *
 * Only the value the machine uses is shown. The number stored in the genome is
 * already in the byte column, and where the VM reduced it the reduction is
 * arithmetic a reader can do; printing it on the row as well put two numbers and
 * a `mod` beside every operand and made the listing harder to scan than the
 * defect it was explaining. The panel states the modulo once, in its footer,
 * which is where a rule about the whole listing belongs.
 */
export function operandText(operand: Operand | null): string {
  if (operand === null) return '';

  switch (operand.role) {
    case 'address':
      return `  #${operand.value}`;

    case 'input':
      return `  input ${operand.value}`;

    case 'output':
      return `  output ${operand.value}`;

    case 'value':
      return `  ${operand.value}`;
  }
}

/** How wide the mnemonic column is, so the operand lines up down the listing. */
export const MNEMONIC_WIDTH = 11;

/** What a row says when it read part of its operand from the start of the genome. */
export const WRAP_MARKER = '  [operands wrap]';

/**
 * The rest of the line: the mnemonic, then the operand.
 *
 * The byte column may hold a value the machine never sees directly — `byte %
 * MAX_I` is what executes, so a bug whose genome is full of 245s runs POPs — and
 * the row does not restate that reduction. It was tried both ways round: first as
 * `byte%MAX_I=opcode`, which with MAX_I at 27 rendered `223%27=7` and read as the
 * URL-escape for an apostrophe on 3,671 of 4,102 rows of one mutated genome; then
 * as `${byte} mod ${maxI} = ${opcode}`, which is honest but appears on nearly
 * every row of a mutable genome and so annotates nothing. What survives is the
 * stored byte in its own column and one line of legend under the listing.
 *
 * The page builds the same tail out of the same pieces rather than using this
 * string, because an address operand has to be a span it can make clickable. The
 * pieces are exported for exactly that reason, and a test holds the two together.
 */
export function rowTail(ins: DecodedInstruction): string {
  const operand = operandText(ins.operand);
  const wrapped = ins.wrapped ? WRAP_MARKER : '';

  return `${ins.name.padEnd(MNEMONIC_WIDTH)}${operand}${wrapped}`;
}

/** One listing row as text: the bytes, in a fixed column, then the rest. */
export function formatInstruction(ins: DecodedInstruction): string {
  const bytes = rowBytes(ins).map((b) => b.hex).join(' ').padEnd(11);
  return `${bytes}  ${rowTail(ins)}`;
}
