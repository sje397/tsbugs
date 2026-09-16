/**
 * Where new bugs and new energy are placed.
 *
 * Ported from petri_dish.cpp:347 `get_coords()`, a free function that takes x
 * and y by reference and draws from the global RNG.
 *
 * The integer/float mixing below is deliberate and load-bearing: `width / 2`
 * is integer division in the original, and only the `r * sin(a)` term is
 * floating point, with the whole sum truncated by an `(int)` cast. Writing
 * `width / 2 + r * Math.sin(a)` in JavaScript would use a float division and
 * change where every bug lands on oddly-sized worlds.
 *
 * DRAW ORDER MATTERS. Each branch draws in a fixed order — angle, radius, then
 * any selector — and the RNG is a single stream, so reordering these calls
 * changes every subsequent draw in the simulation.
 */

import { EnergyLayout } from './params.js';
import type { RandomSource } from './rng.js';

/** Two pi. The original's own M_PI literal rounds to the same double as Math.PI. */
const TWO_PI = Math.PI * 2;

/** C integer division, truncating toward zero. */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** A single output slot pair, reused for every call so placement allocates nothing. */
export class CoordPicker {
  x = 0;
  y = 0;

  pick(layout: EnergyLayout, width: number, height: number, time: number, rng: RandomSource): void {
    switch (layout) {
      case EnergyLayout.RANDOM: {
        this.x = rng.int(width);
        this.y = rng.int(height);
        return;
      }

      case EnergyLayout.DOT: {
        const a = TWO_PI * rng.float();
        const r = Math.min(idiv(width, 5), idiv(height, 5)) * Math.sqrt(rng.float());
        this.x = Math.trunc(idiv(width, 2) + r * Math.sin(a));
        this.y = Math.trunc(idiv(height, 2) + r * Math.cos(a));
        return;
      }

      case EnergyLayout.TWODOTS: {
        // The two dots drift vertically in antiphase, one 2000-tick period.
        const a = TWO_PI * rng.float();
        const r = Math.min(idiv(width, 10), idiv(height, 10)) * Math.sqrt(rng.float());
        const drift = idiv(height, 4) * Math.sin(time / 2000.0);
        if (rng.int(2)) {
          this.x = Math.trunc(idiv(width, 4) + r * Math.sin(a));
          this.y = Math.trunc(idiv(height, 2) + drift + r * Math.cos(a));
        } else {
          this.x = Math.trunc(idiv(width * 3, 4) + r * Math.sin(a));
          this.y = Math.trunc(idiv(height, 2) - drift + r * Math.cos(a));
        }
        return;
      }

      case EnergyLayout.RING: {
        const a = TWO_PI * rng.float();
        const inner = Math.min(idiv(width, 10), idiv(height, 10));
        const r = inner * Math.sqrt(rng.float()) + inner;
        this.x = Math.trunc(idiv(width, 2) + r * Math.sin(a));
        this.y = Math.trunc(idiv(height, 2) + r * Math.cos(a));
        return;
      }

      case EnergyLayout.RECT: {
        this.x = idiv(rng.int(width), 2) + idiv(width, 4);
        this.y = idiv(rng.int(height), 4) + idiv(height * 3, 8);
        return;
      }

      case EnergyLayout.MANYDOTS: {
        // A 4x4 lattice of blobs.
        const a = TWO_PI * rng.float();
        const r = Math.min(idiv(width, 32), idiv(height, 32)) * Math.sqrt(rng.float());
        const d = rng.int(16);
        this.x = Math.trunc(idiv(width, 5) * (idiv(d, 4) + 1) + r * Math.sin(a));
        this.y = Math.trunc(idiv(height, 5) * ((d % 4) + 1) + r * Math.cos(a));
        return;
      }

      case EnergyLayout.CHANGE: {
        // A DOT on odd 2000-tick periods, a fixed two-blob scatter on even.
        if (idiv(time, 2000) % 2) {
          const a = TWO_PI * rng.float();
          const r = Math.min(idiv(width, 5), idiv(height, 5)) * Math.sqrt(rng.float());
          this.x = Math.trunc(idiv(width, 2) + r * Math.sin(a));
          this.y = Math.trunc(idiv(height, 2) + r * Math.cos(a));
        } else {
          const a = TWO_PI * rng.float();
          const r = Math.min(idiv(width, 10), idiv(height, 10)) * Math.sqrt(rng.float());
          if (rng.int(2)) {
            this.x = Math.trunc(idiv(width, 4) + r * Math.sin(a));
            this.y = Math.trunc(idiv(height, 2) + r * Math.cos(a));
          } else {
            this.x = Math.trunc(idiv(width * 3, 4) + r * Math.sin(a));
            this.y = Math.trunc(idiv(height, 2) + r * Math.cos(a));
          }
        }
        return;
      }
    }
  }
}
