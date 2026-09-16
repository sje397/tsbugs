/**
 * The parameter panel's model-facing half.
 *
 * The page is allowed to have opinions about layout; it is not allowed to have
 * opinions about what a parameter does. These tests are the two halves of that:
 * the panel must offer every field (or say why not), and the group a control is
 * placed in must be the group the simulation actually puts the field in — read
 * back from setParams rather than restated by the page.
 *
 * The groups are pinned here by hand, which makes this a change detector on
 * purpose: moving a field between the live path and construction time changes
 * what users are told, so it should have to break a test that says so out loud.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PARAMS,
  EnergyLayout,
  type WorldParams,
} from '../src/sim/params.js';
import { PetriDish } from '../src/sim/dish.js';
import { Rng } from '../src/sim/rng.js';
import { fingerprint } from '../src/sim/fingerprint.js';
import {
  ENERGY_LAYOUTS,
  FIELD_LABELS,
  GROUP_ORDER,
  NO_PANEL_CONTROL,
  discoverGroups,
  label,
  missingFields,
  panelFields,
} from '../src/ui/paramPanel.js';

function world(seed = 2024, params: Partial<WorldParams> = {}): PetriDish {
  return new PetriDish({ ...DEFAULT_PARAMS, ...params }, new Rng(seed));
}

test('every parameter is offered, or deliberately left to another control', () => {
  const fields = panelFields();
  const missing = missingFields();

  assert.deepEqual(missing, [], 'a parameter with no control and no exclusion is one the page silently dropped');
  assert.deepEqual(
    [...NO_PANEL_CONTROL],
    ['width', 'height'],
    'the exclusions are the size select; adding another is a decision that should have to be written here',
  );

  const all = Object.keys(DEFAULT_PARAMS);
  assert.deepEqual([...fields].sort(), all.filter((k) => !NO_PANEL_CONTROL.has(k)).sort());
  assert.equal(new Set(fields).size, fields.length, 'a field offered twice is a field with two controls that can disagree');
});

test('every offered parameter has a label, and no label outlives its field', () => {
  for (const key of panelFields()) {
    assert.notEqual(label(key), key, `${key} has no label of its own — it would show as a raw camelCase key`);
    assert.notEqual(label(key).trim(), '');
  }

  const stale = Object.keys(FIELD_LABELS).filter((key) => !(key in DEFAULT_PARAMS));
  assert.deepEqual(stale, [], 'a label for a parameter that no longer exists is a control the page thinks it has');
});

test('a field with no label falls back to its own name rather than to nothing', () => {
  assert.equal(label('someFutureKnob'), 'someFutureKnob');
});

test('the energy layouts are the enum, in the order settings.cpp lists them', () => {
  assert.deepEqual(
    ENERGY_LAYOUTS.map(([, value]) => value),
    [0, 1, 2, 3, 4, 5, 6],
    'the combo index is the saved value, so the order is load-bearing',
  );
  assert.equal(ENERGY_LAYOUTS.length, Object.keys(EnergyLayout).length / 2, 'every layout needs a label');
});

test('the group a control is placed in is the group the model puts the field in', () => {
  const dish = world();
  const groups = discoverGroups(dish);

  // Written out independently of dish.ts's PER_BUG/REBUILD_ONLY sets, so a field
  // moving between them fails here rather than silently relabelling the page.
  const expected: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) expected[key] = 'live';
  expected.width = 'newWorldOnly';
  expected.height = 'newWorldOnly';
  expected.poison = 'newWorldOnly';
  expected.stepsPerUpdate = 'nextGeneration';
  expected.stackSize = 'nextGeneration';
  expected.mutation = 'nextGeneration';

  for (const [key, where] of Object.entries(expected)) {
    assert.equal(groups.get(key), where, `${key} is reported as ${groups.get(key)} but the model treats it as ${where}`);
  }

  for (const where of groups.values()) {
    assert.ok(GROUP_ORDER.includes(where as never), `${where} is not a group the page knows how to render`);
  }
});

test('discovering the groups does not change the world', () => {
  const dish = world();
  for (let i = 0; i < 60; i++) dish.step();

  const before = fingerprint(dish);
  const params = dish.worldParams;
  discoverGroups(dish);

  assert.equal(fingerprint(dish), before, 'the query offered each field its own value, so nothing may have moved');
  assert.deepEqual(dish.worldParams, params, 'and the struct it reports must be the one it started with');
});

test('a discovered group for a field whose change would be refused is still reported', () => {
  // setParams is atomic and its refusal names a range, but discovery offers each
  // field its own current value inside its own call, so a valid world can never
  // refuse one. If that ever stops being true the panel would mislabel a control,
  // so it is asserted rather than assumed.
  const dish = world(7);
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const update = dish.setParams({ [key]: dish.worldParams[key as keyof WorldParams] });
    assert.deepEqual(update.refused, [], `${key} was refused when offered its own value`);
    assert.equal(update.applied.length + update.deferred.length + update.ignored.length, 1);
  }
});
