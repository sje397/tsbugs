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
import { decodeLinear } from '../dist/src/sim/disasm.js';
import { MAX_I } from '../dist/src/sim/processor.js';
import { formatInstruction, hex4, instructionIndexAt, isMidInstruction } from '../dist/src/ui/disasmView.js';
import {
  ENERGY_LAYOUTS, FIELD_LABELS, GROUP_NOTES, GROUP_ORDER, GROUP_TITLES,
  discoverGroups, label, missingFields, panelFields,
} from '../dist/src/ui/paramPanel.js';
import { geneSpread } from '../dist/src/sim/variance.js';
import { barIndex, chartColumns, chartSummary, geneAtColumn } from '../dist/src/ui/varianceChart.js';
import { DEFAULT_PARAMS, ENERGY_COLOR, POISON_COLOR, MAX_BUG_COLOR, BKG_COLOR } from '../dist/src/sim/params.js';
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
let worldSerial = 0;   // bumped by buildWorld; a measurement belongs to exactly one world
let running = true;
let ups = 0;
let lastTime = 0;
let lastMs = performance.now();

function buildWorld() {
  const size = Number($('size').value);
  const seed = Number($('seed').value);
  dish = new PetriDish({ ...DEFAULT_PARAMS, width: size, height: size }, new Rng(seed));

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

  worldSerial++;      // everything measured so far describes the previous world
  watched = null;
  watchedDied = null;
  lastClick = { hash: -1, index: 0 };
  currentDish = null;
  showBugInfo('click a bug in the world');

  applyViewMode();
  renderParams();
  message(`world ${size}x${size}, seed ${seed}`);
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
];

$('modes').innerHTML = MODES.map(([label, value], i) =>
  `<label><input type="radio" name="mode" value="${value}"${i === 0 ? ' checked' : ''}>${label}</label>`,
).join('');

for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => { applyViewMode(); draw(); });
}
$('showByte').addEventListener('change', () => { applyViewMode(); draw(); });
$('speed').addEventListener('input', () => { $('speedVal').textContent = $('speed').value; });
$('new').addEventListener('click', buildWorld);
$('step').addEventListener('click', () => { running = false; $('run').textContent = 'Run'; dish.step(); draw(); stats(performance.now(), true); });
$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Stop' : 'Run';
});

// ---------------------------------------------------------------- parameters
/**
 * The world-parameter panel, built from the model rather than written out here.
 *
 * The field list is the model's own key list, so a new parameter appears without
 * anyone remembering to edit this file; the group each control sits in is
 * discovered by asking setParams (see src/ui/paramPanel.ts), so a control cannot
 * claim to be live when the simulation only reads it at construction time. Every
 * change is followed by renderParams(), which re-reads dish.worldParams — a
 * refused or ignored edit is therefore reverted on screen instead of sitting in
 * an input box claiming to be the world's state.
 *
 * Upstream's dialog applied the whole form at once. Each control here applies
 * itself, which is what makes the per-field reporting meaningful: setParams is
 * atomic, so one bad value in a batch would refuse the entire batch and leave the
 * other edits unexplained.
 */
let groups = new Map();
let currentDish = null;

function renderParams() {
  const host = $('params');
  host.textContent = '';

  const params = dish.worldParams;
  if (currentDish !== dish) {
    groups = discoverGroups(dish);
    currentDish = dish;
  }

  for (const group of GROUP_ORDER) {
    const keys = panelFields(params).filter((key) => groups.get(key) === group);
    if (keys.length === 0) continue;

    const heading = document.createElement('div');
    heading.className = 'group';
    heading.textContent = GROUP_TITLES[group];
    host.append(heading);

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = GROUP_NOTES[group];
    host.append(note);

    for (const key of keys) host.append(paramRow(key, params[key]));
  }
}

function paramRow(key, value) {
  const row = document.createElement('div');
  row.className = 'row';

  const name = document.createElement('span');
  name.textContent = label(key);
  name.title = key;
  row.append(name);

  let control;
  if (key === 'energyLayout') {
    control = document.createElement('select');
    for (const [text, option] of ENERGY_LAYOUTS) {
      const el = document.createElement('option');
      el.value = String(option);
      el.textContent = text;
      control.append(el);
    }
    control.value = String(value);
  } else if (key === 'killOnEdge') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = value === true;
  } else if (key === 'mutation') {
    control = document.createElement('input');
    control.type = 'range';
    control.min = '0';
    control.max = '1';
    control.step = '0.005';
    control.value = String(value);
  } else {
    control = document.createElement('input');
    control.type = 'number';
    control.step = '1';
    // No min/max: upstream's dialog had validators, not ranges, and the
    // simulation is the thing that has to refuse a range it cannot use.
    control.value = String(value);
    control.size = 8;
  }

  control.dataset.key = key;
  control.addEventListener('change', () => applyParam(key, control));

  const cell = document.createElement('span');
  cell.append(control);
  row.append(cell);
  return row;
}

function applyParam(key, control) {
  const raw = control.type === 'checkbox' ? null : String(control.value).trim();
  const value = control.type === 'checkbox'
    ? control.checked
    : key === 'energyLayout' ? Number(control.value) : Number(raw);

  if (control.type !== 'checkbox' && (raw === '' || !Number.isFinite(value))) {
    message(`${label(key)} needs a number — nothing changed`, true);
    renderParams();
    return;
  }

  const update = dish.setParams({ [key]: value });
  const shown = key === 'energyLayout' ? ENERGY_LAYOUTS.find(([, v]) => v === value)?.[0] ?? value : value;

  if (update.refused.length > 0) {
    message(`refused: ${update.refused.join('; ')} — nothing changed`, true);
  } else if (update.ignored.includes(key)) {
    message(`${label(key)} = ${shown}, but only a new world reads it — rebuild to apply`, true);
  } else if (update.deferred.includes(key)) {
    message(`${label(key)} = ${shown}; bugs born from now on are built with it`);
  } else {
    message(`${label(key)} = ${shown} — live on the next tick`);
  }

  renderParams();
  applyViewMode();   // the energy view scales by min/max energy, so refresh it
  draw();
}

function message(text, bad = false, id = 'paramsMsg') {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

// ---------------------------------------------------------------- inspector
/**
 * Click to inspect, the way the original's worldView.clicked -> edit_bug path
 * worked — except that this follows the bug afterwards instead of copying its DNA
 * at click time, so the panel is a live view of an individual VM.
 *
 * The code listing is decodeLinear from address 0: one decode of the genome, in
 * address order, and the instruction ip currently sits in is highlighted. A jump
 * can land in the middle of a byte range this sweep reads as operands — that is
 * real, it is how the machine runs, and the listing says so rather than
 * re-decoding from ip and pretending the stream is contiguous.
 */
const INSPECT_ROWS_BEFORE = 8;
const INSPECT_ROWS_AFTER = 26;

let watched = null;      // the Bug under inspection, or null
let watchedHash = undefined;
let watchedDied = null;  // tick at which it was last seen alive, once it is gone
let lastClick = { hash: -1, index: 0 };

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.min(dish.width - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * dish.width)));
  const y = Math.min(dish.height - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * dish.height)));
  const hash = x * dish.height + y;

  const here = dish.bugsAt(hash);
  if (here.length === 0) {
    watched = null;
    watchedHash = hash;
    watchedDied = null;
    showBugInfo(`no bug on ${x},${y} (tick ${dish.time})`);
    return;
  }

  // Repeated clicks on one cell walk its list, since a cell can hold several and
  // only the first one's colour is drawn.
  const index = lastClick.hash === hash ? (lastClick.index + 1) % here.length : 0;
  lastClick = { hash, index };
  watched = here[index];
  watchedHash = hash;
  watchedDied = null;
  refreshBug();
});

/** Where the watched bug is now, or null once it is gone. */
function locateWatched() {
  if (watched === null) return null;
  let found = null;
  dish.forEachBug((bug, hash) => {
    if (bug === watched) found = hash;
  });
  return found;
}

function showBugInfo(text) {
  const host = $('bug');
  host.textContent = '';
  const p = document.createElement('div');
  p.className = 'dim';
  p.textContent = text;
  host.append(p);
}

function refreshBug() {
  if (watched === null) return;

  const hash = locateWatched();
  if (hash === null) {
    watchedDied ??= dish.time;
    showBugInfo(`this bug is gone — it died around tick ${watchedDied}. Click another.`);
    return;
  }

  const bug = watched;
  const x = Math.trunc(hash / dish.height);
  const y = hash % dish.height;
  const genome = bug.dna.data;
  const state = bug.processor.state;      // ip, sp, bp, accumulator
  const ip = state.ip;
  const listing = decodeLinear(genome);
  const at = instructionIndexAt(listing, ip);

  const host = $('bug');
  host.textContent = '';

  const here = dish.bugsAt(hash).length;
  const facts = [
    ['cell', `${x}, ${y}${here > 1 ? ` (${here} bugs here — click again for the next)` : ''}`],
    ['tick', String(dish.time)],
    ['generation', String(bug.generation)],
    ['age', String(bug.age)],
    ['energy', String(bug.energy)],
    ['children', String(bug.children)],
    ['colour', `${bug.color % 252 + 1}`],
    ['DNA', `${genome.length} bytes`],
    ['mutation', bug.dna.mutationRate.toFixed(3)],
    ['ip', `${ip}${isMidInstruction(listing, at, ip) ? ` (inside the instruction at ${listing[at].address})` : ''}`],
    ['sp / bp', `${state.sp} / ${state.bp}`],
    ['accumulator', String(state.accumulator)],
  ];

  const grid = document.createElement('div');
  grid.className = 'stats';
  for (const [key, value] of facts) {
    const k = document.createElement('span');
    k.textContent = key;
    const v = document.createElement('span');
    v.textContent = value;
    // The colour row carries the swatch the world actually draws, resolved
    // through the same palette table the blit uses.
    if (key === 'colour') {
      const rgb = PALETTE[bug.color % 252 + 1];
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `rgb(${rgb & 0xff}, ${(rgb >> 8) & 0xff}, ${(rgb >> 16) & 0xff})`;
      v.prepend(swatch, document.createTextNode(' '));
    }
    grid.append(k, v);
  }

  host.append(grid);

  const head = document.createElement('div');
  head.className = 'note';
  head.textContent = at < 0
    ? `${listing.length} instructions decoded from address 0`
    : `${listing.length} instructions decoded from address 0 — showing around ip`;
  host.append(head);

  const from = Math.max(0, (at < 0 ? 0 : at) - INSPECT_ROWS_BEFORE);
  const to = Math.min(listing.length, (at < 0 ? 0 : at) + INSPECT_ROWS_AFTER);

  const dis = document.createElement('div');
  dis.id = 'dis';
  if (from > 0) dis.append(disRow('...', `${from} earlier instructions`, false));
  for (let i = from; i < to; i++) {
    const ins = listing[i];
    dis.append(disRow(hex4(ins.address), formatInstruction(ins, MAX_I), i === at, isMidInstruction(listing, i, ip)));
  }
  if (to < listing.length) dis.append(disRow('...', `${listing.length - to} more instructions`, false));
  host.append(dis);

  const tail = document.createElement('div');
  tail.className = 'note';
  tail.textContent = `VM steps/update ${bug.processor.stepsPerUpdate}, stack ${dish.worldParams.stackSize} bytes` +
    ` — a stored byte above ${MAX_I - 1} runs as its modulo`;
  host.append(tail);
}

function disRow(address, text, current, midInstruction) {
  const row = document.createElement('div');
  if (current) row.className = midInstruction ? 'mid' : 'cur';
  row.textContent = `${current ? (midInstruction ? '~' : '>') : ' '} ${address}  ${text}`;
  return row;
}

// ---------------------------------------------------------------- gene chart
/**
 * The population's per-gene spread -- upstream's "Show Variance" dialog, which
 * painted this same figure as bars on a 500 ms timer and said nothing about it.
 *
 * Two things the dialog could not do. It says what the measurement cost
 * (maxData x population; 2.34 ms at 8192 x 77 measured here), and it says which
 * tick it measured, because this is a snapshot of a world that keeps moving: a
 * reading that did not carry its tick would be indistinguishable from a current
 * one, the same way the inspector would describe a dead bug as a live one.
 *
 * Clicking a column selects that gene and writes it into the dna-byte control --
 * upstream's HistogramDialog mouse handler -> selectGene -> spinDNAVal -- so the
 * DNA-value view mode then shows the byte that was clicked.
 */
const varCanvas = $('variance');
const varCtx = varCanvas.getContext('2d');

// A measurement belongs to one world (see worldSerial, bumped by buildWorld):
// carrying the tick is not enough, because rebuild the world and "tick 200" becomes
// a claim about a world that no longer exists, with a click that would read its
// genes. A reading from any other world is therefore not a reading at all.
let measured = null;   // { world, tick, spread, columns }, or null when none is valid

/** One bar per CSS pixel, with the backing store following the display density. */
function sizeChart() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(varCanvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(varCanvas.clientHeight * dpr));
  if (varCanvas.width !== width || varCanvas.height !== height) {
    varCanvas.width = width;
    varCanvas.height = height;
  }
  varCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: varCanvas.clientWidth, height: varCanvas.clientHeight };
}

/** The palette's ramp, as the canvas wants it. Same table the blit uses, so a
 *  colour means one thing on both surfaces (varianceChart.ts says why). */
const cssColor = (packed) =>
  `rgb(${packed & 0xff}, ${(packed >>> 8) & 0xff}, ${(packed >>> 16) & 0xff})`;

function measureVariance() {
  const { width, height } = sizeChart();
  const genomes = [];
  dish.forEachBug((bug) => genomes.push(bug.dna.data));

  const started = performance.now();
  const spread = geneSpread(genomes, dish.worldParams.maxData);
  const ms = performance.now() - started;

  const columns = Math.max(1, Math.round(width));
  const bars = chartColumns(spread.spread, columns);
  measured = { world: worldSerial, tick: dish.time, spread: spread.spread, columns };

  varCtx.clearRect(0, 0, width, height);
  for (let c = 0; c < columns; c++) {
    const value = bars[c];
    // A gene that varies a little is drawn at least one pixel high, so it cannot
    // render as indistinguishable from a gene that does not vary at all.
    const bar = Math.max(value > 0 ? 1 : 0, Math.round(value * height));
    varCtx.fillStyle = cssColor(PALETTE[barIndex(value)]);
    varCtx.fillRect(c, height - bar, 1, bar);
  }

  // The measurement is handed over whole: this page imports built JavaScript, so
  // nothing here is type-checked against GeneSpread, and a hand-copied field list
  // is where a number turns into `undefined` silently.
  message(chartSummary({ tick: dish.time, spread, columns, ms }), false, 'varMsg');
}

/** Throw a reading away, so nothing can be read from it afterwards. */
function clearVariance(text) {
  measured = null;
  const { width, height } = sizeChart();
  varCtx.clearRect(0, 0, width, height);
  message(text, false, 'varMsg');
}

/**
 * Called on the stats cadence. Following the world means the reading is always
 * current; holding it means the reading stays only while it is still *this* world's,
 * because a held chart of a rebuilt world is a reading of something that is gone.
 */
function refreshVariance() {
  if ($('varFollow').checked) {
    measureVariance();
  } else if (measured !== null && measured.world === worldSerial) {
    return;                                     // held, and still describing this world
  } else {
    clearVariance(measured === null ? 'not measured yet' : 'world rebuilt — not measured yet');
  }
}

varCanvas.addEventListener('click', (event) => {
  if (measured === null) {
    message('nothing measured — turn follow on to measure this world', false, 'varMsg');
    return;
  }
  const rect = varCanvas.getBoundingClientRect();
  const column = Math.floor(((event.clientX - rect.left) / rect.width) * measured.columns);
  const gene = geneAtColumn(column, measured.columns, measured.spread.length);
  $('showByte').value = String(gene);
  applyViewMode();      // the DNA-value mode reads showByte, so refresh the view
  draw();
  message(
    `gene ${gene} spread ${measured.spread[gene].toFixed(3)} at tick ${measured.tick} — the DNA-value view mode shows that byte`,
    false, 'varMsg',
  );
});

$('varFollow').addEventListener('change', () => {
  if ($('varFollow').checked) {
    measureVariance();
  } else if (measured === null) {
    // Nothing valid to hold: either never measured, or measured on a world since rebuilt.
    message('not measured yet', false, 'varMsg');
  } else {
    // Held: a frozen reading is useful only if it says when it was taken, and it is
    // only this world's reading until the world is replaced.
    message(`held at tick ${measured.tick} — the world keeps running`, false, 'varMsg');
  }
});

// ---------------------------------------------------------------- stats
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
  refreshBug();       // same cadence as the stats: a live view, not a snapshot
  // The gene chart is a measurement of the whole population, so it follows the same
  // 2 Hz -- the interval upstream's dialog painted on -- and can be held when a
  // frozen reading is what is wanted.
  refreshVariance();
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
  /** A scripted Step, behaving exactly like the Step button -- including the stats
   *  refresh, so a probe cannot read a chart describing the state before the step. */
  step(n = 1) {
    for (let i = 0; i < n; i++) dish.step();
    draw();
    stats(performance.now(), true);
    return this.hash();
  },
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
