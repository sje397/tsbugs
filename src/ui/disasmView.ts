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

import type { DecodedInstruction } from '../sim/disasm.js';

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

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

export const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

/**
 * One listing row: the bytes as stored, the mnemonic, and — where they differ
 * from what the reader would guess — the operand address and the modulo.
 *
 * The stored byte is shown as well as the opcode because a genome written by
 * mutation holds byte values the machine never sees directly: `byte % MAX_I` is
 * what executes, and a bug whose genome is full of 245s runs POPs.
 */
export function formatInstruction(ins: DecodedInstruction, maxI: number): string {
  const bytes = [ins.byte, ...ins.operandBytes].map(hex2).join(' ').padEnd(11);

  let operand = '';
  if (ins.operandAddress !== null) {
    operand = `  #${ins.operandAddress}`;
    if (ins.operandAddressRaw !== null) operand += ` (${ins.operandAddressRaw} wrapped)`;
  }

  const wrapped = ins.wrapped ? '  [operands wrap]' : '';
  const modulo = ins.byte !== ins.opcode ? `  ${ins.byte}%${maxI}=${ins.opcode}` : '';

  return `${bytes}  ${ins.name.padEnd(11)}${operand}${wrapped}${modulo}`;
}
