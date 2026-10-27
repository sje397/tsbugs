/**
 * Starting points for a new world.
 *
 * The page used to open on `DEFAULT_PARAMS`, which is the original program's own
 * default, and that is 50% mutation — half of every birth is a mutated copy. As a
 * default that is a poor first impression and a worse teaching tool: a lineage
 * that keeps a useful instruction has one chance in two of handing it on intact,
 * so the population churns and nothing accumulates. The dial is not wrong, it is
 * the shipped value; it is just not the value to hand someone who has never seen
 * this model before.
 *
 * So the defaults are named rather than implied. `upstream` is `DEFAULT_PARAMS`
 * exactly — same values, same 240x240 world — and a test asserts that equality,
 * so it cannot drift as the model gains fields. The rest are a dial or three away
 * from it, described by what they *are* rather than by what they will produce: a
 * claim like "converges faster" is a prediction about a simulation with a random
 * energy field in it, and the honest version of that claim is the number on the
 * dial.
 *
 * A preset is a seed for the New World form, not a mode. Once the world exists
 * the panel edits the world, and nothing here is consulted again — which is why a
 * loaded world cannot be described as "a gentle world" by accident.
 */

import { DEFAULT_PARAMS, EnergyLayout } from '../sim/params.js';
import type { WorldParams } from '../sim/params.js';

export interface WorldPreset {
  /** Stable id: used in the select's value and by saved-form round trips. */
  id: string;
  name: string;
  /** What the dials are. Not what the world will do. */
  description: string;
  /** Fields this preset sets; everything else comes from DEFAULT_PARAMS. */
  params: Partial<WorldParams>;
}

/** Fields a preset may not change: the world's size is its own control. */
export const PRESET_FORBIDDEN: ReadonlySet<string> = new Set(['width', 'height']);

export const PRESETS: readonly WorldPreset[] = [
  {
    id: 'gentle',
    name: 'Gentle',
    description: 'mutation 5% — one birth in twenty is a mutated copy, so a useful program survives long enough to be inherited',
    params: { mutation: 0.05 },
  },
  {
    id: 'upstream',
    name: 'Upstream',
    description: 'the original program\'s defaults — mutation 50%, a mutated copy at every second birth',
    params: {},
  },
  {
    id: 'storm',
    name: 'Mutation storm',
    description: 'mutation 35% and a 64-byte stack — programs are rewritten faster than selection can settle them',
    params: { mutation: 0.35 },
  },
  {
    id: 'slow',
    name: 'Slow burn',
    description: 'mutation 1% and 256 VM steps per update — near-clonal lineages doing more work each tick',
    params: { mutation: 0.01, stepsPerUpdate: 256 },
  },
  {
    id: 'garden',
    name: 'Poison garden',
    description: 'poison 40 and energy in stripes rather than dots — terrain a program has to route around',
    params: { poison: 40, energyLayout: EnergyLayout.RANDOM },
  },
];

export const DEFAULT_PRESET_ID = 'gentle';

export function presetById(id: string): WorldPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * The full parameter set a preset implies: the model's defaults, overridden by
 * the preset's own dials.
 *
 * Returned as a fresh object: `DEFAULT_PARAMS` is a shared constant, and a panel
 * that wrote through it would change the default for every later world.
 */
export function presetParams(id: string): WorldParams {
  const preset = presetById(id) ?? presetById(DEFAULT_PRESET_ID);
  return { ...DEFAULT_PARAMS, ...(preset?.params ?? {}) };
}
