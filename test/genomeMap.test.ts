/**
 * The genome strip's arithmetic.
 *
 * The strip is a picture, so the assertions here are about the properties that
 * make it a picture rather than about what any particular band says. Three of
 * them could each be wrong in a way that still looks like a strip:
 *
 *   - COVERAGE. Every byte in 0..length-1 exactly once, in address order. A gap
 *     is a pixel nobody fills, an overlap is a band stealing width from the next
 *     one, and either shifts everything to its right. This is asserted over real
 *     genomes at many lengths, over length 0 and length 1, and over the case where
 *     the last instruction's operands wrap to the front of the genome.
 *   - THE CLASSES ARE COMPLETE. `opClass` must be total over 0..MAX_I-1 and the
 *     per-class counts must add up to MAX_I, or the legend would have opcodes
 *     with no colour and colours with no opcodes.
 *   - THE TAIL. The sweep is expected to cover everything, but the strip must not
 *     depend on that: `stripFromListing` given a short listing has to fill the
 *     remainder with a band that says it was not decoded, instead of returning a
 *     strip that silently stops short.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeLinear } from '../src/sim/disasm.js';
import { Instruction, MAX_I } from '../src/sim/processor.js';
import { Rng } from '../src/sim/rng.js';
import {
  CLASS_LABEL, CLASS_ORDER, TAIL_NAME, TAIL_OPCODE,
  classTotals, genomeStrip, opClass, opcodeNames, stripFromListing,
  type OpClass, type StripSegment,
} from '../src/ui/genomeMap.js';

/** A genome of the requested length, from a stated seed. */
function genomeOf(seed: number, length: number): Uint8Array {
  const rng = new Rng(seed);
  const genome = new Uint8Array(length);
  for (let i = 0; i < length; i++) genome[i] = rng.int(256);
  return genome;
}

/**
 * How many bands claim each byte.
 *
 * Returns the per-byte count so a test can tell a gap (0) from a double cover (2)
 * from the honest answer (1), which is more use than a boolean.
 */
function coverCounts(strip: readonly StripSegment[], length: number): number[] {
  const counts = new Array<number>(length).fill(0);
  for (const band of strip) {
    for (let i = 0; i < band.length; i++) counts[band.address + i] += 1;
  }
  return counts;
}

function assertCoversExactly(strip: readonly StripSegment[], length: number, what: string): void {
  // Address order and contiguity: each band starts where the previous one ended.
  let next = 0;
  for (const band of strip) {
    assert.equal(band.address, next, `${what}: band starting at ${band.address} does not follow the one ending at ${next}`);
    assert.ok(band.length >= 1, `${what}: band at ${band.address} covers no bytes`);
    next = band.address + band.length;
  }
  assert.equal(next, length, `${what}: the strip ends at ${next} but the genome is ${length} bytes`);

  // And the per-byte count, which is the same statement said the other way: every
  // byte is in exactly one band. Kept as well as the walk because it is the one
  // that fails loudly for an overlap between two bands that both look in order.
  const counts = coverCounts(strip, length);
  for (let i = 0; i < length; i++) {
    assert.equal(counts[i], 1, `${what}: byte ${i} is covered ${counts[i]} times`);
  }
}

test('the strip covers every byte of every genome exactly once', () => {
  // Several seeds per length: with one seed a genome can happen to decode into
  // single-byte instructions and the interesting cases never arise.
  for (const length of [1, 2, 3, 4, 5, 6, 7, 8, 9, 17, 64, 300, 601]) {
    for (let seed = 1; seed <= 8; seed++) {
      const genome = genomeOf(seed, length);
      assertCoversExactly(genomeStrip(genome), length, `seed ${seed} length ${length}`);
    }
  }
});

test('a genome of no bytes has no bands', () => {
  // Not one zero-length band at address 0: a band is a run of bytes, and the panel
  // draws the empty track it is given rather than a zero-width one.
  assert.deepEqual(genomeStrip(new Uint8Array(0)), []);
  assert.equal(classTotals(genomeStrip(new Uint8Array(0))).other, 0);
});

test('a genome of one byte is one band, whatever that byte is', () => {
  // Every opcode reads its operands modulo the genome length, so on a one-byte
  // genome even a JMP reads both operands from its own byte. That is a wrapped
  // instruction whose three bytes are one byte, and it must still be one band.
  for (let byte = 0; byte < 256; byte++) {
    const strip = genomeStrip(new Uint8Array([byte]));
    assert.equal(strip.length, 1, `byte ${byte} produced ${strip.length} bands`);
    assertCoversExactly(strip, 1, `byte ${byte}`);
    assert.equal(strip[0].opcode, byte % MAX_I);
    assert.equal(strip[0].klass, opClass(byte % MAX_I));
  }
});

test('a last instruction whose operands wrap is clipped to the last byte and keeps the flag', () => {
  // NOOP NOOP NOOP NOOP JMP over 5 bytes. The JMP reads its two operand bytes from
  // slots 0 and 1, so the sweep says it is three bytes long — two of which are the
  // first two bytes of the genome, already drawn by the bands at addresses 0 and 1.
  const genome = new Uint8Array([Instruction.NOOP, Instruction.NOOP, Instruction.NOOP, Instruction.NOOP, Instruction.JMP]);
  const listing = decodeLinear(genome);
  const last = listing[listing.length - 1];
  assert.equal(last.address, 4, 'the fixture does not end with the JMP');
  assert.equal(last.wrapped, true, 'the fixture does not wrap');
  assert.ok(last.length > 1, 'the fixture is not longer than the bytes it has left');

  const strip = genomeStrip(genome);
  assertCoversExactly(strip, genome.length, 'wrapped tail');

  const end = strip[strip.length - 1];
  assert.equal(end.address, 4);
  assert.equal(end.wrapped, true, 'clipping the band dropped the wrap the reader needs to be told about');
  assert.equal(end.address + end.length, genome.length, 'the strip does not reach the last byte');
  // Clipped, not stretched and not dropped: the band is shorter than the
  // instruction, because the instruction's other bytes live at the front.
  assert.ok(end.length < last.length, `the band kept all ${end.length} bytes of a wrapped instruction`);
  // Only the wrapped one: the flag is about this instruction's reads, not about
  // the genome having reached its end.
  assert.equal(strip.filter((band) => band.wrapped).length, 1);
});

test('the last band ends exactly where the genome does, wrapped or not', () => {
  // Over real genomes rather than the one fixture, including the degenerate
  // lengths where a short genome's operand wraps back onto its own first byte.
  let sawWrapped = 0;
  for (const length of [2, 3, 4, 5, 8, 17, 64, 300, 601]) {
    for (let seed = 1; seed <= 8; seed++) {
      const genome = genomeOf(seed, length);
      const listing = decodeLinear(genome);
      const strip = genomeStrip(genome);
      const lastInstruction = listing[listing.length - 1];
      const lastBand = strip[strip.length - 1];
      assert.equal(lastBand.address + lastBand.length, length, `length ${length} seed ${seed}: strip stops at ${lastBand.address + lastBand.length}`);
      assert.equal(lastBand.wrapped, lastInstruction.wrapped, `length ${length} seed ${seed}: the flag disagrees with the sweep`);
      if (lastBand.wrapped) sawWrapped++;
    }
  }
  // The assertion above is only worth anything if the case occurred.
  assert.ok(sawWrapped > 0, 'no genome in this set ended with a wrapped instruction');
});

test('the sweep covers the whole genome, so no band is a tail', () => {
  // The tail band exists for a listing that stops short, and the linear sweep is
  // not expected to be one — its starts are the running total of instruction
  // lengths, which is below the genome length by the loop's own condition, so the
  // bands tile the genome. If that ever stops being true this fails, and the tail
  // path silently becoming load-bearing is exactly what should be noticed.
  for (const length of [1, 2, 5, 17, 64, 300]) {
    for (let seed = 1; seed <= 4; seed++) {
      const strip = genomeStrip(genomeOf(seed, length));
      assert.equal(strip.filter((band) => band.name === TAIL_NAME).length, 0, `length ${length} seed ${seed} needed a tail band`);
    }
  }
});

test('every band is the instruction it came from', () => {
  // Names, opcodes and classes have to be the sweep's, not re-derived: the point of
  // reusing decodeLinear is that the strip cannot disagree with the inspector about
  // what a byte is.
  const genome = genomeOf(7, 200);
  const listing = decodeLinear(genome);
  const strip = genomeStrip(genome);
  for (const band of strip) {
    const ins = listing.find((row) => row.address === band.address);
    assert.ok(ins !== undefined, `band at ${band.address} has no instruction`);
    assert.equal(band.name, ins.name);
    assert.equal(band.opcode, ins.opcode);
    assert.equal(band.klass, opClass(ins.opcode));
  }
  // Every instruction start is a band start, and vice versa.
  assert.deepEqual(strip.map((band) => band.address), listing.map((row) => row.address));
});

test('the opcode on a band is what the VM runs, not the byte that is stored', () => {
  // A genome written by mutation holds bytes above MAX_I; those run as their
  // remainder, and a strip coloured by the raw byte would call 245 something the
  // machine never does.
  const genome = new Uint8Array([245, 254, 27, 28]);
  const strip = genomeStrip(genome);
  assertCoversExactly(strip, genome.length, 'modulo bytes');
  for (const band of strip) assert.ok(band.opcode >= 0 && band.opcode < MAX_I, `opcode ${band.opcode} is out of range`);
  assert.equal(strip[0].opcode, 245 % MAX_I);
  assert.equal(strip[0].name, Instruction[245 % MAX_I]);
});

test('every opcode has a class, and the classes add up to the opcodes', () => {
  // Total over the range the VM can execute, and every class in the legend is
  // reachable — a legend row that no opcode can fill is a colour the reader is
  // told about and will never see.
  const perClass = new Map<OpClass, number>();
  for (let op = 0; op < MAX_I; op++) {
    const klass = opClass(op);
    assert.ok(CLASS_ORDER.includes(klass), `opcode ${op} (${Instruction[op]}) classified as ${String(klass)}, which is not in CLASS_ORDER`);
    perClass.set(klass, (perClass.get(klass) ?? 0) + 1);
  }
  const total = [...perClass.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, MAX_I);

  // The exact shape of the classification, not just its total: these counts are
  // what the legend's proportions are, and an opcode that changes class (or a new
  // opcode defaulting into 'other') should require someone to edit this line.
  assert.deepEqual(Object.fromEntries(perClass), {
    other: 1, control: 5, stack: 4, io: 2, memory: 2, arith: 7, logic: 6,
  });
  for (const klass of CLASS_ORDER) {
    assert.ok((perClass.get(klass) ?? 0) > 0, `class ${klass} has no opcodes`);
  }
});

test('opClass answers for anything, and calls what it does not know "other"', () => {
  // The one out-of-range value that reaches this in practice is TAIL_OPCODE, from
  // the undecoded tail. A picture is not worth an exception, so it is 'other' —
  // which is also the colour the tail is drawn in, so the two agree.
  assert.equal(opClass(TAIL_OPCODE), 'other');
  assert.equal(opClass(MAX_I), 'other');
  assert.equal(opClass(255), 'other');
  assert.equal(opClass(-1), 'other');
  assert.equal(opClass(1.5), 'other');
  assert.equal(opClass(Number.NaN), 'other');
});

test('the legend order and labels cover the classes exactly', () => {
  // Duplicated class is a legend row printed twice; a missing one is a colour with
  // no key; a blank or repeated label is two rows a reader cannot tell apart.
  assert.equal(new Set(CLASS_ORDER).size, CLASS_ORDER.length, 'CLASS_ORDER repeats a class');
  const labels = CLASS_ORDER.map((klass) => CLASS_LABEL[klass]);
  for (const label of labels) assert.equal(typeof label, 'string');
  for (const label of labels) assert.ok(label.length > 0, 'a class has no label');
  assert.equal(new Set(labels).size, labels.length, 'two classes share a label');
  assert.equal(Object.keys(CLASS_LABEL).length, CLASS_ORDER.length, 'CLASS_LABEL has a class CLASS_ORDER does not');
  for (const klass of CLASS_ORDER) assert.ok(klass in CLASS_LABEL);
});

test('opcodeNames is the enum, in order, with nothing invented', () => {
  const names = opcodeNames();
  assert.equal(names.length, MAX_I);
  for (let op = 0; op < MAX_I; op++) {
    assert.equal(names[op], Instruction[op], `opcode ${op} is named ${names[op]} but the enum says ${Instruction[op]}`);
  }
  assert.equal(new Set(names).size, names.length, 'two opcodes share a name');
  for (const name of names) assert.ok(name.length > 0, 'an opcode has no name');
});

test('class totals are the strip, summed by class', () => {
  const genome = genomeOf(11, 400);
  const strip = genomeStrip(genome);
  const totals = classTotals(strip);

  // Independently summed, per class, from the bands themselves.
  for (const klass of CLASS_ORDER) {
    const expected = strip.filter((band) => band.klass === klass).reduce((n, band) => n + band.length, 0);
    assert.equal(totals[klass], expected, `class ${klass} totals ${totals[klass]}, bands say ${expected}`);
  }
  const sum = CLASS_ORDER.reduce((n, klass) => n + totals[klass], 0);
  assert.equal(sum, genome.length, `the totals add up to ${sum} bytes of ${genome.length}`);
  // Every class is keyed, including the ones this genome does not use: the legend
  // must not have to tell "absent" from "missing".
  assert.deepEqual(Object.keys(totals).sort(), [...CLASS_ORDER].sort());
});

test('an undecoded tail is filled in, and says it was not decoded', () => {
  // A listing that stops after two bytes of a ten-byte genome. This is the case
  // the sweep is not expected to produce, and the strip has to survive it anyway:
  // eight bytes with no band is a picture that stops two thirds of the way across
  // while claiming to be the genome.
  const genome = genomeOf(3, 10);
  const full = decodeLinear(genome);
  const short = full.slice(0, 2);
  const covered = short.reduce((n, ins) => n + ins.length, 0);
  assert.ok(covered < genome.length, 'the fixture listing is not short');

  const strip = stripFromListing(short, genome.length);
  assertCoversExactly(strip, genome.length, 'short listing');

  const tail = strip[strip.length - 1];
  assert.equal(tail.name, TAIL_NAME);
  assert.equal(tail.opcode, TAIL_OPCODE);
  assert.equal(tail.klass, 'other');
  assert.equal(tail.wrapped, false, 'the tail is not a wrapped instruction');
  assert.equal(tail.address, covered, 'the tail does not start where the listing stopped');
  assert.equal(tail.length, genome.length - covered);
  // The decoded bands are still the ones that were decoded, and still classified.
  assert.deepEqual(strip.slice(0, 2).map((band) => band.name), short.map((ins) => ins.name));
});

test('a listing that does not start at address 0 fills from 0 with a tail', () => {
  // The bands must stay at the addresses their bytes live at. A listing whose
  // first row is at address 3 describes bytes 3.., so it cannot be laid down from
  // 0; the strip says "nothing decoded" for the whole genome instead of drawing
  // that instruction's name over the wrong bytes.
  const genome = genomeOf(5, 10);
  const listing = decodeLinear(genome);
  const offset = listing.slice(1);
  assert.ok(offset[0].address !== 0, 'the fixture starts at 0');

  const strip = stripFromListing(offset, genome.length);
  assertCoversExactly(strip, genome.length, 'offset listing');
  assert.equal(strip.length, 1);
  assert.equal(strip[0].name, TAIL_NAME);
  assert.equal(strip[0].address, 0);
});

test('a listing that overruns the genome is clipped to it', () => {
  // The last instruction can be longer than the bytes left (that is the wrapped
  // case), and a strip is not allowed to claim bytes the genome does not have.
  const genome = genomeOf(9, 6);
  const strip = genomeStrip(genome);
  for (const band of strip) {
    assert.ok(band.address + band.length <= genome.length, `band at ${band.address} runs past the genome`);
  }
  assertCoversExactly(strip, genome.length, 'overrun');
});
