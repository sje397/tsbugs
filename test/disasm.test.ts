/**
 * The disassembler, pinned against the rules it claims to follow.
 *
 * The decode is only useful if it agrees with the VM byte-for-byte, so these
 * cases fix the three places it could silently diverge: opcode bytes reduced
 * modulo MAX_I, two-byte operands read low byte first and then reduced modulo
 * the genome length, and ip advancing modulo the genome length so that an
 * instruction at the end reads its operands from the beginning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeLinear } from '../src/sim/disasm.js';
import type { DecodedInstruction, Operand } from '../src/sim/disasm.js';
import { INPUTS, Instruction, MAX_I, OPERAND_BYTES, OUTPUTS, Processor } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';

const genome = (...bytes: number[]) => Uint8Array.from(bytes);

/**
 * The address operand of a row, asserting that it IS one.
 *
 * The operand is a union of four roles now, so reading `.value` off an unproven
 * role would compile into a check of the wrong shape — and the failure it would
 * hide is the one this field exists to prevent: a row whose operand means
 * something other than an address.
 */
function addressOf(ins: DecodedInstruction): Extract<Operand, { role: 'address' }> {
  assert.equal(ins.operand?.role, 'address', `row ${ins.address} should carry an address operand`);
  return ins.operand as Extract<Operand, { role: 'address' }>;
}

test('a linear sweep covers every byte exactly once, in order', () => {
  // LOAD #0000 | ADD #05 | INC | JMP #000a | NOOP | six NOOPs = 16 bytes.
  const rom = genome(
    Instruction.LOAD, 0x10, 0x00,
    Instruction.ADD, 0x05,
    Instruction.INC,
    Instruction.JMP, 0x0a, 0x00,
    Instruction.NOOP,
    0, 0, 0, 0, 0, 0,
  );

  const decoded = decodeLinear(rom);

  assert.deepEqual(
    decoded.map((d) => [d.address, d.name, d.length]),
    [
      [0, 'LOAD', 3],
      [3, 'ADD', 2],
      [5, 'INC', 1],
      [6, 'JMP', 3],
      [9, 'NOOP', 1],
      [10, 'NOOP', 1],
      [11, 'NOOP', 1],
      [12, 'NOOP', 1],
      [13, 'NOOP', 1],
      [14, 'NOOP', 1],
      [15, 'NOOP', 1],
    ],
  );

  // Every byte is accounted for exactly once: the lengths sum to the genome
  // length and the addresses tile it from 0 with no gaps and no overlap.
  const total = decoded.reduce((n, d) => n + d.length, 0);
  assert.equal(total, rom.length, 'the sweep must cover the genome exactly once');
  decoded.forEach((d, i) => assert.equal(d.address, i === 0 ? 0 : decoded[i - 1].address + decoded[i - 1].length));

  const load = decoded[0];
  assert.deepEqual(load.operandBytes, [0x10, 0x00]);
  assert.equal(addressOf(load).value, 0, 'little-endian: low byte is 0x10, high is 0x00, so the address is 0x0010 % 16');
  assert.equal(addressOf(load).stored, 16, 'the operand names address 16, which a 16-byte genome reduces to 0 — the listing states both because only the raw one explains the oddity');
  assert.equal(load.wrapped, false);
});

test('an opcode byte above MAX_I executes as its modulo, and the stored byte is preserved', () => {
  const rom = genome(255, 0x00, 0x00, 0x00);
  const [first] = decodeLinear(rom);

  assert.equal(first.byte, 255, 'the listing must show what is stored');
  assert.equal(first.opcode, 255 % MAX_I);
  assert.equal(first.name, Instruction[255 % MAX_I]);
  assert.equal(first.name, 'LOAD');
  assert.equal(first.length, 1 + OPERAND_BYTES[Instruction.LOAD]);
});

test('an instruction whose operands fall past the end reads them from the start, and says so', () => {
  // Six INCs, then LOAD at address 6 with its operands at 7 and 0. The second
  // operand read is the one that runs off the end, so this is the case where the
  // modulo on the OPERAND advance matters — an instruction at the very last byte
  // only exercises the modulo on the opcode advance, and passes either way.
  const rom = new Uint8Array(8);
  for (let i = 0; i < 6; i++) rom[i] = Instruction.INC;
  rom[6] = Instruction.LOAD;
  rom[7] = 0x05;

  const decoded = decodeLinear(rom);
  const last = decoded[decoded.length - 1];

  assert.equal(last.address, 6);
  assert.equal(last.name, 'LOAD');
  assert.deepEqual(last.operandBytes, [rom[7], rom[0]], 'operand two comes from address 0, not from past the end');
  assert.equal(last.wrapped, true, 'a wrapped read is otherwise unreadable and must be visible');
  assert.equal(addressOf(last).value, ((rom[0] << 8) + rom[7]) % rom.length);
  assert.equal(addressOf(last).stored, (rom[0] << 8) + rom[7], 'the un-reduced address explains why the listing looks odd');
});

test('an instruction at the last byte wraps its opcode advance without claiming its operands wrapped', () => {
  const rom = new Uint8Array(4);
  rom[0] = Instruction.INC;
  rom[1] = Instruction.INC;
  rom[2] = Instruction.INC;
  rom[3] = Instruction.POP; // 0 operands, so nothing is read past the end

  const decoded = decodeLinear(rom);
  const last = decoded[decoded.length - 1];
  assert.equal(last.address, 3);
  assert.equal(last.name, 'POP');
  assert.deepEqual(last.operandBytes, []);
  assert.equal(last.wrapped, false, 'the opcode wrap is not an operand wrap and must not be reported as one');
});

test('a two-byte operand is reduced modulo the genome length, and the raw value is reported when it differed', () => {
  // 0xff 0xff forms 0xffff = 65535; against a 16-byte genome the VM uses 15.
  const rom = genome(Instruction.JMP, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const [first] = decodeLinear(rom);

  assert.equal(addressOf(first).value, 0xffff % 16);
  assert.equal(addressOf(first).stored, 0xffff, 'the un-reduced address is what explains the oddity');
});

test('an instruction whose operands do not need the modulo reports no raw address', () => {
  const rom = genome(Instruction.LOAD, 0x05, 0x00, 0, 0, 0, 0, 0, 0);
  const [first] = decodeLinear(rom);
  assert.equal(addressOf(first).value, 5);
  assert.equal(addressOf(first).stored, null, 'nothing was reduced, so there is no second number to explain');
});

test('a decoding can start anywhere in the genome, and wraps to cover it once', () => {
  const rom = genome(Instruction.NOOP, Instruction.INC, Instruction.NOOP, Instruction.INC);
  const fromMid = decodeLinear(rom, 2);
  assert.deepEqual(fromMid.map((d) => d.address), [2, 3, 0, 1]);
  assert.equal(fromMid.reduce((n, d) => n + d.length, 0), rom.length);
  // A start past the end is taken modulo, not treated as an error or a clamp.
  assert.deepEqual(decodeLinear(rom, 6).map((d) => d.address), [2, 3, 0, 1]);
});

test('an empty genome decodes to nothing rather than looping', () => {
  assert.deepEqual(decodeLinear(new Uint8Array(0)), []);
});

test('the sweep reports only bytes this pass called opcodes — a jump may still execute an operand as one', () => {
  // The listing claims JMP's operands are operands; the VM, if it jumps there,
  // will read them as opcodes. This test fixes that the listing does NOT try to
  // hide the ambiguity by chasing the branch.
  const rom = genome(Instruction.JMP, 0x00, 0x00);
  const decoded = decodeLinear(rom);
  assert.equal(decoded.length, 1, 'the sweep does not follow the jump');
  assert.deepEqual(decoded[0].operandBytes, [0, 0]);
  assert.equal(addressOf(decoded[0]).value, 0);
});

test('the two operand bytes are bound low-first, on a genome length where that is observable', () => {
  // Against a genome length that divides 256, (high << 8) + low is congruent to
  // low alone, so an implementation that ignored the high byte entirely would
  // produce the same address and this assertion could not fail. 100 does not
  // divide 256, so the two readings are distinguishable and the little-endian
  // question is actually being tested rather than assumed.
  const rom = new Uint8Array(100);
  rom[0] = Instruction.LOAD;
  rom[1] = 0x11;
  rom[2] = 0x22;

  const [first] = decodeLinear(rom);
  assert.equal(addressOf(first).value, ((0x22 << 8) + 0x11) % 100);
  assert.notEqual(addressOf(first).value, 0x11, 'the low byte alone is 17; the operand names 21');
});

/**
 * What each opcode does with its operand, written out by hand from step() in
 * enum order — the independent artefact for OPERAND_ROLE, in the same spirit as
 * CONSUMPTION above.
 *
 * Arity alone cannot catch a role error: calling IN a plain `value` keeps the
 * length at one byte, so OPERAND_BYTES and its measurement agree while the
 * listing tells a reader that 200 is the value IN adds.
 */
const ROLE = [
  'none', 'none', 'none', 'address', 'address', 'address', 'none', 'input', 'output',
  'address', 'address', 'address', 'address', 'address', 'none', 'none', 'none',
  'value', 'value', 'value', 'value', 'value', 'value', 'value', 'value', 'value', 'none',
];

test('every opcode decodes its operand as the opcode reads it', () => {
  assert.equal(ROLE.length, MAX_I, 'the table must cover every opcode');

  for (let op = 0; op < MAX_I; op++) {
    const [row] = decodeLinear(genome(op, 0xe1, 0x22));
    assert.equal(row.name, Instruction[op]);
    const decoded = row.operand === null ? 'none' : row.operand.role;
    assert.equal(decoded, ROLE[op], `operand of ${Instruction[op]}`);
  }

  // And each role applies step()'s reduction, not a plausible different one: a
  // channel byte above the input count is reduced, and an arithmetic operand is
  // not, which is the distinction a reader uses to tell `input 5` from `200`.
  const [input] = decodeLinear(genome(Instruction.IN, 0xe1));
  assert.deepEqual(input.operand, { role: 'input', value: 0xe1 % INPUTS, stored: 0xe1 });

  const [output] = decodeLinear(genome(Instruction.OUT, 0xe1));
  assert.deepEqual(output.operand, { role: 'output', value: 0xe1 % OUTPUTS, stored: 0xe1 });

  const [value] = decodeLinear(genome(Instruction.MUL, 0xe1));
  assert.deepEqual(value.operand, { role: 'value', value: 0xe1 });
});

/**
 * The operand of the requested role, asserting that it is one.
 *
 * The role assertion is what makes the cast honest: a row that means something
 * else fails here rather than being read as the wrong shape.
 */
function operandOfRole<R extends Operand['role']>(
  ins: DecodedInstruction, role: R,
): Extract<Operand, { role: R }> {
  assert.equal(ins.operand?.role, role, `row ${ins.address} should carry a ${role} operand`);
  return ins.operand as Extract<Operand, { role: R }>;
}

test('the operand a row shows is the one the machine uses', () => {
  /**
   * Every check above compares the decode against a rule written in that test,
   * so a decode that reduced an operand by a DIFFERENT rule than step() would
   * still agree with an expectation derived from the same mistaken reading. This
   * one executes the instruction instead: the row is asked what the instruction
   * is about to do, the instruction does it, and the two answers are compared.
   *
   * The operand bytes are all above INPUTS, because a reduction and a non-
   * reduction are indistinguishable on a byte that fits.
   */
  const operandByte = 0xe1; // 225: reduces to 5 channels, or to nothing at all

  // IN names an input. Every input holds a DIFFERENT value, so whichever value
  // lands in the accumulator identifies the input that was actually read.
  const inRom = genome(Instruction.IN, operandByte);
  const inRow = decodeLinear(inRom)[0];
  const inProcessor = new Processor(inRom, 1, 16, new Rng(1));
  for (let i = 0; i < INPUTS; i++) inProcessor.setIn(i, i + 1);
  inProcessor.run();
  const inIndex = operandOfRole(inRow, 'input').value;
  assert.equal(inProcessor.accumulator, inProcessor.readIn(inIndex),
    'the row named a different input from the one the machine read');
  assert.equal(inProcessor.readIn(inIndex), inIndex + 1, 'the fixture must make each input distinguishable');

  // OUT names an output slot.
  const outRom = genome(Instruction.ADD, 0x2a, Instruction.OUT, operandByte);
  const outRow = decodeLinear(outRom)[1];
  const outProcessor = new Processor(outRom, 2, 16, new Rng(1));
  outProcessor.run();
  const outIndex = operandOfRole(outRow, 'output').value;
  assert.equal(outProcessor.readOut(outIndex), 0x2a, 'the accumulator was written to a different slot');

  // A value operand is the byte itself: 225 added, not 5.
  const addRom = genome(Instruction.ADD, operandByte);
  const addRow = decodeLinear(addRom)[0];
  const addProcessor = new Processor(addRom, 1, 16, new Rng(1));
  addProcessor.run();
  assert.equal(operandOfRole(addRow, 'value').value, operandByte);
  assert.equal(addProcessor.accumulator, operandByte, 'the machine added a reduced value');

  // An address operands names a slot the machine reads — including when the
  // packed value runs past the end of the genome and comes back round.
  for (const [low, high] of [[0x01, 0x00], [0x01, 0x01], [0xff, 0xff]] as const) {
    const loadRom = genome(Instruction.LOAD, low, high);
    const loadRow = decodeLinear(loadRom)[0];
    const loadProcessor = new Processor(loadRom, 1, 16, new Rng(1));
    loadProcessor.run();
    const address = operandOfRole(loadRow, 'address').value;
    assert.equal(loadProcessor.accumulator, loadRom[address],
      `LOAD #${address} did not read the slot the row named`);
  }
});
