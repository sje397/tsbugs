/**
 * The world store: the text format's refusals, and the browser storage around it.
 *
 * Two things are being checked, and only one of them is about round-tripping.
 * The interesting half is FAILURE, because a save that quietly half-works is
 * indistinguishable from a load that quietly half-works until someone loses a
 * world. So most of these tests feed the decoder something wrong and assert it
 * says so, naming the field.
 *
 * The storage tests use a fake with a size limit, because the real one's limit is
 * the browser's and its failure mode is an exception whose message is a DOM name.
 * Making that path testable is the reason WorldStorage is an interface rather than
 * `localStorage` itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PetriDish } from '../src/sim/dish.js';
import { DEFAULT_PARAMS } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import {
  base64ToBytes,
  bytesToBase64,
  decodeWorld,
  deleteWorld,
  encodeWorld,
  isValidWorldName,
  listWorlds,
  MAX_WORLD_NAME,
  loadWorld,
  readWorldText,
  WORLD_FORMAT,
  saveWorld,
  storageUsed,
  WORLD_KEY_PREFIX,
  type WorldStorage,
} from '../src/ui/worldStore.js';

/** A stand-in for localStorage, with the one property that matters: a limit. */
class FakeStorage implements WorldStorage {
  private readonly items = new Map<string, string>();

  constructor(private readonly limit = Infinity) {}

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    let used = 0;
    for (const [k, v] of this.items) used += k.length + v.length;
    if (k_used(this.items, key, value) > this.limit) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  /** Test-only: put a raw string in, so a corrupt entry can be simulated. */
  raw(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** Characters after the write, counting a replaced entry once. */
function k_used(items: Map<string, string>, key: string, value: string): number {
  let used = 0;
  for (const [k, v] of items) {
    if (k === key) continue;
    used += k.length + v.length;
  }
  return used + key.length + value.length;
}

function world(seed = 11, ticks = 40): PetriDish {
  const dish = new PetriDish(DEFAULT_PARAMS, new Rng(seed));
  for (let i = 0; i < ticks; i++) dish.step();
  return dish;
}

// -------------------------------------------------------------------- base64

test('base64 round trips every length, including the two that need padding', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 257, 2048]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 255;
    const text = bytesToBase64(bytes);
    assert.equal(text.length % 4, 0);
    assert.deepEqual(Array.from(base64ToBytes(text)), Array.from(bytes), `length ${length}`);
  }
});

test('base64 refuses what it cannot decode rather than guessing', () => {
  // These are the cases the two platform decoders disagree about, which is why
  // this file carries its own instead of calling btoa/atob.
  assert.throws(() => base64ToBytes('AAA'), /not a multiple of 4/);
  assert.throws(() => base64ToBytes('AA*A'), /invalid character at 2/);
  assert.throws(() => base64ToBytes('A=== '), /not a multiple of 4/);
  assert.throws(() => base64ToBytes('AA==AA=='), /padding at 0/);
});

// -------------------------------------------------------------------- format

test('encoding is deterministic', () => {
  const snapshot = world().snapshot();
  assert.equal(encodeWorld(snapshot), encodeWorld(snapshot));
});

test('the decoder refuses a text that is not a world, naming the field', () => {
  const text = encodeWorld(world().snapshot());
  const mutate = (edit: (world: Record<string, unknown>) => void): string => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    edit(parsed);
    return JSON.stringify(parsed);
  };

  assert.throws(() => decodeWorld('{oh no'), /not JSON/);
  assert.throws(() => decodeWorld('[]'), /not a saved world: expected a JSON object/);
  assert.throws(() => decodeWorld('"a string"'), /not a saved world/);
  assert.throws(() => decodeWorld('null'), /not a saved world/);
  assert.throws(() => decodeWorld(mutate((w) => (w.version = 99))), /format version 99/);
  assert.throws(() => decodeWorld(mutate((w) => (w.cells = 'nope'))), /world.cells is not an array/);
  assert.throws(() => decodeWorld(mutate((w) => (w.energy = [[0]]))), /not a pair/);
  assert.throws(
    () => decodeWorld(mutate((w) => (w.energy = [[0, 5], [0, 6]]))),
    /lists cell 0 twice/,
  );
  assert.throws(
    () => decodeWorld(mutate((w) => (w.poison = [10_000_000]))),
    /world.poison\[0\]/,
  );
});

test('the decoder refuses a bug whose machine could not exist', () => {
  const text = encodeWorld(world().snapshot());
  const mutateBug = (edit: (bug: Record<string, unknown>, processor: Record<string, unknown>) => void): string => {
    const parsed = JSON.parse(text) as { cells: Array<{ b: Array<Record<string, unknown>> }> };
    const bug = parsed.cells[0].b[0];
    edit(bug, bug.p as Record<string, unknown>);
    return JSON.stringify(parsed);
  };

  assert.throws(() => decodeWorld(mutateBug((_b, p) => (p.ip = 999999))), /ip 999999 is past the end/);
  assert.throws(() => decodeWorld(mutateBug((_b, p) => (p.ac = 300))), /ac is not a byte/);
  assert.throws(() => decodeWorld(mutateBug((_b, p) => (p.o = [0, 0, 0]))), /has 3 outputs, not 4/);
  assert.throws(() => decodeWorld(mutateBug((b) => (b.e = 'lots'))), /e is not an integer/);
  assert.throws(() => decodeWorld(mutateBug((_b, p) => (p.st = 'A'.repeat(400)))), /saved 300 stack bytes but the stack is 64/);
  assert.throws(
    () => decodeWorld(mutateBug((b) => (b.r = [[999999, 1]]))),
    /outside a|not a pair|outside/,
  );
});

// ------------------------------------------------------------------- storage

test('a saved world lists, reads back, and restores', () => {
  const storage = new FakeStorage();
  const original = world();
  const saved = saveWorld(storage, 'first world', original.snapshot());

  assert.equal(saved.name, 'first world');
  assert.equal(saved.tick, original.time);
  assert.equal(saved.population, original.population);
  assert.ok(saved.storedBytes > 0);

  const listed = listWorlds(storage);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].problem, null);
  assert.equal(listed[0].population, original.population);

  const text = readWorldText(storage, 'first world');
  assert.ok(text !== null);
  const restored = PetriDish.restore(decodeWorld(text));
  assert.equal(restored.population, original.population);
  assert.equal(restored.time, original.time);
  assert.equal(encodeWorld(restored.snapshot()), encodeWorld(original.snapshot()));

  // The two ways out of the store agree, and both are the same format a file holds.
  const loaded = loadWorld(storage, 'first world');
  assert.ok(loaded !== null);
  assert.equal(encodeWorld(loaded), text);
});

test('saving over a name replaces it rather than adding a second one', () => {
  const storage = new FakeStorage();
  saveWorld(storage, 'same', world(1, 10).snapshot());
  saveWorld(storage, 'same', world(2, 20).snapshot());

  assert.equal(listWorlds(storage).length, 1);
  const restored = PetriDish.restore(decodeWorld(readWorldText(storage, 'same') ?? ''));
  assert.equal(restored.time, 20);
});

test('the list survives a corrupt entry, and names it', () => {
  const storage = new FakeStorage();
  saveWorld(storage, 'good', world().snapshot());
  storage.raw(`${WORLD_KEY_PREFIX}broken`, '{"format":"tsbugs-world"');
  storage.raw(`${WORLD_KEY_PREFIX}alien`, '{"format":"something-else"}');
  // Parses, and claims the right format, but holds no world: a listing that showed
  // this as a row of nulls would be claiming it can be loaded.
  storage.raw(`${WORLD_KEY_PREFIX}hollow`, `{"format":"${WORLD_FORMAT}","meta":{},"savedAt":null}`);

  const listed = listWorlds(storage);
  assert.equal(listed.length, 4);
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('good')?.problem, null);
  assert.match(byName.get('broken')?.problem ?? '', /unreadable/);
  assert.match(byName.get('alien')?.problem ?? '', /not a saved world/);
  assert.match(byName.get('hollow')?.problem ?? '', /incomplete: carries no world/);
  // Every entry the listing calls a problem must also fail to produce a world: the
  // two must agree, or the panel offers a Load button that cannot work. A corrupt
  // entry throws from readWorldText (naming itself) rather than returning null, so
  // both refusals count as "no world" here.
  for (const entry of listed) {
    if (entry.problem === null) continue;
    let world: unknown;
    try {
      world = loadWorld(storage, entry.name);
    } catch {
      world = null;
    }
    assert.equal(world, null, `${entry.name} is listed with a problem but loads`);
  }
  // The point of the test: one bad entry did not take the good one with it.
  assert.ok(storage.getItem(`${WORLD_KEY_PREFIX}good`) !== null);
});

test('a full store fails loudly, in words, and keeps the world it was replacing', () => {
  // Sized from a measurement, not a guess: the store is given exactly room for one
  // world of this size plus a little, so the second write must fail.
  const snapshot = world().snapshot();
  const measured = saveWorld(new FakeStorage(), 'measure', snapshot).storedBytes;
  const storage = new FakeStorage(measured + 200);

  saveWorld(storage, 'kept', snapshot);
  const before = listWorlds(storage)[0];
  assert.equal(before.name, 'kept');

  assert.throws(() => saveWorld(storage, 'too big', snapshot), /No room left/);
  assert.equal(listWorlds(storage).length, 1, 'the refused world should not be half-written');

  // Replacing an existing name with a LARGER world must also fail without
  // destroying what was there — the write is refused, not partially applied.
  // The precondition is asserted because a world's size is not its tick count: a
  // longer run can hold FEWER bugs, and a fixture that quietly became the smaller
  // one would make this test pass for the wrong reason.
  const larger = world(7, 120).snapshot();
  assert.ok(
    encodeWorld(larger).length > encodeWorld(snapshot).length,
    'the replacement world must be bigger than the one it replaces',
  );
  assert.throws(() => saveWorld(storage, 'kept', larger), /No room left/);
  const after = listWorlds(storage)[0];
  assert.equal(after.storedBytes, before.storedBytes);
  assert.equal(loadWorld(storage, 'kept')?.counters.population, before.population);
});

test('deleting reports whether there was anything to delete', () => {
  const storage = new FakeStorage();
  saveWorld(storage, 'gone', world(1, 5).snapshot());
  assert.equal(deleteWorld(storage, 'gone'), true);
  assert.equal(deleteWorld(storage, 'gone'), false);
  assert.equal(listWorlds(storage).length, 0);
});

test('the list is newest first, and undated entries last', () => {
  const storage = new FakeStorage();
  const snap = world(1, 5).snapshot();
  saveWorld(storage, 'older', snap);
  storage.raw(
    `${WORLD_KEY_PREFIX}undated`,
    JSON.stringify({ format: 'tsbugs-world', name: 'undated', meta: {}, world: '{}' }),
  );
  // savedAt is written as a timestamp, so make the first entry demonstrably older.
  const older = JSON.parse(storage.getItem(`${WORLD_KEY_PREFIX}older`) ?? '') as Record<string, unknown>;
  older.savedAt = '2020-01-01T00:00:00.000Z';
  storage.raw(`${WORLD_KEY_PREFIX}older`, JSON.stringify(older));
  saveWorld(storage, 'newer', snap);

  const names = listWorlds(storage).map((entry) => entry.name);
  assert.deepEqual(names, ['newer', 'older', 'undated']);
});

test('names are checked, and only world keys are counted', () => {
  assert.equal(isValidWorldName('fine'), true);
  assert.equal(isValidWorldName('   '), false);
  assert.equal(isValidWorldName(''), false);
  assert.equal(isValidWorldName('x'.repeat(MAX_WORLD_NAME + 1)), false);

  const storage = new FakeStorage();
  storage.raw('unrelated-preferences', 'x'.repeat(1000));
  assert.equal(storageUsed(storage), 0);

  saveWorld(storage, 'counted', world(1, 5).snapshot());
  assert.ok(storageUsed(storage) > 1000);
  assert.throws(() => saveWorld(storage, '', world().snapshot()), /not a name this store accepts/);
});
