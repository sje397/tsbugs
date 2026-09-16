/**
 * The web view of the ported simulation.
 *
 * This is a driver, not a second implementation: it imports the same compiled
 * modules the tests and the benchmarks run, so what the page shows is the real
 * VM -- the page cannot drift from the simulation because it does not contain
 * one.
 *
 * The rendering rules are the original's (petriwidget.cpp):
 *
 *   - the world holds *palette indices*, not colours, so the blit is a 256-entry
 *     lookup per cell;
 *   - the image is scaled to the canvas with no interpolation
 *     (Qt::FastTransformation == imageSmoothingEnabled = false);
 *   - hash = x * height + y, so viewCol runs down columns, and the ImageData
 *     consumer is the only thing that cares.
 *
 * step() repaints only the cells it touched, so a frame needs no full-grid pass
 * unless the view mode changed -- setViewMode/setShowByte refresh everything
 * themselves.
 */

import { PetriDish, ViewMode } from '../dist/src/sim/dish.js';
import { DEFAULT_PARAMS, SenseModel, ENERGY_COLOR, POISON_COLOR, MAX_BUG_COLOR, BKG_COLOR } from '../dist/src/sim/params.js';
import { Rng } from '../dist/src/sim/rng.js';
import { fingerprint } from '../dist/src/sim/fingerprint.js';

// ---------------------------------------------------------------- palette
// petriwidget.cpp:10-29, exactly: 0 black, 1..252 a red -> yellow -> green ramp
// (the same ramp the bug colours use), 253 cyan, 254 magenta (poison), 255 blue
// (energy). Cyan is reserved and unused by any view mode, which is upstream's
// state too, so it is kept rather than tidied away.
const rgba = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

const PALETTE = (() => {
  const table = new Uint32Array(256);
  for (let i = 1; i <= MAX_BUG_COLOR; i++) {
    const f = (i - 1) / 252;
    const r = f <= 0.5 ? 0xff : Math.trunc(0xff * (1 - f) * 2);
    const g = f <= 0.5 ? Math.trunc(0xff * f * 2) : 0xff;
    table[i] = rgba(r, g, 0);
  }
  table[BKG_COLOR] = rgba(0, 0, 0);
  table[253] = rgba(0, 255, 255);
  table[POISON_COLOR] = rgba(255, 0, 255);
  table[ENERGY_COLOR] = rgba(0, 0, 255);
  return table;
})();

// ---------------------------------------------------------------- elements
const $ = (id) => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`no element #${id} -- check the id against index.html`);
  return el;
};
const canvas = $('view');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

/** The frame budget, in ms, for "fill the frame". At the measured 137 us per
 *  tick (240x240, ~100 bugs) this is ~58 ticks; the rest of the 16.7 ms frame
 *  is left for the blit and the browser. */
const BUDGET_MS = 8;

// ---------------------------------------------------------------- world
let dish;
let off;          // offscreen canvas at world resolution
let offCtx;
let imageData;
let image32;
let running = true;
let ups = 0;
let lastTime = 0;
let lastMs = performance.now();

function buildWorld() {
  const size = Number($('size').value);
  const seed = Number($('seed').value);
  const roughness = Number($('roughness').value);
  const senseModel = $('senses').value === 'AS_SHIPPED' ? SenseModel.AS_SHIPPED : SenseModel.SIGHTED;

  dish = new PetriDish({ ...DEFAULT_PARAMS, width: size, height: size, senseModel }, new Rng(seed));
  // Roughness 0 is upstream's start: every cell flat at TERRAIN_FLAT. Anything
  // else seeds rolling ground from its own stream so the simulation's draws are
  // unaffected by it.
  if (roughness > 0) dish.seedTerrain(roughness, new Rng(seed + 1));

  off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  offCtx = off.getContext('2d');
  imageData = offCtx.createImageData(size, size);
  image32 = new Uint32Array(imageData.data.buffer);

  // Keep world pixels square and the canvas a whole multiple of the world.
  const scale = Math.max(1, Math.trunc(720 / size));
  canvas.width = size * scale;
  canvas.height = size * scale;
  ctx.imageSmoothingEnabled = false;

  applyViewMode();
  draw();
  stats(performance.now(), true);
}

/** viewCol -> canvas. One lookup per cell, then one scaled blit. */
function draw() {
  const vc = dish.viewCol;
  for (let i = 0; i < vc.length; i++) image32[i] = PALETTE[vc[i]];
  offCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

function applyViewMode() {
  const mode = Number(document.querySelector('input[name=mode]:checked').value);
  dish.setViewMode(mode);
  dish.setShowByte(Number($('showByte').value));
}

// ---------------------------------------------------------------- controls
const MODES = [
  ['Default', ViewMode.DEFAULT],
  ['Bugs only', ViewMode.BUGS],
  ['Bug energy', ViewMode.ENERGY],
  ['Age', ViewMode.AGE],
  ['DNA size', ViewMode.DNA_SIZE],
  ['DNA value', ViewMode.DNA_VALUE],
  ['Terrain', ViewMode.TERRAIN],
];

$('modes').innerHTML = MODES.map(([label, value], i) =>
  `<label><input type="radio" name="mode" value="${value}"${i === 0 ? ' checked' : ''}>${label}</label>`,
).join('');

for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => { applyViewMode(); draw(); });
}
$('showByte').addEventListener('change', () => { applyViewMode(); draw(); });
$('speed').addEventListener('input', () => { $('speedVal').textContent = $('speed').value; });
$('roughness').addEventListener('input', () => { $('roughVal').textContent = $('roughness').value; });
$('new').addEventListener('click', buildWorld);
$('step').addEventListener('click', () => { running = false; $('run').textContent = 'Run'; dish.step(); draw(); stats(performance.now(), true); });
$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Stop' : 'Run';
});

// ---------------------------------------------------------------- stats
/** main_window.cpp:85-112: throttled to 500 ms, UPS an EMA weighted 4/5 old. */
function stats(now, force = false) {
  if (!force && now - lastMs < 500) return;
  const t = dish.time;
  const rate = t === lastTime ? 0 : ((t - lastTime) / (now - lastMs)) * 1000;
  lastTime = t;
  lastMs = now;
  ups = Math.max(0, (4 * ups) / 5 + rate / 5);

  $('ups').textContent = `${ups.toFixed(2)}/s`;
  $('sTime').textContent = String(dish.time);
  $('sPop').textContent = String(dish.population);
  $('sGen').textContent = String(dish.maxGen);
  $('sTotal').textContent = String(dish.totalEnergy);
  $('sBug').textContent = String(dish.bugEnergy);
  $('sCell').textContent = String(dish.energyEnergy);
  $('sRest').textContent = String(Math.max(0, dish.totalEnergy - dish.bugEnergy - dish.energyEnergy));
  $('sBD').textContent = `${dish.births} / ${dish.deaths}`;
}

// ---------------------------------------------------------------- loop
function frame(now) {
  requestAnimationFrame(frame);
  if (running) {
    if ($('budget').checked) {
      const until = performance.now() + BUDGET_MS;
      while (performance.now() < until) dish.step();
    } else {
      const n = Number($('speed').value);
      for (let i = 0; i < n; i++) dish.step();
    }
    draw();
  }
  stats(now);
}

// A handle for tests and for driving the page from outside: this is how the
// in-browser run is checked against the same seed under Node.
window.__tsbugs = {
  dish: () => dish,
  view: ViewMode,
  stop() { running = false; $('run').textContent = 'Run'; },
  /** Rebuild from the control values, so a check starts from a stated world
   *  rather than from however far the page happened to have run. */
  newWorld() { running = false; $('run').textContent = 'Run'; buildWorld(); return fingerprint(dish); },
  step(n = 1) { for (let i = 0; i < n; i++) dish.step(); draw(); return this.hash(); },
  /** Shared with Node, so a browser run and a headless run are comparable. */
  hash() {
    return fingerprint(dish);
  },
  /**
   * What a tick and a blit cost here, in this browser, on this machine. Reported
   * rather than assumed: the page is only usable if a frame's work fits in a
   * frame, and that is a measurement, not a property of the code.
   */
  bench(ticks = 2000, draws = 200) {
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) dish.step();
    const tickMs = (performance.now() - t0) / ticks;
    const d0 = performance.now();
    for (let i = 0; i < draws; i++) draw();
    const drawMs = (performance.now() - d0) / draws;
    return {
      ticksPerSecond: 1000 / tickMs,
      msPerTick: tickMs,
      msPerDraw: drawMs,
      population: dish.population,
      cells: dish.viewCol.length,
    };
  },
};

buildWorld();
requestAnimationFrame(frame);
