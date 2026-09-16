/**
 * A linear disassembly of a genome.
 *
 * There is no such thing in the original — QtBugs shows a bug's DNA as bytes
 * and as a gene-variance histogram, and never as instructions, so reading a
 * creature's program was not possible in the thing this is a port of. What the
 * rules are, though, is not invented: the sweep below follows `Processor.step()`
 * exactly, including the two things about it that are easy to miss.
 *
 * WHAT "LINEAR" MEANS HERE, AND WHAT IT DOES NOT MEAN
 *
 * This walks from an address and decodes each opcode as it goes, skipping the
 * operand bytes that opcode consumes. That is what a disassembler does with a
 * fixed-width instruction set, and this is not one: the genome is
 * simultaneously the address space, and JMP / JMPZ / JMPNZ / SUBROUTINE can
 * land anywhere, including in the middle of another instruction's operands, at
 * which point the VM reads an operand byte as an opcode — and the operand
 * interpretation from there is whatever falls out. So a listing is a READING
 * AID, not a control-flow recovery: it describes one pass over the bytes, not
 * the set of things that can execute. `reachable` marks the addresses this pass
 * believes are opcodes; the VM may still execute a byte this pass called an
 * operand. Nothing here pretends otherwise.
 *
 * The other surprise, handled rather than papered over: ip advances MODULO the
 * genome length, so an instruction near the end of the genome reads its operands
 * from the start of it. Such an instruction is flagged `wrapped`, because it is
 * otherwise unreadable — the operand bytes appear nowhere near the opcode.
 */

import { Instruction, MAX_I, OPERAND_BYTES } from './processor.js';

export interface DecodedInstruction {
  /** Where the opcode byte sits in the genome. */
  address: number;
  /** The stored byte; what executes is `byte % MAX_I`. */
  byte: number;
  /** The opcode the VM executes — the stored byte modulo MAX_I. */
  opcode: number;
  /** The opcode's enum name, exactly as the C++ I_* enumeration spells it. */
  name: string;
  /** The operand bytes, as stored. */
  operandBytes: number[];
  /** True when any operand byte had to be read from the start of the genome. */
  wrapped: boolean;
  /** For a two-byte operand: the address it forms, after the modulo the VM applies. */
  operandAddress: number | null;
  /** For a two-byte operand: the address before the modulo, when the two differ. */
  operandAddressRaw: number | null;
  /** Bytes this instruction occupies, opcode included. */
  length: number;
}

/**
 * Decode from `start` as a linear sweep, covering each byte of the genome
 * exactly once. A genome of length 0 decodes to nothing.
 */
export function decodeLinear(genome: Uint8Array, start = 0): DecodedInstruction[] {
  const length = genome.length;
  if (length === 0) return [];

  const out: DecodedInstruction[] = [];
  let ip = ((start % length) + length) % length;
  let consumed = 0;

  while (consumed < length) {
    const address = ip;
    const byte = genome[ip];
    ip = (ip + 1) % length; // incIp() for the opcode byte itself
    const opcode = byte % MAX_I;
    const operandCount = OPERAND_BYTES[opcode];
    consumed += 1 + operandCount;

    // incIp(): returns the old ip, then advances modulo the genome length. An
    // instruction at the end therefore reads operands from the beginning.
    const operandBytes: number[] = [];
    let wrapped = false;
    for (let i = 0; i < operandCount; i++) {
      const at = ip;
      ip = (ip + 1) % length;
      operandBytes.push(genome[at]);
      // A read wrapped when its slot lies past the end of the genome, which is a
      // fact about the slot's position, not about the two addresses. Comparing
      // addresses instead (`at < address`) misses the case where a short genome's
      // operand wraps back onto the row's own first byte — lengths 1 and 2, where
      // the byte is read twice and the listing said nothing about it.
      if (address + 1 + i >= length) wrapped = true;
    }

    let operandAddress: number | null = null;
    let operandAddressRaw: number | null = null;
    if (operandCount === 2) {
      // make_addy(): ((high << 8) + low) % genome length — low byte first.
      const raw = ((operandBytes[1] << 8) + operandBytes[0]) % length;
      operandAddress = raw;
      const unmasked = (operandBytes[1] << 8) + operandBytes[0];
      operandAddressRaw = unmasked !== raw ? unmasked : null;
    }

    out.push({
      address,
      byte,
      opcode,
      name: Instruction[opcode],
      operandBytes,
      wrapped,
      operandAddress,
      operandAddressRaw,
      length: 1 + operandCount,
    });
  }

  return out;
}
