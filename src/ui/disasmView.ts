/**
 * Turning a decoded genome into the lines the inspector shows.
 *
 * The page holds the DOM; this holds the arithmetic, so the cases that are easy
 * to get quietly wrong can be asserted rather than eyeballed. The two that
 * matter: which listing row the instruction pointer is standing in, and whether
 * a row should admit that the byte in the genome is not the opcode the VM runs.
 *
 * The listing is one linear sweep of the genome from address 0 (decodeLinear).
 * Execution is not a linear sweep — it is whatever addresses the program jumps
 * to — so the sweep and the machine can disagree about where instructions start.
 * Where they do, the row says so instead of re-decoding from ip and pretending
 * the stream is contiguous.
 */

import type { DecodedInstruction, Operand } from '../sim/disasm.js';
import { INPUTS, OUTPUTS } from '../sim/processor.js';

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
 * Where the VM reduced the stored number to get here, the row says so in the
 * same words the opcode modulo uses, because the number that produced it is
 * otherwise absent from the line: `#0 (16 wrapped)` for an address past the end
 * of the genome, `input 5 (225 mod 20)` for a channel byte above the 20 inputs.
 * The reductions are the point — a genome full of mutation-written bytes spends
 * most of its time being reduced — so a row that quietly showed the reduced
 * value would be the hardest kind of line to read: correct and inexplicable.
 */
export function operandText(operand: Operand | null): string {
  if (operand === null) return '';

  switch (operand.role) {
    case 'address':
      return `  #${operand.value}`
        + (operand.stored === null ? '' : ` (${operand.stored} wrapped)`);

    case 'input':
      return `  input ${operand.value}`
        + (operand.stored === operand.value ? '' : ` (${operand.stored} mod ${INPUTS})`);

    case 'output':
      return `  output ${operand.value}`
        + (operand.stored === operand.value ? '' : ` (${operand.stored} mod ${OUTPUTS})`);

    case 'value':
      return `  ${operand.value}`;
  }
}

/**
 * The rest of the line: the mnemonic, then — where they differ from what the
 * reader would guess — the operand and the modulo.
 *
 * The stored byte is shown as well as the opcode because a genome written by
 * mutation holds byte values the machine never sees directly: `byte % MAX_I` is
 * what executes, and a bug whose genome is full of 245s runs POPs.
 *
 * The modulo is spelled `mod` rather than `%` deliberately. MAX_I is 27, so the
 * `%` form rendered as `223%27=7` — which reads as the URL-escape `%27` (an
 * apostrophe) followed by `=7`, and it appeared on 3,671 of 4,102 rows of a
 * single mutated genome, so it read as corruption rather than as arithmetic.
 * A notation that collides with an encoding has to give way: `mod` cannot be
 * mistaken for a percent-escape and needs no key.
 */
export function rowTail(ins: DecodedInstruction, maxI: number): string {
  const operand = operandText(ins.operand);
  const wrapped = ins.wrapped ? '  [operands wrap]' : '';
  const modulo = ins.byte !== ins.opcode ? `  ${ins.byte} mod ${maxI} = ${ins.opcode}` : '';

  return `${ins.name.padEnd(11)}${operand}${wrapped}${modulo}`;
}

/** One listing row as text: the bytes, in a fixed column, then the rest. */
export function formatInstruction(ins: DecodedInstruction, maxI: number): string {
  const bytes = rowBytes(ins).map((b) => b.hex).join(' ').padEnd(11);
  return `${bytes}  ${rowTail(ins, maxI)}`;
}
