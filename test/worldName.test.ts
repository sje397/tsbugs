/**
 * The default name a save is given, and the collision it has to survive.
 *
 * Two properties matter and they fail differently. The SHAPE is what a person
 * reads in the list, so a missing pad on month, day, hour, minute or second makes
 * a name that looks right and sorts wrong — the padding is checked by showing the
 * unpadded variant sorting incorrectly, so the test can see the difference rather
 * than merely agreeing with the implementation. The COLLISION is what a double
 * save inside one second produces, and it has to be resolved without the overwrite
 * prompt, because that prompt is a question about replacing a DIFFERENT world.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultWorldName, uniqueWorldName } from '../src/ui/worldName.js';
import { isValidWorldName, MAX_WORLD_NAME } from '../src/ui/worldStore.js';

/** A local-time date, so every assertion holds in whatever zone this runs. */
function at(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

test('the default name is the local date and time, padded to a fixed width', () => {
  assert.equal(defaultWorldName(at(2026, 10, 27, 12, 34, 56)), '2026-10-27 12:34:56');
  assert.equal(defaultWorldName(at(2026, 1, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('the padding is load-bearing: an unpadded name sorts in the wrong order', () => {
  const padded = [at(2026, 9, 30, 23, 59, 59), at(2026, 10, 1, 0, 0, 0)].map(defaultWorldName);
  assert.deepEqual(padded, ['2026-09-30 23:59:59', '2026-10-01 00:00:00']);
  assert.deepEqual([...padded].sort(), padded);

  // The same two instants written without padStart. As text, "2026-10-1" sorts
  // before "2026-9-30", so the list would show tomorrow above today.
  const naive = [
    '2026-9-30 23:59:59',
    '2026-10-1 00:00:00',
  ];
  assert.notDeepEqual([...naive].sort(), naive);
});

test('a default name is one the store accepts, and stays inside its limit', () => {
  const name = defaultWorldName(at(2026, 12, 31, 23, 59, 59));
  assert.equal(name.length, 19);
  assert.ok(name.length <= MAX_WORLD_NAME);
  assert.ok(isValidWorldName(name));
  // The suffix the collision path adds must leave a name the store still takes.
  assert.ok(isValidWorldName(`${name} (99)`));
});

test('a name already taken gets a suffix instead of the overwrite prompt', () => {
  const taken = new Set<string>(['2026-10-27 12:34:56']);
  const isTaken = (name: string) => taken.has(name);

  assert.equal(uniqueWorldName('2026-10-27 12:34:56', isTaken), '2026-10-27 12:34:56 (2)');

  taken.add('2026-10-27 12:34:56 (2)');
  assert.equal(uniqueWorldName('2026-10-27 12:34:56', isTaken), '2026-10-27 12:34:56 (3)');

  // A hole is filled rather than skipped past: (2) was deleted, so it is free.
  taken.delete('2026-10-27 12:34:56 (2)');
  assert.equal(uniqueWorldName('2026-10-27 12:34:56', isTaken), '2026-10-27 12:34:56 (2)');
});

test('a free name is returned unchanged, and the predicate is asked in order', () => {
  assert.equal(uniqueWorldName('2026-10-27 12:34:56', () => false), '2026-10-27 12:34:56');

  // Control: record what was asked. "Returns the base unchanged" is what both a
  // working function and an empty one say, so the calls are the observation that
  // separates them — base first, then the first candidate, and nothing after it.
  const asked: string[] = [];
  const name = uniqueWorldName('2026-10-27 12:34:56', (candidate) => {
    asked.push(candidate);
    return candidate === '2026-10-27 12:34:56';
  });
  assert.equal(name, '2026-10-27 12:34:56 (2)');
  assert.deepEqual(asked, ['2026-10-27 12:34:56', '2026-10-27 12:34:56 (2)']);
});

test('with every candidate taken it gives the base name back, and the prompt decides', () => {
  // Documented rather than asserted-away: the loop is bounded, and the fallback is
  // the overwrite prompt the function exists to avoid. A parser that could not see
  // this would read the returned base name as a successful unique name.
  const asked: string[] = [];
  const name = uniqueWorldName('2026-10-27 12:34:56', (candidate) => {
    asked.push(candidate);
    return true;
  });
  assert.equal(name, '2026-10-27 12:34:56');
  assert.equal(asked.length, 99);   // the base, then (2)..(99)
});
