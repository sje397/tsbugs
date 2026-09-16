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
 * The reading the VM's terrain sense channel (input slots 9-17) now carries,
 * everywhere, forever.
 *
 * The world has no terrain: it is flat, and nothing can change it. Flat ground
 * encoded as the two's-complement byte upstream's `signed char` channel used, so
 * the channel reads 1 at every cell. The channel itself is kept because the
 * 27-slot input layout is the genome's contract — a program's every branch is
 * written against it — and deleting nine slots would change what every genome
 * means rather than what the world contains.
 */
export const TERRAIN_SENSE = 1;

/** petri_dish.cpp:158-161 — the reserved view-colour values. */
export const ENERGY_COLOR = 255;
export const POISON_COLOR = 254;
export const MAX_BUG_COLOR = 252;
export const BKG_COLOR = 0;
