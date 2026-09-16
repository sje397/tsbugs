/**
 * What the landscape does over time.
 *
 * Terrain is a signed byte now (-127..+127, flat at 1), but a range is not the
 * same thing as a reachable range: a bug that digs is left carrying the payload
 * it dug up, and cannot dig again until it puts it down — and putting it down
 * raises the ground back. So whether the world ever actually gets *below* flat
 * ground is an empirical question about the population's behaviour, not
 * something the type declaration answers, and the same goes for whether a
 * seeded landscape survives contact with the bugs.
 *
 * satL/satH are the cells whose rendered palette index has already hit the end
 * of the ramp — ground the terrain view cannot distinguish from its neighbours.
 *
 * Run:  node dist/tools/terrain-probe.mjs [steps] [seed] [roughness]
 *   roughness 0 (default) starts flat, as upstream does; anything else seeds
 *   rolling ground through PetriDish.seedTerrain before the run.
 */

import { PetriDish, terrainColor } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, SenseModel, TERRAIN_FLAT, TERRAIN_MAX, TERRAIN_MIN } from '../src/sim/params.js';

/**
 * The palette indices the ramp's ends land on, derived rather than assumed, so
 * the saturation columns below keep meaning something if the scale is retuned.
 */
const RAMP_LOW = terrainColor(TERRAIN_MIN);
const RAMP_HIGH = terrainColor(TERRAIN_MAX);
import { Rng } from '../src/sim/rng.js';

const steps = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 2024);
const roughness = Number(process.argv[4] ?? 0);
const CELLS = DEFAULT_PARAMS.width * DEFAULT_PARAMS.height;

const pad = (v: number, w: number) => String(v).padStart(w);

function survey(dish: PetriDish): string {
  const counts = new Map<number, number>();
  let min = TERRAIN_FLAT;
  let max = TERRAIN_FLAT;
  let holes = 0;
  let hills = 0;
  // Cells the *view* can no longer tell apart from their neighbours: elevation
  // past the point where the ramp has already saturated. Counting renderings
  // rather than elevations keeps this honest if the ramp scale is retuned.
  let satLo = 0;
  let satHi = 0;

  for (let hash = 0; hash < CELLS; hash++) {
    const e = dish.terrainAt(hash);
    counts.set(e, (counts.get(e) ?? 0) + 1);
    if (e < min) min = e;
    if (e > max) max = e;
    if (e < TERRAIN_FLAT) holes++;
    else if (e > TERRAIN_FLAT) hills++;
    const rendered = terrainColor(e);
    if (rendered === RAMP_LOW) satLo++;
    else if (rendered === RAMP_HIGH) satHi++;
  }

  const spread = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    `${pad(holes, 7)} ${pad(hills, 7)} ${pad(CELLS - holes - hills, 7)} ` +
    `${pad(min, 4)} ${pad(max, 4)} ${pad(satLo, 7)} ${pad(satHi, 7)}   ` +
    spread.map(([e, n]) => `${e}x${n}`).join(' ') +
    (counts.size > spread.length ? ` (+${counts.size - spread.length})` : '')
  );
}

for (const senseModel of [SenseModel.SIGHTED, SenseModel.AS_SHIPPED]) {
  const dish = new PetriDish({ ...DEFAULT_PARAMS, senseModel }, new Rng(seed));
  // Seeded from its own stream so a seeded run and a flat run share the same
  // simulation draws, and the only difference between them is the ground.
  if (roughness > 0) dish.seedTerrain(roughness, new Rng(seed + 1));

  console.log(`\n=== ${senseModel}, seed ${seed}, ${steps} steps, roughness ${roughness} ===`);
  // Column order matches what survey() actually prints: the ups sample is last.
  console.log(
    '  time      pop   gen   holes   hills    flat   min  max    satL    satH   elevations   ups',
  );

  const start = Date.now();
  let lastT = 0;
  let lastMs = start;
  const every = Math.max(1, Math.ceil(steps / 8));

  for (let t = 0; t <= steps; t++) {
    if (t > 0) dish.step();
    if (t % every !== 0 && t !== steps) continue;

    const now = Date.now();
    const ups = t === lastT ? 0 : ((t - lastT) / (now - lastMs)) * 1000;
    lastT = t;
    lastMs = now;

    console.log(
      `${pad(dish.time, 6)}  ${pad(dish.population, 6)} ${pad(dish.maxGen, 5)}   ` +
        `${survey(dish)} ${pad(Math.round(ups), 5)}`,
    );
  }
}
