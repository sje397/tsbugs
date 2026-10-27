/**
 * The presets, and the two ways a preset can be wrong without anyone noticing.
 *
 * A mistyped parameter name is the first: it is not type-checked through
 * `Partial<WorldParams>` when the key is spelled in a string, and a preset that
 * asks for `mutationRate` would look applied, report nothing, and start a world
 * at the default. The second is drift — `upstream` is a claim about the original
 * program, and the only thing that keeps that claim true as the model gains
 * fields is an equality asserted against `DEFAULT_PARAMS` itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRESET_ID, PRESETS, PRESET_FORBIDDEN, presetById, presetParams } from '../src/ui/presets.js';
import { DEFAULT_PARAMS, EnergyLayout } from '../src/sim/params.js';

const paramKeys = new Set(Object.keys(DEFAULT_PARAMS));

test('every preset names only real parameters', () => {
  for (const preset of PRESETS) {
    for (const key of Object.keys(preset.params)) {
      assert.ok(paramKeys.has(key), `preset "${preset.id}" sets "${key}", which is not a world parameter`);
    }
  }
});

test('a preset cannot resize the world', () => {
  // Size is the World panel's own control; a preset that set it would be a second
  // control for one field, and the select would then disagree with the world.
  for (const preset of PRESETS) {
    for (const key of Object.keys(preset.params)) {
      assert.ok(!PRESET_FORBIDDEN.has(key), `preset "${preset.id}" sets ${key}`);
    }
  }
});

test('upstream is the model default, exactly', () => {
  const upstream = presetById('upstream');
  assert.ok(upstream);
  assert.deepEqual(upstream.params, {}, 'upstream must carry no overrides');
  assert.deepEqual(presetParams('upstream'), DEFAULT_PARAMS);
  // Stated directly, because this is the claim the preset's name makes.
  assert.equal(presetParams('upstream').mutation, 0.5);
});

test('the page does not open on 50% mutation', () => {
  const start = presetParams(DEFAULT_PRESET_ID);
  assert.equal(presetById(DEFAULT_PRESET_ID)?.id, 'twodots');
  assert.ok(start.mutation < 0.1, `the default world starts at mutation ${start.mutation}`);
  assert.equal(start.mutation, 0.05);
});

test('the default world puts the energy in two blobs', () => {
  // A default is a claim about where someone starts, and the layout is the half of
  // it that regresses silently: a preset that named the wrong field would still
  // start a world, still run, and still look like a petri dish.
  const start = presetParams(DEFAULT_PRESET_ID);
  assert.equal(start.energyLayout, EnergyLayout.TWODOTS);
  assert.notEqual(start.energyLayout, DEFAULT_PARAMS.energyLayout, 'the default must differ from upstream here');
});

test('ids are unique and every preset explains itself', () => {
  const seen = new Set<string>();
  for (const preset of PRESETS) {
    assert.ok(preset.id.length > 0);
    assert.ok(!seen.has(preset.id), `duplicate preset id "${preset.id}"`);
    seen.add(preset.id);
    assert.ok(preset.name.length > 0, `preset "${preset.id}" has no name`);
    assert.ok(preset.description.length > 20, `preset "${preset.id}" has no real description`);
  }
});

test('an unknown id falls back to the default rather than to nothing', () => {
  // A saved form or a stale bookmark can name a preset that no longer exists; the
  // world must still start, and it must start somewhere deliberate.
  assert.deepEqual(presetParams('no-such-preset'), presetParams(DEFAULT_PRESET_ID));
  assert.equal(presetById('no-such-preset'), undefined);
});

test('preset parameters are copies, not the shared defaults', () => {
  const a = presetParams('gentle');
  a.mutation = 0.9;
  assert.equal(presetParams('gentle').mutation, 0.05);
  assert.equal(DEFAULT_PARAMS.mutation, 0.5, 'DEFAULT_PARAMS must never be written through');
});
