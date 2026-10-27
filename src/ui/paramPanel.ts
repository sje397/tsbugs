/**
 * What the web page offers for a world's parameters, and how it has to describe
 * them.
 *
 * This is deliberately model-facing rather than DOM code: the page renders it,
 * Node tests it, and neither has to trust the other. Upstream's Settings dialog
 * is the reason the distinction exists at all. It rebuilt a `WorldParams` from
 * its fields and called `set_world_params()`, which copied the struct and did
 * nothing else — so a field the step phase happened to read took effect, and a
 * field consumed at construction (the size, the poison scatter) silently did
 * nothing, with the dialog offering both kinds and no way to tell them apart.
 *
 * The page therefore does not declare which kind a field is. It asks: offering
 * the model a field its own current value changes nothing, so `setParams` can be
 * used as a read-only query, and the returned ParamUpdate says which group the
 * field belongs to. `discoverGroups` is that query. If a field ever moves between
 * the sets in dish.ts, the panel's labels follow it without an edit here — and
 * `test/paramPanel.test.ts` pins the groups so a move has to be deliberate.
 *
 * `kill_on_edge` is a bool read per tick, so it is live like the rest.
 */

import { DEFAULT_PARAMS, EnergyLayout } from '../sim/params.js';
import type { WorldParams } from '../sim/params.js';
import type { ParamUpdate } from '../sim/dish.js';

/** What a control must say about itself. See dish.ts ParamUpdate. */
export type ParamGroup = 'live' | 'nextGeneration' | 'newWorldOnly';

export const GROUP_ORDER: readonly ParamGroup[] = ['live', 'nextGeneration', 'newWorldOnly'];

export const GROUP_NOTES: Readonly<Record<ParamGroup, string>> = {
  live: 'read by the tick — a change applies immediately',
  nextGeneration: 'copied into each bug at construction — reaches bugs born after the change',
  newWorldOnly: 'sized or dealt when the world is built — rebuild the world to change it',
};

export const GROUP_TITLES: Readonly<Record<ParamGroup, string>> = {
  live: 'live',
  nextGeneration: 'next generation',
  newWorldOnly: 'new world only',
};

/**
 * Fields the panel does not offer, because another control owns them: the world
 * panel's New World form sets all three. One control per field.
 *
 * `poison` is there for the same reason the size is. Both are dealt when the world
 * is built, and this panel is a view of a running world: it can offer those fields
 * a value the running world will not adopt, and the honest report is `ignored`,
 * which reads on screen as "rebuild to apply". That reading was false while the
 * field lived here — New World rebuilt from the preset and dropped the edit — so
 * the field moved to the form that actually deals it, beside the size and the seed.
 * See `REBUILD_ONLY` in dish.ts for the model's half of the same list.
 *
 * A field that is neither offered nor listed here is a field the page has
 * silently stopped showing, which `missingFields` reports and a test fails on.
 */
export const NO_PANEL_CONTROL: ReadonlySet<string> = new Set(['width', 'height', 'poison']);

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  minData: 'min DNA size',
  maxData: 'max DNA size',
  maxAge: 'max age',
  childEnergy: 'child energy',
  minEnergy: 'min bug energy',
  maxEnergy: 'max bug energy',
  minEEnergy: 'min cell energy',
  maxEEnergy: 'max cell energy',
  moveEnergy: 'move energy',
  stayEnergy: 'stay energy',
  totalEnergy: 'world energy',
  minBugEnergy: 'min bug energy total',
  minEnergyEnergy: 'min cell energy total',
  width: 'width',
  height: 'height',
  stepsPerUpdate: 'VM steps/update',
  stackSize: 'VM stack size',
  mutation: 'mutation rate',
  poison: 'poison cells',
  energyLayout: 'energy layout',
  killOnEdge: 'kill on edge',
};

/** settings.cpp:30-36 — the item order is the enum, so index == value. */
export const ENERGY_LAYOUTS: ReadonlyArray<readonly [string, EnergyLayout]> = [
  ['Random', EnergyLayout.RANDOM],
  ['Dot', EnergyLayout.DOT],
  ['Two dots', EnergyLayout.TWODOTS],
  ['Ring', EnergyLayout.RING],
  ['Rectangle', EnergyLayout.RECT],
  ['Many dots', EnergyLayout.MANYDOTS],
  ['Change (dot / two dots)', EnergyLayout.CHANGE],
];

/**
 * The label for a field, falling back to its own name so a newly added parameter
 * appears on the page immediately and reads as a raw key rather than vanishing.
 */
export function label(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/** The fields the panel offers, in WorldParams order. */
export function panelFields(params: WorldParams = DEFAULT_PARAMS): string[] {
  return Object.keys(params).filter((key) => !NO_PANEL_CONTROL.has(key));
}

/** Offered fields with no label and no exclusion from the panel. */
export function missingFields(params: WorldParams = DEFAULT_PARAMS): string[] {
  return Object.keys(params).filter((key) => !NO_PANEL_CONTROL.has(key) && FIELD_LABELS[key] === undefined);
}

/** The part of a world this needs: reading its params, and offering it a change. */
export interface ParamsTarget {
  readonly worldParams: Readonly<WorldParams>;
  setParams(next: Partial<WorldParams>): ParamUpdate;
}

/**
 * Which group each field belongs to, discovered from the model.
 *
 * Every call here offers a field its own current value, so the world is
 * unchanged; the test asserts that with a fingerprint rather than taking this
 * comment's word for it.
 */
export function discoverGroups(target: ParamsTarget): Map<string, ParamGroup> {
  const current = target.worldParams;
  const groups = new Map<string, ParamGroup>();

  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const update = target.setParams({ [key]: current[key as keyof WorldParams] });
    const where: ParamGroup = update.applied.includes(key)
      ? 'live'
      : update.deferred.includes(key)
        ? 'nextGeneration'
        : 'newWorldOnly';
    groups.set(key, where);
  }

  return groups;
}
