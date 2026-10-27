/**
 * The inspector's decode arithmetic.
 *
 * These are the questions the page asks of a decoded genome, and the ones a
 * reader would be misled by if the answer were subtly wrong: which row the
 * instruction pointer is standing in, and whether a row is hiding a modulo
 * between what the genome stores and what the machine runs.
 *
 * Both are asserted against real decoded genomes as well as synthetic rows,
 * because the fixture that matters — a row whose operands wrap the end of the
 * genome — only turns up in real ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeLinear, type DecodedInstruction } from '../src/sim/disasm.js';
import { MAX_I } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';
import { formatInstruction, hex4, instructionIndexAt, isMidInstruction, rowBytes, rowTail } from '../src/ui/disasmView.js';

/** A genome of the requested length, from a stated seed. */
function genomeOf(seed: number, length: number): Uint8Array {
  const rng = new Rng(seed);
  const genome = new Uint8Array(length);
  for (let i = 0; i < length; i++) genome[i] = rng.int(256);
  return genome;
}

test('the sweep reaches every byte, and the wrap flag is exactly when it had to', () => {
  // The whole genome, over lengths that include the cases where an operand wraps
  // back onto the row's own first byte (1 and 2) — which is where the flag was
  // once wrong, because it was derived by comparing addresses rather than slots.
  // Several seeds per length, deliberately: with one seed a short genome can
  // decode to a single operand-free instruction, so the wrap this test exists to
  // check never happens and the fixture agrees with a broken flag.
  for (const length of [1, 2, 3, 4, 5, 8, 17, 64, 300, 601]) {
    for (let seed = 1; seed <= 8; seed++) {
    const genome = genomeOf(seed, length);
    const listing = decodeLinear(genome);

    for (let i = 1; i < listing.length; i++) {
      assert.equal(
        listing[i].address,
        (listing[i - 1].address + listing[i - 1].length) % length,
        `rows are contiguous in genome ${length}`,
      );
    }

    // every byte is reached: as a row's own byte, or as an operand of one
    const reached = new Set<number>();
    for (const ins of listing) {
      reached.add(ins.address);
      for (let j = 0; j < ins.length - 1; j++) reached.add((ins.address + 1 + j) % length);
    }
    assert.equal(reached.size, length, `the sweep skipped a byte of genome ${length}`);

    // The flag and the arithmetic have to agree, in both directions: a row whose
    // operands ran off the end re-reads bytes, so the lengths must overrun the
    // genome — and if nothing is flagged, they must tile it exactly.
    const span = listing.reduce((total, ins) => total + ins.length, 0);
    const flagged = listing.some((ins) => ins.wrapped);
    if (flagged) {
      assert.ok(span > length, `genome ${length} seed ${seed} flagged a wrap but the rows tile it exactly`);
    } else {
      assert.equal(span, length, `genome ${length} seed ${seed} wrapped without saying so`);
    }
    }
  }
});

test('a genome so short that an operand reads its own first byte is reported as wrapping', () => {
  // Length 1: the one row's operand is at slot 1, past the end, so it is the
  // genome's own byte read a second time. Comparing addresses missed this
  // entirely — the wrapped address equals the row's address.
  const one = genomeOf(1, 1);
  const listing = decodeLinear(one);
  const [ins] = listing;
  assert.equal(listing.length, 1);
  assert.ok(ins.length > 1, 'seed 1 should produce operands; the fixture is not exercising the case');
  assert.equal(ins.wrapped, true, 'the operand was read from the start, and the listing must say so');

  // and the common case must stay unflagged: a row well inside the genome
  const long = decodeLinear(genomeOf(11, 300));
  const inner = long.filter((ins) => ins.address + ins.length < 300);
  assert.ok(inner.length > 10, 'no interior rows to check');
  assert.ok(inner.every((ins) => ins.wrapped === false), 'an interior row claimed to wrap');
});

test('the pointer resolves to the row that begins at its address', () => {
  const listing = decodeLinear(genomeOf(2024, 500));

  for (const ins of listing) {
    assert.equal(instructionIndexAt(listing, ins.address), listing.indexOf(ins), `ip ${ins.address} is not in its own row`);
    assert.equal(isMidInstruction(listing, instructionIndexAt(listing, ins.address), ins.address), false);
  }

  // a two-byte instruction: the pointer standing on its operand byte is inside the
  // row but not at its start, which is the case the panel marks with '~'
  const multi = listing.findIndex((ins) => ins.length > 1);
  assert.notEqual(multi, -1, 'no multi-byte instruction in 500 bytes — fixture is not exercising the case');
  const inside = listing[multi].address + listing[multi].length - 1;
  assert.equal(instructionIndexAt(listing, inside), multi);
  assert.equal(isMidInstruction(listing, multi, inside), true);
});

test('a pointer past the last instruction highlights nothing rather than the last row', () => {
  const listing = decodeLinear(genomeOf(5, 120));
  const end = listing.at(-1)!.address + listing.at(-1)!.length;

  assert.equal(instructionIndexAt(listing, end), -1);
  assert.equal(isMidInstruction(listing, -1, end), false);
});

test('a row whose operands wrap the genome does not steal the address it wraps to', () => {
  // Find a real wrapped instruction: one whose operand bytes were read from the
  // start of the genome. Its range covers addresses below its own start, and the
  // sweep's row for address 0 is the one a reader is looking at there.
  let wrapped: DecodedInstruction | undefined;
  let listing: DecodedInstruction[] = [];
  for (let seed = 1; seed <= 200 && wrapped === undefined; seed++) {
    listing = decodeLinear(genomeOf(seed, 64));
    wrapped = listing.find((ins) => ins.wrapped);
  }
  assert.ok(wrapped, 'no wrapped instruction found in 200 genomes — the search is blind to its own case');

  const indexAtZero = instructionIndexAt(listing, 0);
  assert.equal(listing[indexAtZero].address, 0, 'address 0 belongs to the row that starts there');
  assert.equal(listing[indexAtZero].wrapped, false, 'and that row is not the one that wrapped');

  // the wrapping row is still reachable at its own start
  assert.equal(instructionIndexAt(listing, wrapped.address), listing.indexOf(wrapped));
});

test('an instruction is shown with the bytes it stores, and says when they are not the opcode', () => {
  const plain: DecodedInstruction = {
    address: 4, byte: 7, opcode: 7, name: 'PUSH', operandBytes: [3], byteAddresses: [4, 5],
    wrapped: false, operandAddress: null, operandAddressRaw: null, length: 2,
  };
  assert.equal(formatInstruction(plain, MAX_I), '07 03        PUSH       ');

  const modulo: DecodedInstruction = { ...plain, byte: 34, opcode: 34 % MAX_I, name: 'PUSH' };
  const annotated = formatInstruction(modulo, MAX_I);
  assert.ok(annotated.startsWith('22 03'), 'the byte as stored leads the row, not the opcode the VM runs');
  assert.ok(
    annotated.includes(`34%${MAX_I}=${34 % MAX_I}`),
    'a genome byte above the opcode count is shown with the modulo the VM applied',
  );
  // The annotation goes after the operand, so the mnemonic column is unmoved —
  // a listing whose columns shift per row is one nobody can scan.
  assert.equal(
    annotated.indexOf('PUSH'),
    formatInstruction(plain, MAX_I).indexOf('PUSH'),
    'a row that needs the modulo note is still aligned with the rows that do not',
  );
});

test('an operand address is shown, and a wrapped or moduloed one admits it', () => {
  const jump: DecodedInstruction = {
    address: 9, byte: 8, opcode: 8, name: 'JMP', operandBytes: [1, 2], byteAddresses: [9, 10, 11],
    wrapped: false, operandAddress: 258, operandAddressRaw: null, length: 3,
  };
  assert.match(formatInstruction(jump, MAX_I), /#258/);
  assert.doesNotMatch(formatInstruction(jump, MAX_I), /wrapped/);

  const wrappedJump: DecodedInstruction = { ...jump, wrapped: true, operandAddress: 2, operandAddressRaw: 258 };
  const line = formatInstruction(wrappedJump, MAX_I);
  assert.match(line, /#2 \(258 wrapped\)/, 'the address before the modulo is the only way to see the wrap happened');
  assert.match(line, /\[operands wrap\]/);
});

test('addresses are shown in hexadecimal without losing leading zeros', () => {
  assert.equal(hex4(0), '0000');
  assert.equal(hex4(10), '000a');
  assert.equal(hex4(2793), '0ae9');
});

test('a row names the slot each of its bytes lives in, wrapped rows included', () => {
  // The editor writes to a slot, so this is the mapping that decides which byte
  // an edit lands on. A wrapped row is the only case where the slots are not
  // `address + n`, and it is the case a reader cannot check by eye.
  for (let seed = 1; seed <= 40; seed++) {
    const genome = genomeOf(seed, 64);
    for (const ins of decodeLinear(genome)) {
      const bytes = rowBytes(ins);
      assert.equal(bytes.length, ins.length, 'a row did not describe every byte it holds');
      bytes.forEach((b, i) => {
        assert.ok(b.address >= 0 && b.address < 64, `slot ${b.address} is outside the genome`);
        assert.equal(
          genome[b.address], [ins.byte, ...ins.operandBytes][i],
          'the byte at that slot is not the byte the row shows',
        );
        assert.equal(b.hex, [ins.byte, ...ins.operandBytes][i].toString(16).padStart(2, '0'));
      });

      if (ins.wrapped) {
        // The whole point: at least one operand was read from a slot numerically
        // below the row's own start — the end of the genome was passed and the
        // read came back round. An address computed without the modulo would be
        // out of range instead, which the bound above already refuses.
        const slots = bytes.slice(1).map((b) => b.address);
        assert.ok(
          slots.some((slot) => slot < ins.address),
          'a wrapped row kept every operand slot above its own start',
        );
      }
    }
  }

  // and the text is the two parts, so the parts and the line cannot drift apart
  const listing = decodeLinear(genomeOf(2024, 500));
  const multi = listing.find((ins) => ins.length === 3)!;
  assert.equal(
    formatInstruction(multi, MAX_I),
    `${rowBytes(multi).map((b) => b.hex).join(' ').padEnd(11)}  ${rowTail(multi, MAX_I)}`,
  );
});
