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

import { INPUTS, Instruction, MAX_I, OPERAND_BYTES, OperandRole, OUTPUTS, OPERAND_ROLE } from './processor.js';

/**
 * What one instruction's operand means, as the row will say it.
 *
 * Three shapes, because the VM does three different things with an operand byte
 * and a reader needs to know which: an address the program reads, writes or
 * jumps to; an index into the inputs or outputs, where the byte is reduced to
 * the width of that channel list; or a value used as it stands.
 *
 * `stored` is the number as it sits in the genome, carried only where the VM
 * changed it — so the row can admit the reduction instead of showing a value
 * that does not appear in the byte column. For an address that is the packed
 * value before the modulo on the genome length; for an input or output it is the
 * operand byte before the modulo on the channel count.
 */
export type Operand =
  | { readonly role: 'address'; readonly value: number; readonly stored: number | null }
  | { readonly role: 'input'; readonly value: number; readonly stored: number }
  | { readonly role: 'output'; readonly value: number; readonly stored: number }
  | { readonly role: 'value'; readonly value: number };

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
  /**
   * Every byte of this row, with the genome slot it was read from — opcode first,
   * then the operands in the order the VM reads them.
   *
   * These are `address + n` taken modulo the genome length, which is what makes
   * them worth carrying: an instruction whose operands wrap the end of the genome
   * reads them from the start, so its later slots are numerically BELOW its own.
   * Recomputing them without the wrap does not give a plausible wrong slot, it
   * gives one past the end of the genome — which is why the reader takes the slot
   * the sweep actually read rather than deriving it from the address.
   */
  byteAddresses: number[];
  /** True when any operand byte had to be read from the start of the genome. */
  wrapped: boolean;
  /**
   * What the operand means, or null for an opcode that takes none.
   *
   * Replaces a pair of address-only fields: the listing showed an operand
   * address for the eight two-byte opcodes and printed nothing for the eleven
   * one-byte ones, which left a reader of `IN` or `MUL` unable to tell which
   * input, or what value, the row was about to use.
   */
  operand: Operand | null;
  /** Bytes this instruction occupies, opcode included. */
  length: number;
}

/**
 * The operand as step() will read it, from the bytes the sweep has consumed.
 *
 * The reductions restated here are step()'s, in the one place a listing can see
 * them: an address is `((high << 8) + low) % genome length`, an input is
 * `byte % INPUTS`, an output is `byte % OUTPUTS`, and an arithmetic operand is
 * the byte itself. `stored` carries the number before the reduction so the row
 * can say so — a line reading `input 5` beside a stored byte of 225 is a value
 * that appears nowhere in the byte column, which is the same defect one layer
 * along from showing no operand at all.
 */
function operandOf(role: OperandRole, bytes: number[], genomeLength: number): Operand | null {
  switch (role) {
    case OperandRole.None:
      return null;

    case OperandRole.Address: {
      // make_addy(): low byte first, then modulo the genome length.
      const packed = (bytes[1] << 8) + bytes[0];
      const value = packed % genomeLength;
      return { role: 'address', value, stored: packed !== value ? packed : null };
    }

    case OperandRole.Input:
      return { role: 'input', value: bytes[0] % INPUTS, stored: bytes[0] };

    case OperandRole.Output:
      return { role: 'output', value: bytes[0] % OUTPUTS, stored: bytes[0] };

    case OperandRole.Value:
      return { role: 'value', value: bytes[0] };
  }
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
    const role = OPERAND_ROLE[opcode];
    const operandCount = OPERAND_BYTES[opcode];
    consumed += 1 + operandCount;

    // incIp(): returns the old ip, then advances modulo the genome length. An
    // instruction at the end therefore reads operands from the beginning.
    const operandBytes: number[] = [];
    const operandSlots: number[] = [];
    let wrapped = false;
    for (let i = 0; i < operandCount; i++) {
      const at = ip;
      ip = (ip + 1) % length;
      operandBytes.push(genome[at]);
      operandSlots.push(at);
      // A read wrapped when its slot lies past the end of the genome, which is a
      // fact about the slot's position, not about the two addresses. Comparing
      // addresses instead (`at < address`) misses the case where a short genome's
      // operand wraps back onto the row's own first byte — lengths 1 and 2, where
      // the byte is read twice and the listing said nothing about it.
      if (address + 1 + i >= length) wrapped = true;
    }

    out.push({
      address,
      byte,
      opcode,
      name: Instruction[opcode],
      operandBytes,
      byteAddresses: [address, ...operandSlots],
      wrapped,
      operand: operandOf(role, operandBytes, length),
      length: 1 + operandCount,
    });
  }

  return out;
}
