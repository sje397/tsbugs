import type { PetriDish } from './dish.js';

/**
 * FNV-1a over a world's rendered indices and the counters a run must reproduce.
 *
 * Two things use it, and it exists for the first: comparing runs *across
 * environments*. The browser page imports the same compiled module the tests do,
 * and a fingerprint is what turns "the page looks right" into "the page and Node
 * agree on all 57,600 indices and every counter after N ticks".
 *
 * The second use is a regression pin -- a test that fails if a change moves
 * behaviour nothing asked to move. Be clear about what that does NOT prove: the
 * expected value is this port's own output, not upstream's, so a fingerprint
 * test cannot tell a correct simulation from a consistently wrong one. It
 * catches drift, not error.
 *
 * `viewCol` is view-mode dependent, so a fingerprint is only comparable between
 * worlds in the same mode, and callers use the default.
 */
export function fingerprint(dish: PetriDish): number {
  let h = 0x811c9dc5;
  const vc = dish.viewCol;
  for (let i = 0; i < vc.length; i++) {
    h ^= vc[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const counters = [
    dish.time, dish.population, dish.maxGen, dish.births, dish.deaths,
    dish.bugEnergy, dish.energyEnergy,
  ];
  for (const value of counters) {
    h ^= value;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
