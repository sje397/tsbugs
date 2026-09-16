/**
 * World parameters.
 *
 * Ported from world_params.h / world_params.cpp. The C++ field names are noted
 * on each member so the mapping stays auditable against the original.
 */

/**
 * world_params.h: `typedef enum {EL_RANDOM, ...}` — order is load-bearing,
 * because the saved value is the ordinal.
 */
export enum EnergyLayout {
  RANDOM = 0,
  DOT = 1,
  TWODOTS = 2,
  RING = 3,
  RECT = 4,
  MANYDOTS = 5,
  CHANGE = 6,
}

/**
 * Which sensory model the VM sees.
 *
 * SIGHTED    — what the code in petri_dish.cpp means to do.
 * AS_SHIPPED — what the 2013 release actually did.
 *
 * The original passed the terrain output array where the energy output was
 * expected, so `en` was never written and `ter` held a flat copy of the energy
 * grid. At -O3 (QtBugs.pro:12) the uninitialised `en` reads resolved to a
 * stable zero, so this reproduces the shipped build rather than the undefined
 * behaviour: `ter` = energy (uniform across the 3x3 window), `en` = all zeros.
 */
export enum SenseModel {
  SIGHTED = 'sighted',
  AS_SHIPPED = 'as-shipped',
}

export interface WorldParams {
  /** min_data */
  minData: number;
  /** max_data */
  maxData: number;
  /** max_age */
  maxAge: number;
  /** child_energy */
  childEnergy: number;
  /** min_energy */
  minEnergy: number;
  /** max_energy */
  maxEnergy: number;
  /** min_e_energy */
  minEEnergy: number;
  /** max_e_energy */
  maxEEnergy: number;
  /** move_energy */
  moveEnergy: number;
  /** stay_energy */
  stayEnergy: number;
  /** total_energy */
  totalEnergy: number;
  /** min_bug_energy */
  minBugEnergy: number;
  /** min_energy_energy */
  minEnergyEnergy: number;
  /** pd_width */
  width: number;
  /** pd_height */
  height: number;
  /** steps_per_update */
  stepsPerUpdate: number;
  /** stack_size */
  stackSize: number;
  /** mutation */
  mutation: number;
  /** poison — number of poisoned cells to scatter */
  poison: number;
  /** energy_layout */
  energyLayout: EnergyLayout;
  /** kill_on_edge */
  killOnEdge: boolean;
  /**
   * Not in the original. Selects between the intended senses and the shipped
   * ones so the two can be observed side by side.
   */
  senseModel: SenseModel;
}

/** Exactly the defaults from WorldParams::WorldParams(). */
export const DEFAULT_PARAMS: WorldParams = {
  minData: 4096,
  maxData: 8192,
  maxAge: 6000,
  childEnergy: 160,
  minEnergy: 20,
  maxEnergy: 800,
  minEEnergy: 10,
  maxEEnergy: 80,
  moveEnergy: 2,
  stayEnergy: 1,
  totalEnergy: 120000,
  minBugEnergy: 40000,
  minEnergyEnergy: 76000,
  width: 240,
  height: 240,
  stepsPerUpdate: 64,
  stackSize: 64,
  mutation: 0.5,
  poison: 5,
  energyLayout: EnergyLayout.DOT,
  killOnEdge: true,
  senseModel: SenseModel.SIGHTED,
};

/**
 * Elevation is a signed byte, so the bounds are the type's.
 *
 * Upstream's terrain was an unbounded int with flat ground at 1 and a nominal
 * ceiling of MAX_TERRAIN = 10 (petri_dish.cpp:13) used both as the deposit guard
 * and as the divisor of the terrain view. The ceiling was already being broken
 * from removeBug(), which deposits a dying bug's payload with no check, and the
 * floor at 0 meant digging could only ever flatten the world — a hole was the
 * absence of ground, not a feature of it. The negative half of the type was
 * therefore never reachable, so `abs(terrain) < MAX_TERRAIN` was really a
 * ceiling test wearing a magnitude test's clothes.
 *
 * TERRAIN_FLAT stays at 1: the initial world is unchanged, and only the range
 * below it is new. See DIVERGENCES.md §8, "terrain stores and renders a signed
 * elevation".
 */
export const TERRAIN_MIN = -127;
export const TERRAIN_MAX = 127;
export const TERRAIN_FLAT = 1;

/**
 * How much elevation one traverse of the render ramp covers — and the number
 * upstream's terrain view divided by (MAX_TERRAIN = 10, petri_dish.cpp:13).
 *
 * Upstream used that one number for two jobs, and only one of them survives
 * contact with a signed type: as a *deposit guard* it was never true (see above),
 * but as the *scale of the terrain view* it is exactly right, because it names
 * how much relief the authors expected a world to have and therefore how much
 * relief the ramp should resolve.
 *
 * The port initially dropped it and mapped the type's full ±127 instead, which
 * gives one palette index per unit of elevation. That is ~13x less contrast than
 * upstream's own view, and it is why seeded ground rendered as a near-uniform
 * yellow field: a roughness-20 world's relief of -11..+14 lands inside palette
 * indices 116..141 of 252. See DIVERGENCES.md §8.
 */
export const TERRAIN_RAMP_SCALE = 10;

/** petri_dish.cpp:158-161 — the reserved view-colour values. */
export const ENERGY_COLOR = 255;
export const POISON_COLOR = 254;
export const MAX_BUG_COLOR = 252;
export const BKG_COLOR = 0;
