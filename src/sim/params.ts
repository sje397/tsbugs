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
};

/** petri_dish.cpp:158-161 — the reserved view-colour values. */
export const ENERGY_COLOR = 255;
export const POISON_COLOR = 254;
export const MAX_BUG_COLOR = 252;
export const BKG_COLOR = 0;
