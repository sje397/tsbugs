/**
 * The VM, pinned against processor.cpp.
 *
 * These are the behaviours a port has to get exactly right and would never
 * notice getting wrong: 8-bit wrap-around, the two-byte little-endian address
 * taken modulo the ROM length, opcode bytes reduced modulo MAX_I, and the guard
 * clauses that silently do nothing rather than failing.
 *
 * Every case runs exactly as many instructions as the ROM needs, so nothing
 * executes past the end and wraps to address 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Instruction, INPUTS, MAX_I, OPERAND_BYTES, OUTPUTS, Processor } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';

/**
 * Run exactly `steps` instructions. There is no halt, and inc_ip wraps at the
 * end of the ROM, so `steps` must not exceed the number of instructions the ROM
 * actually encodes — otherwise the program silently restarts from address 0.
 */
function exec(rom: readonly number[], steps: number, stackSize = 16): Processor {
  const processor = new Processor(new Uint8Array(rom), steps, stackSize, new Rng(1));
  processor.run();
  return processor;
}

test('PUSH and POP round-trip through the stack', () => {
  // PUSH takes no operand: it pushes the accumulator, so it must hold a value first.
  assert.equal(
    exec(
      [Instruction.ADD, 0x7f, Instruction.PUSH, Instruction.ADD, 0x01, Instruction.POP],
      4,
    ).accumulator,
    0x7f,
  );
});

test('POP at the stack base does nothing', () => {
  // sp == bp == 0 by the second POP, so its guard fails and the restored value
  // survives. Five instructions, and the ROM must be no shorter, or the sixth
  // step would wrap around and run the first ADD again.
  assert.equal(
    exec(
      [
        Instruction.ADD, 0x11,
        Instruction.PUSH,
        Instruction.ADD, 0x22,
        Instruction.POP,
        Instruction.POP,
      ],
      5,
    ).accumulator,
    0x11,
  );
});

test('the instruction pointer wraps back to the start of the ROM', () => {
  // inc_ip() is `++ip %= ram.size()`, so a one-byte ROM runs the same
  // instruction for every step. The step count is the only bound there is.
  assert.equal(exec([Instruction.INC], 3).accumulator, 3);
});

test('PUSHA and POPA move RAM through the stack', () => {
  const rom = [
    Instruction.PUSHA, 7, 0,
    Instruction.POPA, 9, 0,
    0, 0xab, 0, 0,
  ];
  const processor = exec(rom, 2);
  assert.equal(processor.readRam(9), 0xab);
});

test('LOAD and STORE address RAM little-endian', () => {
  const rom = [
    Instruction.LOAD, 7, 0,
    Instruction.STORE, 9, 0,
    0, 0xab, 0, 0,
  ];
  const processor = exec(rom, 2);
  assert.equal(processor.accumulator, 0xab);
  assert.equal(processor.readRam(9), 0xab);
});

test('addresses are taken modulo the ROM length', () => {
  const rom = new Uint8Array(256);
  rom[0] = Instruction.LOAD;
  rom[1] = 0;
  rom[2] = 1; // address 0x0100, which is 0 modulo 256
  const processor = new Processor(rom, 1, 16, new Rng(1));
  processor.run();
  assert.equal(processor.accumulator, Instruction.LOAD, 'LOAD should have read itself from address 0');
});

test('opcode bytes are reduced modulo MAX_I', () => {
  const rom = new Uint8Array([255, 0, 0]);
  const processor = new Processor(rom, 1, 16, new Rng(1));
  processor.run();
  assert.equal(255 % MAX_I, Instruction.LOAD, 'the fixture only works if this is LOAD');
  assert.equal(processor.accumulator, 255, 'LOAD read its own opcode byte');
});

test('arithmetic is 8-bit and wraps', () => {
  assert.equal(exec([Instruction.ADD, 0x0f, Instruction.ADD, 0xf1], 2).accumulator, 0);
  assert.equal(exec([Instruction.SUB, 1], 1).accumulator, 255);
  assert.equal(exec([Instruction.ADD, 0xff, Instruction.SUB, 0xfe], 2).accumulator, 1);
  assert.equal(exec([Instruction.ADD, 0x11, Instruction.MUL, 0x10], 2).accumulator, 16);
  assert.equal(exec([Instruction.INC], 1).accumulator, 1);
  assert.equal(exec([Instruction.DEC], 1).accumulator, 255);
  assert.equal(exec([Instruction.NOT], 1).accumulator, 255);
});

test('DIV by zero leaves the accumulator alone', () => {
  assert.equal(exec([Instruction.ADD, 80, Instruction.DIV, 0], 2).accumulator, 80);
  assert.equal(exec([Instruction.ADD, 80, Instruction.DIV, 0, Instruction.DIV, 16], 3).accumulator, 5);
});

test('bitwise operations are 8-bit', () => {
  assert.equal(exec([Instruction.ADD, 0xf0, Instruction.AND, 0x3c], 2).accumulator, 0x30);
  assert.equal(exec([Instruction.ADD, 0xf0, Instruction.OR, 0x0f], 2).accumulator, 0xff);
  assert.equal(exec([Instruction.ADD, 0xf0, Instruction.NAND, 0x0f], 2).accumulator, 0xff);
  assert.equal(exec([Instruction.ADD, 0xf0, Instruction.NOR, 0x0f], 2).accumulator, 0x00);
  assert.equal(exec([Instruction.ADD, 0xff, Instruction.XOR, 0x0f], 2).accumulator, 0xf0);
});

test('IN and OUT mirror the accumulator, indexed modulo the port count', () => {
  const processor = new Processor(
    new Uint8Array([Instruction.IN, 5, Instruction.OUT, 1]),
    2,
    16,
    new Rng(1),
  );
  processor.setIn(5, 42);
  processor.run();
  assert.equal(processor.accumulator, 42);
  assert.equal(processor.readOut(1), 42);

  // INPUTS and OUTPUTS are taken modulo, so index 29 reads port 0 and index 4 writes port 0.
  const wrappedIn = new Processor(new Uint8Array([Instruction.IN, INPUTS]), 1, 16, new Rng(1));
  wrappedIn.setIn(0, 7);
  wrappedIn.run();
  assert.equal(wrappedIn.accumulator, 7);

  const wrappedOut = new Processor(
    new Uint8Array([Instruction.ADD, 0x33, Instruction.OUT, OUTPUTS]),
    2,
    16,
    new Rng(1),
  );
  wrappedOut.run();
  assert.equal(wrappedOut.readOut(0), 0x33);
});

test('JMPZ and JMPNZ branch on the accumulator', () => {
  // acc is 0, so JMPZ jumps to 6 and never runs the ADD 0xff at address 3.
  assert.equal(
    exec([Instruction.JMPZ, 6, 0, Instruction.ADD, 0xff, 0, Instruction.ADD, 1], 2).accumulator,
    1,
  );
  // acc is 5, so JMPNZ jumps to 6 and runs the INC there.
  assert.equal(
    exec([Instruction.ADD, 5, Instruction.JMPNZ, 6, 0, 0, Instruction.INC], 3).accumulator,
    6,
  );
  // acc is 0, so JMPNZ falls through to the ADD.
  assert.equal(exec([Instruction.JMPNZ, 4, 0, Instruction.ADD, 9], 2).accumulator, 9);
});

test('CALL pushes a frame and RET restores it', () => {
  // CALL [6] runs the INC at 6, RET returns to 3, and the INC there adds the second one.
  const processor = exec(
    [
      Instruction.SUBROUTINE, 6, 0,
      Instruction.INC, 0, 0,
      Instruction.INC,
      Instruction.RET,
    ],
    4,
  );
  assert.equal(processor.accumulator, 2, 'both INCs should have run, once through the call');
});

test('RET below four bytes of stack does nothing', () => {
  assert.equal(exec([Instruction.RET, Instruction.INC], 2).accumulator, 1);
});

test('the ROM is copied at construction, not aliased', () => {
  const rom = new Uint8Array([
    Instruction.ADD, 0x11,
    Instruction.PUSH,
    Instruction.ADD, 0x99,
    Instruction.POP,
  ]);
  const processor = new Processor(rom, 4, 16, new Rng(1));
  rom[1] = 0x99;
  processor.run();
  // An aliased ROM would add 0x99 instead, leaving 0x99 in the accumulator.
  assert.equal(processor.accumulator, 0x11);
});

test('RAND consumes exactly one draw and keeps the % 0xff range', () => {
  const source = new Rng(7);
  const mirror = new Rng(7);
  const processor = new Processor(
    new Uint8Array([Instruction.RAND, Instruction.RAND, Instruction.RAND]),
    3,
    16,
    source,
  );
  processor.run();

  const draws = [mirror.next() % 0xff, mirror.next() % 0xff, mirror.next() % 0xff];
  assert.equal(processor.accumulator, draws[2], 'the third RAND should be the third draw');
});

test('qrand() % 0xff can never produce 255, but reaches 254', () => {
  const rng = new Rng(20260916);
  let highest = -1;
  for (let i = 0; i < 200_000; i++) {
    const value = rng.next() % 0xff;
    if (value > highest) highest = value;
    assert.ok(value < 255, `draw ${i} produced 255, which % 0xff cannot`);
  }
  assert.equal(highest, 254, 'the whole range below the modulus must be reachable');
});

/**
 * How far ip advances for each opcode, MEASURED rather than read off the
 * source, because the two things that use this — the disassembler's instruction
 * boundaries and OPERAND_BYTES — are only as good as the claim that the VM
 * consumes operands unconditionally per opcode.
 *
 * The expectation is written out by hand from step() (27 entries, enum order:
 * NOOP PUSH POP PUSHA POPA SUBROUTINE RET IN OUT JMP JMPZ JMPNZ LOAD STORE INC
 * DEC NOT AND OR NAND NOR XOR ADD SUB MUL DIV RAND), so it is an independent
 * artefact: the test fails if step() changes, if OPERAND_BYTES is edited, or if
 * the two drift apart.
 */
const CONSUMPTION = [0, 0, 0, 2, 2, 2, 0, 1, 1, 2, 2, 2, 2, 2, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0];

/**
 * The address both operand bytes form when they are 0x11 (low) and 0x22 (high),
 * against the genome length used below.
 *
 * The length is 100, and that is deliberate: 256 is a multiple of 32, 64 and 16,
 * so with a power-of-two-ish genome length (high << 8) + low is congruent to low
 * alone — a VM that read only one operand byte and ignored the high byte would
 * land on the same address and this test would agree with it. 100 does not divide
 * 256, so the two readings differ and the low-byte-first question is decidable
 * here. The C++ leaves argument evaluation order formally unspecified (see the
 * header of processor.ts), which is exactly why this needs a case that can tell.
 */
const ROM_LEN = 100;
const TARGET = ((0x22 << 8) + 0x11) % ROM_LEN; // 21; the low byte alone would be 17.

test('every opcode consumes the operand bytes OPERAND_BYTES claims, measured from ip', () => {
  assert.equal(CONSUMPTION.length, MAX_I, 'the table must cover every opcode');
  assert.equal(OPERAND_BYTES.length, MAX_I);

  for (let op = 0; op < MAX_I; op++) {
    assert.equal(OPERAND_BYTES[op], CONSUMPTION[op], `OPERAND_BYTES[${Instruction[op]}]`);

    // genome: [op, 0x11, 0x22, 0, ...] — a single step, so nothing else executes.
    const rom = new Uint8Array(ROM_LEN);
    rom[0] = op;
    rom[1] = 0x11;
    rom[2] = 0x22;
    const processor = new Processor(rom, 1, 16, new Rng(7));
    processor.run();
    const { ip } = processor.state;

    // Four opcodes move ip to an address instead of advancing it, so their
    // consumption is not directly observable — what is observable is the target,
    // and a target of 17 can only be formed by reading BOTH operand bytes
    // little-endian first (a single byte, or high-byte-first, gives something else).
    // JMP and SUBROUTINE always branch; JMPZ does too here, because acc starts at 0.
    const branchesToTarget = op === Instruction.JMP
      || op === Instruction.SUBROUTINE
      || op === Instruction.JMPZ;
    if (branchesToTarget) {
      assert.equal(ip, TARGET, `${Instruction[op]} should jump to the address the operands form`);
      continue;
    }
    if (op === Instruction.JMPNZ) {
      assert.equal(ip, 3, 'JMPNZ with acc === 0 does not branch, so it advances past both operands');
      continue;
    }
    assert.equal(ip, 1 + CONSUMPTION[op], `${Instruction[op]} advanced to the wrong address`);
  }
});

test('the not-taken branch of JMPNZ consumes both operand bytes, and the taken one lands on target', () => {
  // INC makes acc 1, so JMPNZ branches; then 0x11/0x22 are its operands.
  const taken = new Uint8Array(ROM_LEN);
  taken[0] = Instruction.INC;
  taken[1] = Instruction.JMPNZ;
  taken[2] = 0x11;
  taken[3] = 0x22;
  const p1 = new Processor(taken, 2, 16, new Rng(7));
  p1.run();
  assert.equal(p1.state.ip, TARGET, 'taken JMPNZ must land on the address the operands form');

  // The same instruction with acc still 0 is NOT taken, which is the only way to
  // observe that its operands are consumed regardless.
  const notTaken = new Uint8Array(ROM_LEN);
  notTaken[0] = Instruction.NOOP;
  notTaken[1] = Instruction.JMPNZ;
  notTaken[2] = 0x11;
  notTaken[3] = 0x22;
  const p2 = new Processor(notTaken, 2, 16, new Rng(7));
  p2.run();
  assert.equal(p2.state.ip, 4, 'the not-taken path must still advance past the operands');

  // JMPZ must read its operands even when acc !== 0 and it does not branch.
  const jmpzNotTaken = new Uint8Array(ROM_LEN);
  jmpzNotTaken[0] = Instruction.INC;
  jmpzNotTaken[1] = Instruction.JMPZ;
  jmpzNotTaken[2] = 0x11;
  jmpzNotTaken[3] = 0x22;
  const p4 = new Processor(jmpzNotTaken, 2, 16, new Rng(7));
  p4.run();
  assert.equal(p4.state.ip, 4, 'JMPZ with acc !== 0 must still consume both operands');
});
