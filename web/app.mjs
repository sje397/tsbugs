/**
 * The web view of the ported simulation.
 *
 * This is a driver, not a second implementation: it imports the same compiled
 * modules the tests and the benchmarks run, so what the page shows is the real
 * VM -- the page cannot drift from the simulation because it does not contain
 * one.
 *
 * Three pieces of arithmetic live outside this file, because each one is a way
 * this page could be silently wrong and each one has tests rather than prose:
 *
 *   - `src/ui/blit.ts` turns `viewCol` into pixels. The cell index is
 *     `x * height + y` (column-major, the model's) and the pixel is `y * width +
 *     x` (row-major, the canvas's); writing one where the other belongs mirrors
 *     the dish across its diagonal, which looks entirely plausible.
 *   - `src/ui/worldView.ts` owns cell <-> screen: zoom, pan, a stage that is not
 *     square. The marker, the hover probe and the click all read it, so they
 *     cannot disagree with each other or with what was drawn.
 *   - `src/ui/machine.ts` says what one bug is doing, including the sense window
 *     whose nine slots have an order that a transposed grid would not reveal.
 *
 * Everything else here is DOM: what the panel says, and which control writes
 * which parameter.
 */

import { PetriDish, ViewMode } from '../dist/src/sim/dish.js';
import { decodeLinear } from '../dist/src/sim/disasm.js';
import { MAX_I } from '../dist/src/sim/processor.js';
import { hex2, hex4, instructionIndexAt, isMidInstruction, rowBytes, rowTail } from '../dist/src/ui/disasmView.js';
import {
  ENERGY_LAYOUTS, GROUP_NOTES, GROUP_ORDER, GROUP_TITLES,
  discoverGroups, label, panelFields,
} from '../dist/src/ui/paramPanel.js';
import { SLIDER_MAX, sliderPosition, sliderToRate, summariseRate } from '../dist/src/ui/mutationScale.js';
import { geneSpread } from '../dist/src/sim/variance.js';
import { barIndex, chartColumns, chartSummary, geneAtColumn } from '../dist/src/ui/varianceChart.js';
import { nearestBugAnywhere, pickNearestBug } from '../dist/src/ui/pickBug.js';
import { DEFAULT_PARAMS, ENERGY_COLOR, POISON_COLOR, MAX_BUG_COLOR, BKG_COLOR } from '../dist/src/sim/params.js';
import { PALETTE, colourName, cssFor, onColour } from '../dist/src/ui/palette.js';
import { Rng } from '../dist/src/sim/rng.js';
import { fingerprint } from '../dist/src/sim/fingerprint.js';
import {
  WORLD_KEY_PREFIX, bytesToBase64, decodeWorld, deleteWorld, encodeWorld, isValidWorldName,
  listWorlds, loadWorld, saveWorld, storageUsed,
} from '../dist/src/ui/worldStore.js';
import { defaultWorldName, uniqueWorldName } from '../dist/src/ui/worldName.js';
import { blitViewCol } from '../dist/src/ui/blit.js';
import {
  cellAt, cellCentre, centreOn, fitZoom, layout, panBy, toDevice, zoomStep,
} from '../dist/src/ui/worldView.js';
import { DEFAULT_PRESET_ID, PRESETS, presetById, presetParams } from '../dist/src/ui/presets.js';
import {
  decisionOf, directionName, registersOf, senseFrame, sensesOf, snapshotOf, tickDelta,
} from '../dist/src/ui/machine.js';
import { CLASS_LABEL, CLASS_ORDER, genomeStrip, opClass } from '../dist/src/ui/genomeMap.js';
import { genePool } from '../dist/src/ui/genePool.js';

// ---------------------------------------------------------------- palette
// The colour table and its CSS rendering live in src/ui/palette.ts, which is
// testable; this page only asks it what a code looks like. The legend used to
// pack the table itself and got poison and energy wrong by passing a code where
// a packed word belonged -- see that module's header.

// ---------------------------------------------------------------- elements
const $ = (id) => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`no element #${id} -- check the id against index.html`);
  return el;
};

const canvas = $('view');
const ctx = canvas.getContext('2d');

/** The frame budget, in ms, for "fill the frame". At the measured 137 us per
 *  tick (240x240, ~100 bugs) this is ~58 ticks; the rest of the 16.7 ms frame
 *  is left for the blit and the browser. */
const BUDGET_MS = 8;

/**
 * Say something in the dish's own banner.
 *
 * One channel, in the place the eye already is. It used to be a line under each
 * section, which meant the message about a refused parameter appeared on a
 * different panel from the control that refused it, and scrolling the rail could
 * hide the answer to what had just been typed.
 *
 * A refusal stays up five times as long as an acknowledgement, because a refusal
 * is the message that has to be read and an acknowledgement is a confirmation of
 * something the user already expected.
 */
let bannerTimer = 0;
function message(text, bad = false, id = 'banner') {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', bad);
  if (id !== 'banner') return;      // panel messages are persistent lines, not toasts
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), bad ? 6000 : 3200);
}

// ---------------------------------------------------------------- view
/**
 * Which part of the world the stage is showing.
 *
 * `zoom: 0` means "fit", and it is a sentinel rather than a number because the
 * fit is not a constant: resize the window and it changes. Every explicit zoom
 * materialises the fit into a number first (`materialiseView`), so panning and
 * zooming work against a real scale instead of against 0.
 *
 * The whole world is still blitted every frame -- 240x240 is 57,600 cells and the
 * blit is a table lookup each -- so zoom costs nothing but a bigger destination
 * rectangle. There is no clipping logic to get wrong.
 */
let view = { zoom: 0, ox: 0, oy: 0 };

const ZOOM_LADDER_MAX = 24;      // worldView.ts's ZOOM_MAX, named here for the readout

function worldSize() {
  return { width: dish.width, height: dish.height };
}

/** The stage in CSS pixels. At least 1, because a hidden dish measures 0 and a
 *  zero-width viewport would divide by zero in the fit. */
function viewportSize() {
  return { width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
}

function effectiveView() {
  if (view.zoom !== 0) return view;
  return { zoom: fitZoom(worldSize(), viewportSize()), ox: 0, oy: 0 };
}

function currentLayout() {
  return layout(worldSize(), viewportSize(), effectiveView());
}

/** Turn "fit" into the scale it currently resolves to, so a gesture can move it. */
function materialiseView() {
  if (view.zoom !== 0) return;
  const l = currentLayout();
  view = { zoom: l.cellPx, ox: l.ox, oy: l.oy };
}

function setView(next) {
  view = next;
  draw();
}

/** The backing store follows the element's CSS size in device pixels. */
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.imageSmoothingEnabled = false;   // sizing the canvas resets the context's state
  return dpr;
}

/** viewCol -> stage. One palette lookup per cell, then one scaled blit. */
function draw() {
  const dpr = resizeCanvas();
  blitViewCol(dish.viewCol, dish.width, dish.height, image32, PALETTE);
  offCtx.putImageData(imageData, 0, 0);

  const l = currentLayout();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Destination on whole device pixels: a fractional one is resampled, which is
  // the single thing the integer cell size exists to prevent (worldView.toDevice).
  ctx.drawImage(
    off,
    0, 0, dish.width, dish.height,
    toDevice(l.originX, dpr), toDevice(l.originY, dpr),
    toDevice(dish.width * l.cellPx, dpr), toDevice(dish.height * l.cellPx, dpr),
  );

  drawInspectorMarker(l, dpr);
}

/**
 * Ring the bug under inspection, and box the cell that was clicked when the two
 * differ.
 *
 * The ring is redrawn every frame against the bug's current cell, so the panel's
 * subject stays identifiable as it moves -- and at the fitted zoom on a 480-cell
 * world a bug is one pixel, which is why the ring is a fixed minimum radius in
 * screen space rather than a multiple of the cell: a ring that shrinks with the
 * cell disappears exactly when the world is most crowded.
 */
function drawInspectorMarker(l, dpr) {
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  ctx.lineJoin = 'miter';

  if (pickedNear !== null && clickedAt !== null) {
    const box = cellCentre(l, clickedAt.x, clickedAt.y);
    const size = Math.max(3, l.cellPx);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeRect(
      toDevice(box.x - size / 2, dpr) + 0.5, toDevice(box.y - size / 2, dpr) + 0.5,
      toDevice(size, dpr) - 1, toDevice(size, dpr) - 1,
    );
  }

  if (watched === null) return;
  const hash = locateWatched();
  if (hash === null) return;

  const at = cellCentre(l, Math.trunc(hash / dish.height), hash % dish.height);
  const r = Math.max(4, l.cellPx * 1.6);

  // Dark outline under a light ring, so one of the two reads against any cell the
  // view modes can produce, black background included.
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath();
  ctx.arc(toDevice(at.x, dpr), toDevice(at.y, dpr), toDevice(r, dpr) + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.arc(toDevice(at.x, dpr), toDevice(at.y, dpr), toDevice(r, dpr), 0, Math.PI * 2);
  ctx.stroke();
}

/** Keep a followed bug on screen: centred, as far as the world's edges allow. */
function followWatched() {
  if (!$('follow').checked || watched === null) return;
  const hash = locateWatched();
  if (hash === null) return;
  const l = currentLayout();
  view = centreOn(worldSize(), viewportSize(), l.cellPx, Math.trunc(hash / dish.height), hash % dish.height);
}

/** The hovertip: what is under the pointer, named. */
function renderHud(cell) {
  const hud = $('hud');
  if (cell === null) {
    hud.hidden = true;
    return;
  }
  const hash = cell.x * dish.height + cell.y;
  const here = dish.bugsAt(hash).length;
  const value = dish.viewCol[hash];
  const what = colourName(value);
  hud.textContent = '';
  const line = (k, v) => {
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'k';
    span.textContent = k;
    div.append(span, document.createTextNode(` ${v}`));
    hud.append(div);
  };
  line('cell', `${cell.x}, ${cell.y}`);
  line('holds', here === 0 ? what : `${here} bug${here === 1 ? '' : 's'}`);
  hud.hidden = false;
}

// ---------------------------------------------------------------- tabs
/**
 * The rail is one column beside the stage, and it holds four instruments: the
 * machine you selected, the genome it inherited, the dials, and the world.
 *
 * Three consequences worth stating, because each is a way this could be wrong:
 *
 *   - a hidden section has no layout, so anything that measures itself -- the
 *     gene chart's backing store, the scroll position of the code listing -- must
 *     be told when it is shown, or it measures a width of zero and stays wrong
 *     until the next 500 ms tick (or, for the listing, forever);
 *   - switching sections must not touch the simulation: a tab is a view of the
 *     rail, not a mode. Nothing here reads or writes the world;
 *   - picking a bug selects the Bug section, because a click that paused the world
 *     and showed nothing would read as the click having failed.
 */
const TABS = ['bug', 'genome', 'params', 'world'];
const TAB_KEY = 'tsbugs.tab';
let activeTab = null;

function showTab(name) {
  const next = TABS.includes(name) ? name : 'params';
  const changed = next !== activeTab;
  activeTab = next;

  for (const button of document.querySelectorAll('#tabs button')) {
    button.setAttribute('aria-selected', button.dataset.tab === next ? 'true' : 'false');
  }
  for (const section of document.querySelectorAll('#tabbody > section')) {
    section.hidden = section.dataset.tab !== next;
  }
  if (changed) $('tabbody').scrollTop = 0;
  syncScrollEdge();     // a new section is a new scroll extent

  // A section that has just become visible has to catch up on what it could not
  // measure while it was hidden -- the gene chart, and only the chart: a hidden
  // canvas reports `clientWidth` 0, so the columns it was asked to draw while
  // away were skipped and have to be drawn now.
  //
  // The listing is deliberately not in that list. While hidden it reads
  // `scrollTop` 0 with `clientHeight` 0, which looks like a lost scroll position
  // and is not: unhide it and the browser puts the scroll back (measured, 1200 in
  // and 1200 out). Scrolling it to the cursor on the way in would therefore
  // discard a place the reader had chosen.
  if (next === 'genome') {
    refreshVariance();
    refreshGenome();
  }

  try {
    storage?.setItem(TAB_KEY, next);
  } catch {
    // A browser that refuses storage has already been reported by the save path;
    // forgetting which tab was open is not worth a second message.
  }
}

/**
 * Say when the section continues below the fold.
 *
 * `more` fades the bottom edge. It is not decoration: the scrollbar on macOS is an
 * overlay that appears only while the wheel is turning, so a row cut by the bottom
 * edge is indistinguishable from a row that was never drawn. Read from the DOM
 * rather than tracked, because a section changes height for reasons this file
 * cannot enumerate (a saved-world list that gains a row, a message that wraps).
 */
const tabbody = $('tabbody');

function syncScrollEdge() {
  tabbody.classList.toggle('more', tabbody.scrollHeight - tabbody.clientHeight - tabbody.scrollTop > 2);
}

tabbody.addEventListener('scroll', syncScrollEdge, { passive: true });
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(syncScrollEdge);
  for (const section of document.querySelectorAll('#tabbody > section')) observer.observe(section);
}

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

// ---------------------------------------------------------------- layout
/**
 * Dish, Split, Charts.
 *
 * One page, three arrangements of it: the picture alone, the picture with its
 * history and instruments, or the history alone. The rail is the same column in
 * all three, so the panel never moves out from under the pointer -- and the
 * simulation does not care, because a layout is a CSS fact (body[data-layout]).
 */
const LAYOUT_KEY = 'tsbugs.layout';
const LAYOUTS = ['dish', 'split', 'charts'];

function showLayout(name) {
  const next = LAYOUTS.includes(name) ? name : 'split';
  document.body.dataset.layout = next;
  for (const button of document.querySelectorAll('#layoutSwitch button')) {
    button.setAttribute('aria-pressed', button.dataset.layout === next ? 'true' : 'false');
  }
  // The dish changes size here, and a canvas does not re-measure itself.
  draw();
  drawChart();
  try {
    storage?.setItem(LAYOUT_KEY, next);
  } catch { /* see showTab */ }
}

for (const button of document.querySelectorAll('#layoutSwitch button')) {
  button.addEventListener('click', () => showLayout(button.dataset.layout));
}

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

/**
 * The poison count the form is asking for, or null if it is asking for nothing
 * usable.
 *
 * Refused rather than clamped or coerced, because the dish's scatter treats a
 * count it cannot use as zero: `while (count > 0)` is false for NaN, so a typo
 * would quietly deal a world with no poison in it and say nothing. A form that
 * silently builds something other than what it says is the defect this whole
 * section is meant to be free of.
 */
function poisonCells() {
  const raw = String($('poisonCells').value).trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Build a world from the New World form: the preset, then the fields the form
 * owns outright, then the size and the seed.
 *
 * Poison was offered by the params panel until it moved here. The panel is a view
 * of a running world, so for a field the world cannot adopt it could only report
 * `ignored` -- "rebuild to apply" -- and that was not true: this function rebuilt
 * from the preset, so the edit was dropped and the panel's promise was a lie. It
 * is a field of the form, so it is a control on the form.
 */
function buildWorld() {
  const size = Number($('size').value);
  const seed = Number($('seed').value);
  const preset = presetById($('preset').value) ?? presetById(DEFAULT_PRESET_ID);
  const poison = poisonCells();
  if (poison === null) {
    message('poison cells needs a whole number of 0 or more -- the world was not rebuilt', true);
    return;
  }

  const params = { ...presetParams(preset.id), poison, width: size, height: size };
  adoptDish(new PetriDish(params, new Rng(seed)));
  message(`${preset.name}: ${size}x${size}, seed ${seed}, poison ${poison}`);
}

/**
 * Put a dish on screen: build, load, or import all end here.
 *
 * The world these came from is the point of the split. A loaded world may be a
 * different size from the controls, so nothing here reads them; the size select is
 * written from the world instead, because "New world" must mean what the panel says
 * it means rather than what it said when the page opened.
 */
function adoptDish(next) {
  dish = next;
  const { width, height } = dish;

  off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  offCtx = off.getContext('2d');
  imageData = offCtx.createImageData(width, height);
  image32 = new Uint32Array(imageData.data.buffer);

  const sizeOption = Array.from($('size').options).find((option) => Number(option.value) === width);
  if (sizeOption) $('size').value = sizeOption.value;
  // The form describes the world on screen, so a loaded or imported world writes
  // its own poison count back into it -- otherwise the next New World would deal
  // the previous world's number while the form said nothing about it.
  $('poisonCells').value = String(dish.worldParams.poison);

  worldSerial++;      // everything measured so far describes the previous world
  view = { zoom: 0, ox: 0, oy: 0 };   // a new world is shown whole
  watched = null;
  watchedDied = null;
  lastClick = { hash: -1, index: 0 };
  clickedAt = null;
  pickedNear = null;
  currentDish = null;
  bugView = null;
  history = [];
  showEmptyInspector();
  refreshGenome();

  applyViewMode();
  renderParams();
  resizeCanvas();
  draw();
  stats(performance.now(), true);
  return dish;
}

// ---------------------------------------------------------------- view mode
const MODES = [
  ['Default', ViewMode.DEFAULT],
  ['Bugs only', ViewMode.BUGS],
  ['Bug energy', ViewMode.ENERGY],
  ['Age', ViewMode.AGE],
  ['DNA size', ViewMode.DNA_SIZE],
  ['DNA value', ViewMode.DNA_VALUE],
];

$('modes').innerHTML = MODES.map(([text, value], i) =>
  `<label><input type="radio" name="mode" value="${value}"${i === 0 ? ' checked' : ''}>${text}</label>`,
).join('');

/**
 * What the colours on the stage mean, for the mode that is on.
 *
 * Written per mode rather than as one general sentence, because the ramp means
 * the opposite for age: energy, DNA size and a DNA byte all go red at the low end
 * and green at the high, while age goes green for young and red for old. A single
 * "red -> green" legend would be right for five modes and backwards for the sixth.
 */
function renderLegend(mode) {
  const host = $('legend');
  host.textContent = '';
  const swatch = (color, text) => {
    const item = document.createElement('span');
    const box = document.createElement('i');
    box.className = 'sw';
    box.style.background = color;
    item.append(box, document.createTextNode(text));
    host.append(item);
  };
  const ramp = (text) => {
    const item = document.createElement('span');
    const box = document.createElement('i');
    box.className = 'ramp';
    // The real palette the blit uses, sampled: this cannot drift from the dish.
    box.style.background = `linear-gradient(90deg, ${cssFor(1)}, ${cssFor(MAX_BUG_COLOR / 2)}, ${cssFor(MAX_BUG_COLOR)})`;
    item.append(box, document.createTextNode(text));
    host.append(item);
  };

  switch (mode) {
    case ViewMode.DEFAULT:
      swatch(cssFor(126), 'bug colour');
      swatch(cssFor(POISON_COLOR), 'poison');
      swatch(cssFor(ENERGY_COLOR), 'energy cell');
      break;
    case ViewMode.BUGS:
      swatch(cssFor(126), 'bug colour');
      host.append(document.createTextNode('everything else is black'));
      break;
    case ViewMode.ENERGY:
      ramp('bug energy: red = min, green = max');
      break;
    case ViewMode.AGE:
      ramp('age: green = young, red = max age');
      break;
    case ViewMode.DNA_SIZE:
      ramp('DNA size: red = min data, green = max data');
      break;
    case ViewMode.DNA_VALUE:
      ramp(`DNA byte ${$('showByte').value}: red = low, green = high`);
      break;
    default:
      break;
  }
}

function applyViewMode() {
  const mode = Number(document.querySelector('input[name=mode]:checked').value);
  dish.setViewMode(mode);
  dish.setShowByte(Number($('showByte').value));
  renderLegend(mode);   // a legend says different things per mode; see renderLegend
}

for (const el of document.querySelectorAll('input[name=mode]')) {
  el.addEventListener('change', () => { applyViewMode(); draw(); });
}
$('showByte').addEventListener('change', () => { applyViewMode(); draw(); });

// ---------------------------------------------------------------- controls
$('speed').addEventListener('input', () => { $('speedVal').textContent = $('speed').value; });
$('new').addEventListener('click', buildWorld);
$('step').addEventListener('click', () => {
  running = false;
  $('run').textContent = 'Run';
  dish.step();
  draw();
  stats(performance.now(), true);
});
$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Stop' : 'Run';
  if (running) $('follow').blur();   // a keyboard-focused checkbox eats the space bar
});

// ---------------------------------------------------------------- presets
function renderPresets() {
  const select = $('preset');
  select.textContent = '';
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }
  select.value = DEFAULT_PRESET_ID;
  $('presetNote').textContent = presetById(DEFAULT_PRESET_ID).description;
  // Choosing a preset fills the form, which is what "a seed for the New World
  // form" means: the poison count is part of the preset, so it has to show. That
  // is also what makes the two controls one control -- the field overrides the
  // preset for the next build, and picking another preset overrides the field.
  const fillFromPreset = () => {
    const preset = presetById(select.value) ?? presetById(DEFAULT_PRESET_ID);
    $('presetNote').textContent = preset.description;
    $('poisonCells').value = String(presetParams(preset.id).poison);
  };
  fillFromPreset();
  select.addEventListener('change', fillFromPreset);
}

// ---------------------------------------------------------------- inspector
/**
 * The Bug section: what one bug is, right now.
 *
 * The panel is a live view of an individual VM, not a snapshot taken at click
 * time -- the original's worldView.clicked -> edit_bug path copied the DNA, and
 * what that loses is everything worth watching: where the pointer is, what the
 * accumulator is doing, what the bug can see this tick.
 *
 * The code listing is decodeLinear from address 0: one decode of the genome in
 * address order, with the instruction ip currently sits in highlighted. A jump can
 * land in the middle of a byte range that sweep read as operands -- that is real,
 * it is how the machine runs, and the listing says so rather than re-decoding from
 * ip and pretending the stream is contiguous.
 */
let watched = null;      // the Bug under inspection, or null
let watchedHash = undefined;
let watchedDied = null;  // tick at which it was last seen alive, once it is gone
let lastClick = { hash: -1, index: 0 };
let clickedAt = null;    // cell the last click landed on, for the marker
let pickedNear = null;   // how a non-direct selection was made, or null

/**
 * The panel as currently rendered: the decoded listing, the row elements, and the
 * spans holding each live fact.
 *
 * Kept because the alternative is rebuilding the panel on every refresh, and a
 * rebuild is what used to throw the reader back to the top of the code: the panel
 * is redrawn from the stats tick, and each redraw reset the scroll position of a
 * box they had scrolled into. A refresh now moves the cursor and rewrites a
 * handful of text nodes; only a new selection or an edit rebuilds.
 */
let bugView = null;

/** The last thing said about an edit, so a rebuild does not swallow it. */
let bugNote = null;

/** How far from the click to look for a bug, in screen pixels. A cell is a few
 *  pixels across at the fitted zoom, so a reach in cells would shrink to nothing
 *  exactly when the world is most crowded -- and a click that selects nothing
 *  because the user was one pixel off reads as the page being broken. */
const PICK_REACH_PX = 14;

/** Selecting a bug stops the world.
 *
 *  The panel describes a running machine: ip, cell, age, energy and the code under
 *  the cursor all move between one read and the next, so an inspected bug is a bug
 *  the reader is chasing. Holding the world is what makes the readout checkable --
 *  and it is what makes an edit make sense, since a byte written into a program
 *  that is already somewhere else is a change whose effect nobody can see.
 *
 *  Run is the way out, and it is the same button that always means "continue". */
function pauseForInspection() {
  if (!running) return;
  running = false;
  $('run').textContent = 'Run';
}

/** Where the watched bug is now, or null once it is gone. */
function locateWatched() {
  if (watched === null) return null;
  let found = null;
  dish.forEachBug((bug, hash) => {
    if (bug === watched) found = hash;
  });
  return found;
}

/**
 * What the inspector says when no bug is selected.
 *
 * A world built by New World holds nothing to click: bugs are only ever created by
 * `balance()`, which runs in the step phase, so the world is empty until it has
 * ticked once. The prompt used to be "click a bug in the dish" in every case, which
 * on a fresh world is advice that cannot be taken -- the dish is blank and there is
 * no bug to click, and nothing on screen says why. So the empty state reads the
 * world's own counters and names the state instead of asking for an impossible
 * action.
 *
 * The tick-0 branch and the later one are separate sentences on purpose: at tick 0
 * nothing has been *done*, while a world that has ticked and holds nothing has been
 * through `balance()` and is short of the energy it needs to inject (the loop is
 * `bugEnergy < minBugEnergy && remainingEnergy >= maxEnergy`), which is a different
 * thing to be told.
 */
function emptyInspectorText() {
  if (dish.population > 0) return 'click a bug in the dish to read its program';
  if (dish.time === 0) return 'the world holds no bugs yet -- its first tick fills it, so press Run or Step';
  return `the world holds no bugs at tick ${dish.time} -- balance() refills it while it is short of energy, so press Run or Step`;
}

function showEmptyInspector() {
  showBugInfo(emptyInspectorText());
  inspectorEmpty = true;
}

/**
 * Keeps the empty prompt true while it is on screen.
 *
 * The world changes under the panel: a step fills an empty world with bugs, and a
 * die-off can empty one that was full. The prompt is only redrawn when its text
 * would actually change, so this costs a string build per refresh and never
 * touches the panel while a bug is selected or a death is being reported.
 */
function refreshEmptyInspector() {
  if (!inspectorEmpty) return;
  if (emptyInspectorText() === bugInfoText) return;
  showEmptyInspector();
}

/**
 * The text last written into the inspector, and whether it is the empty-world one.
 *
 * The empty prompt is the only message that describes the WORLD rather than a bug,
 * so it is the only one that can go stale while it is on screen: press Step and the
 * world fills with bugs while "the world holds no bugs yet" is still sitting there.
 * Tracking which message is showing is what lets the refresh in `refreshBug` tell
 * apart a prompt it may rewrite from a report about a bug that died.
 */
let bugInfoText = '';
let inspectorEmpty = false;

/** Replaces the panel with one line of text -- no bug, a dead bug, a missed click. */
function showBugInfo(text) {
  bugInfoText = text;
  inspectorEmpty = false;
  bugView = null;
  bugNote = null;
  watchedHash = undefined;
  const host = $('bug');
  host.textContent = '';
  const p = document.createElement('div');
  p.className = 'dim';
  p.textContent = text;
  host.append(p);
}

function selectBug(hash) {
  clickedAt = { x: Math.trunc(hash / dish.height), y: hash % dish.height };

  let target = hash;
  let from = null;
  let list = dish.bugsAt(hash);
  const l = currentLayout();

  if (list.length === 0) {
    // The world is ~0.13% occupied, so a click aimed at a bug lands on empty
    // ground about as often as on the bug -- take the nearest within a reach that
    // follows the drawn cell size, and record how far it was.
    const radius = Math.max(1, Math.round(PICK_REACH_PX / l.cellPx));
    const pick = pickNearestBug(dish, clickedAt.x, clickedAt.y, radius);
    if (pick === null) {
      const near = nearestBugAnywhere(dish, clickedAt.x, clickedAt.y);
      watched = null;
      watchedHash = hash;
      watchedDied = null;
      pickedNear = null;
      showBugInfo(near === null
        ? `no bugs in the world (tick ${dish.time})`
        : `no bug within ${radius} cells of ${clickedAt.x},${clickedAt.y} -- the nearest is ${near.distance.toFixed(1)} cells away (tick ${dish.time})`);
      draw();   // the ring of a previous selection has to go, and a paused world repaints on nothing else
      return;
    }
    target = pick.hash;
    from = { distance: pick.distance, radius, x: clickedAt.x, y: clickedAt.y };
    list = dish.bugsAt(target);
  }

  // Repeated clicks on one cell walk its list, since a cell can hold several and
  // only the first one's colour is drawn.
  const index = lastClick.hash === target ? (lastClick.index + 1) % list.length : 0;
  lastClick = { hash: target, index };
  watched = list[index];
  watchedHash = target;
  watchedDied = null;
  bugView = null;          // a new subject, so the panel is rebuilt
  pickedNear = from;
  pauseForInspection();
  showTab('bug');          // the selection has to be visible, or the click reads as having failed
  refreshBug();
  draw();
}

// ---------------------------------------------------------------- input
/**
 * The stage is a window onto the world, and a pointer is doing one of three
 * things on it: selecting, panning, or asking what is under it.
 *
 * They are separated by distance rather than by modifier, because the alternative
 * asks a reader to know that a drag pans before they have tried one: a press that
 * moves more than a few pixels is a pan and the click it ends with is discarded; a
 * press that does not move is a selection.
 */
let drag = null;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
  canvas.setPointerCapture?.(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();

  if (drag !== null && drag.id === event.pointerId) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    if (drag.moved > 4) {
      canvas.classList.add('panning');
      materialiseView();
      view = panBy(worldSize(), viewportSize(), view, dx, dy);
      drag.x = event.clientX;
      drag.y = event.clientY;
      followWatched();
      draw();
    }
    return;
  }

  renderHud(cellAt(currentLayout(), event.clientX - rect.left, event.clientY - rect.top));
});

canvas.addEventListener('pointerup', (event) => {
  if (drag === null || drag.id !== event.pointerId) return;
  const wasPan = drag.moved > 4;
  drag = null;
  canvas.classList.remove('panning');
  canvas.releasePointerCapture?.(event.pointerId);
  if (wasPan) return;      // a pan ends where it ends; it does not also select

  const rect = canvas.getBoundingClientRect();
  const cell = cellAt(currentLayout(), event.clientX - rect.left, event.clientY - rect.top);
  if (cell !== null) selectBug(cell.x * dish.height + cell.y);
});

canvas.addEventListener('pointerleave', () => {
  if (drag === null) $('hud').hidden = true;
});

/**
 * Wheel zooms about the pointer, which is the gesture every map on the web has
 * taught: the thing under the cursor is what you are looking at, so it is what
 * should stay put. `zoomStep` holds the anchored cell still and the view clamps at
 * the world's edges, so the two-step ritual of "zoom then drag it back" is not needed.
 */
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  materialiseView();
  const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  view = zoomStep(worldSize(), viewportSize(), view, event.deltaY < 0 ? 1 : -1, anchor);
  followWatched();
  draw();
}, { passive: false });

$('zoomIn').addEventListener('click', () => {
  const l = currentLayout();
  materialiseView();
  view = zoomStep(worldSize(), viewportSize(), view, 1, { x: l.viewport.width / 2, y: l.viewport.height / 2 });
  followWatched();
  draw();
});

$('zoomOut').addEventListener('click', () => {
  const l = currentLayout();
  materialiseView();
  view = zoomStep(worldSize(), viewportSize(), view, -1, { x: l.viewport.width / 2, y: l.viewport.height / 2 });
  followWatched();
  draw();
});

$('zoomFit').addEventListener('click', () => {
  view = { zoom: 0, ox: 0, oy: 0 };
  draw();
});

$('follow').addEventListener('change', () => {
  if (!$('follow').checked) return;
  materialiseView();
  followWatched();
  draw();
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function refreshBug() {
  if (watched === null) {
    refreshEmptyInspector();
    return;
  }

  const hash = locateWatched();
  if (hash === null) {
    watchedDied ??= dish.time;
    showBugInfo(`this bug is gone -- it died around tick ${watchedDied}. Click another.`);
    return;
  }

  if (bugView === null || bugView.bug !== watched || bugView.size !== watched.dna.data.length) {
    renderBugPanel(watched, hash);
    return;
  }
  updateBugLive(watched, hash);
}

/**
 * Everything the panel says about a bug that does not change while it is watched,
 * built once, plus the handles the live refresh writes through.
 *
 * The panel does not restate what the world already shows. What it adds is the
 * machine: four registers and a stack, the nine cells the bug was handed, and the
 * decision it made with them -- none of which any view in the original displayed.
 */
function renderBugPanel(bug, hash) {
  const genome = bug.dna.data;
  const listing = decodeLinear(genome);

  const host = $('bug');
  host.textContent = '';

  const who = el('div', 'who');
  const pill = el('span', 'pill live', 'live');
  const id = el('span', 'id', '');
  who.append(pill, id);
  host.append(who);

  // -- registers ---------------------------------------------------------
  const regs = el('div', 'regs');
  const regRef = {};
  const reg = (key, name) => {
    const box = el('div', 'reg');
    const v = el('span', 'v', '0');
    box.append(el('span', 'k', name), v);
    regs.append(box);
    regRef[key] = { box, v };
  };
  reg('ip', 'ip');
  reg('acc', 'acc');
  reg('sp', 'sp');
  reg('bp', 'bp');
  reg('stack', 'stack');
  reg('steps', 'steps/tick');
  host.append(regs);

  // -- what it decided ---------------------------------------------------
  const decision = el('div', 'decision');
  host.append(decision);

  // -- what changed since the last reading -------------------------------
  const delta = el('div', 'note');
  host.append(delta);

  // -- what it can see ---------------------------------------------------
  // Nine cells in the order the input pool filled them: slot = row * 3 + col, row
  // 0 at the NORTH edge (see machine.ts). The index is printed because it is what
  // the program's own instructions refer to.
  const sensesHost = el('div', 'senses');
  const senseCells = [];
  for (let slot = 0; slot < 9; slot++) {
    const cell = el('div', 'sense');
    const value = el('span', 'v', '');
    cell.append(el('span', 'idx', String(slot)), value);
    if (slot === 4) cell.classList.add('mid');
    sensesHost.append(cell);
    senseCells.push({ cell, value });
  }
  host.append(sensesHost);

  // The grid is a tick behind the dish, because the window it shows is the one the
  // decision below was made from. A caption rather than a tooltip: the offset is
  // the thing most likely to be read as a mirror, so it has to be visible without
  // a hover (machine.ts `senseFrame` says why re-sampling is the wrong fix).
  const sensesNote = el('div', 'note');
  host.append(sensesNote);

  // -- the slow facts ----------------------------------------------------
  const kv = el('div', 'kv');
  const facts = new Map();
  const fact = (key, wide = false) => {
    const k = el('span', wide ? 'wide' : '', key);
    const v = el('span', wide ? 'wide' : '', '');
    kv.append(k, v);
    facts.set(key, v);
    return v;
  };
  const colour = fact('colour');
  const swatch = el('span', 'swatch');
  colour.prepend(swatch, document.createTextNode(' '));
  fact('cell');
  fact('tick');
  fact('generation');
  fact('age');
  fact('energy');
  fact('children');
  fact('DNA').textContent = `${genome.length} bytes`;
  fact('mutation').textContent = summariseRate(bug.dna.mutationRate);
  host.append(kv);

  if (pickedNear !== null) {
    host.append(el('div', 'note',
      `selected: nearest within ${pickedNear.radius} cells -- ${pickedNear.distance.toFixed(1)} cells from your click at ${pickedNear.x}, ${pickedNear.y}`));
  }

  // -- the program -------------------------------------------------------
  const head = el('div', 'note');
  host.append(head);

  const dis = el('div', '');
  dis.id = 'dis';
  const rows = [];
  for (const ins of listing) {
    const row = bugRow(ins);
    rows.push(row);
    dis.append(row);
  }
  if (listing.length === 0) dis.append(el('div', 'dim', 'the genome is empty, so there is nothing to run'));
  host.append(dis);

  const tail = el('div', 'note',
    `${listing.length} instructions decoded from address 0 -- click a byte to edit it`
    + ` -- stack ${dish.worldParams.stackSize} bytes`
    + `; a stored byte above ${MAX_I - 1} runs as its modulo`);
  host.append(tail);

  const note = el('div', 'msg');
  host.append(note);

  bugView = {
    bug,
    size: genome.length,
    listing,
    rows,
    facts,
    regRef,
    senseCells,
    sensesNote,
    who: { pill, id },
    decision,
    delta,
    head,
    note,
    swatch,
    colour,
    at: -1,
    snap: null,
  };

  updateBugLive(bug, hash);
  // A fresh selection starts at the machine's position; after that the reader's
  // scroll is theirs.
  revealRow(bugView.at);
}

/** One listing row: the cursor column, the address, the bytes, and the decode. */
function bugRow(ins) {
  const row = document.createElement('div');
  const cursor = el('span', 'cursor', ' ');
  row.append(cursor, document.createTextNode(` ${hex4(ins.address)}  `));

  // Every byte is its own span, because every byte is its own edit. The slot comes
  // from the decode rather than being computed from the row's address, because a
  // wrapped instruction reads its operands from the start of the genome: its slots
  // there run backwards, and the same slot computed without the wrap is past the
  // end of the genome.
  rowBytes(ins).forEach((byte, i) => {
    if (i > 0) row.append(document.createTextNode(' '));
    const span = el('span', 'b', byte.hex);
    span.dataset.a = String(byte.address);
    span.title = `address ${byte.address} -- click to edit`;
    row.append(span);
  });
  const width = rowBytes(ins).map((byte) => byte.hex).join(' ').length;
  row.append(
    document.createTextNode(' '.repeat(Math.max(0, 11 - width))),
    document.createTextNode(`  ${rowTail(ins, MAX_I)}`),
  );
  return row;
}

/**
 * The facts that change while the same bug is watched: the machine, what it sees,
 * what it decided, what moved since last time — and the listing cursor.
 *
 * Nothing here rebuilds the panel. A rebuild resets the code listing's scroll, and
 * the panel refreshes twice a second, so a reader who had scrolled into the program
 * would be thrown back to the machine's position every 500 ms.
 */
function updateBugLive(bug, hash) {
  const view = bugView;
  const regs = registersOf(bug.processor);
  const x = Math.trunc(hash / dish.height);
  const y = hash % dish.height;
  const here = dish.bugsAt(hash).length;

  view.who.id.textContent = `${x},${y} · gen ${bug.generation} · age ${bug.age}`;

  // -- registers -------------------------------------------------------
  const ipAt = instructionIndexAt(view.listing, regs.ip);
  const mid = isMidInstruction(view.listing, ipAt, regs.ip);

  const setReg = (key, text, small) => {
    const ref = view.regRef[key];
    ref.v.textContent = text;
    if (small) ref.v.append(el('small', '', ` ${small}`));
  };
  setReg('ip', String(regs.ip), ipAt < 0 ? 'past the end'
    : mid ? `in the instruction at ${view.listing[ipAt].address}` : '');
  setReg('acc', String(regs.acc), `0x${hex2(regs.acc & 0xff)}`);
  setReg('sp', String(regs.sp));
  setReg('bp', String(regs.bp));
  setReg('stack', String(regs.stackSize));
  setReg('steps', String(bug.processor.stepsPerUpdate));

  // A register that moved since the previous reading is outlined. The first
  // reading of a bug marks nothing, because it has nothing to have moved from.
  const now = { ip: regs.ip, acc: regs.acc, sp: regs.sp, bp: regs.bp };
  for (const key of ['ip', 'acc', 'sp', 'bp']) {
    const changed = view.lastRegs !== undefined && view.lastRegs[key] !== now[key];
    view.regRef[key].box.classList.toggle('changed', changed);
  }
  view.lastRegs = now;

  // -- what it decided -------------------------------------------------
  // Verbatim from machine.ts, split into its three output clauses: re-deriving the
  // sentence here is how the panel and the model would start disagreeing.
  const decided = decisionOf(bug.processor);
  view.decision.textContent = '';
  for (const clause of decided.explain.split('; ')) view.decision.append(el('div', '', clause));

  // -- what moved since the last reading -------------------------------
  // Between two reads there may be several ticks (the world runs many per frame and
  // this refreshes at 2 Hz), so this is a delta over a span rather than over "the
  // previous tick", and it says which span.
  const snap = snapshotOf(bug, hash);
  if (view.snap === null) {
    view.delta.textContent = 'reading the machine — the deltas appear on the next refresh';
  } else if (snap.age > view.snap.age) {
    const d = tickDelta(view.snap, snap);
    const sign = (n) => (n >= 0 ? `+${n}` : String(n));
    let line = `since the last reading (${d.ageTo - d.ageFrom} ticks): `
      + `ip ${d.ip.from} → ${d.ip.to} (${d.ip.moved} bytes${d.ip.wrapped ? ', through the wrap' : ''})`
      + ` · acc ${d.acc.from} → ${d.acc.to} (${sign(d.acc.delta)})`
      + ` · energy ${d.energy.from} → ${d.energy.to} (${sign(d.energy.delta)})`;
    // A wrap and a backward jump produce the same pair of registers, and a tick
    // that leaves ip where it was has two explanations. Both are worth stating
    // when they happen; neither is worth a paragraph when they do not.
    if (d.ip.wrapped || d.ip.moved === 0) line += ` — ${d.note[d.note.length - 1]}`;
    view.delta.textContent = line;
  } else {
    view.delta.textContent = `nothing has run since the last reading (tick ${dish.time}, age ${snap.age})`;
  }
  view.snap = snap;

  // -- what it can see -------------------------------------------------
  // The frame first: the grid's centre is the cell the window was TAKEN at, which
  // is one step behind the cell the facts below report. A bug that has never run
  // has no sample at all, and claiming one would be worse than saying nothing.
  const senses = sensesOf(bug.processor);
  const frame = bug.age === 0
    ? null
    : senseFrame({ x, y }, bug.dir, dish.width, dish.height);
  view.sensesNote.textContent = frame === null
    ? 'not sampled yet — this bug has not run a tick, so its inputs are still zero'
    : frame.moved
      ? `sensed at ${frame.at.x}, ${frame.at.y} — one tick behind: it has since moved ${directionName(frame.movedDir)} to ${x}, ${y}`
      : `sensed at ${frame.at.x}, ${frame.at.y} — the cell it is standing in`;
  for (let slot = 0; slot < 9; slot++) {
    const row = Math.trunc(slot / 3);
    const col = slot % 3;
    const hue = senses.vision[row][col];
    const energy = senses.energy[row][col];
    const cell = view.senseCells[slot];
    const empty = hue === BKG_COLOR;
    // The two sentinels are readings, not noise: 254 is a poison pile and 255 an
    // energy cell, and the dish draws those magenta and blue. Clamping them into
    // the bug ramp -- which this did, at 252 -- showed a poison cell as an
    // ordinary bug, and a bug that dies on it would have looked inexplicable.
    cell.cell.style.background = empty ? '#0d1114' : cssFor(hue);
    cell.cell.style.color = empty ? '#8f9caa' : onColour(hue);
    cell.value.textContent = String(energy);
    cell.cell.title = `slot ${slot}: ${colourName(hue)}, energy ${energy}`
      + (slot === 4
        ? frame !== null && frame.moved ? ' — the cell it was in when it sensed' : ' — its own cell'
        : '');
  }

  // -- the slow facts --------------------------------------------------
  view.facts.get('cell').textContent =
    `${x}, ${y}${here > 1 ? ` (${here} bugs here — click again for the next)` : ''}`;
  view.facts.get('tick').textContent = String(dish.time);
  view.facts.get('generation').textContent = String(bug.generation);
  view.facts.get('age').textContent = String(bug.age);
  view.facts.get('energy').textContent = String(bug.energy);
  view.facts.get('children').textContent = String(bug.children);

  // The colour the world draws, which is not always the colour the program just
  // decided: update() writes out1 unclamped while the constructor clamps to
  // 1..252, so the drawn index is `% 252 + 1` of it (machine.ts is explicit here).
  const drawn = bug.color % 252 + 1;
  view.colour.lastChild.textContent = ` ${drawn}`;
  view.swatch.style.background = cssFor(drawn);

  view.head.textContent = (running
    ? 'running — click a bug and it holds still'
    : `paused at tick ${dish.time} — Run continues, Step advances one tick`)
    + (bug.age === 0
      ? ' — born this tick, so it has not run yet: ip, sp and bp read 0 until an update executes it'
      : bug.processor.stepsPerUpdate === 0
        ? ' — VM steps/update is 0, so nothing executes and the registers will not move'
        : '');

  view.note.className = bugNote === null ? 'msg' : `msg${bugNote.bad ? ' bad' : ''}`;
  view.note.textContent = bugNote === null ? '' : bugNote.text;

  if (ipAt !== view.at) moveCursor(ipAt);
}

/** Move the marker to row `at`, saying whether a jump landed mid-instruction. */
function moveCursor(at) {
  const view = bugView;
  if (view.at >= 0 && view.rows[view.at] !== undefined) {
    view.rows[view.at].className = '';
    view.rows[view.at].firstChild.textContent = ' ';
  }
  view.at = at;
  if (at < 0 || view.rows[at] === undefined) return;

  const mid = isMidInstruction(view.listing, at, registersOf(view.bug.processor).ip);
  view.rows[at].className = mid ? 'mid' : 'cur';
  view.rows[at].firstChild.textContent = mid ? '~' : '>';
  // The listing does not follow the cursor after the panel is built. The cursor
  // moves whenever the machine runs or steps, and a listing that scrolled itself
  // back would undo the reader's scroll — the same complaint as a rebuild that
  // resets to the top, arriving from the other direction.
}

/**
 * Scroll the listing to a row, and only as far as it takes to show it.
 *
 * Done by moving `scrollTop` rather than with scrollIntoView, which walks every
 * scrollable ancestor: revealing a row inside the panel would also drag the page
 * down to it, and the panel is a sidebar the reader may be working beside.
 */
function revealRow(at) {
  const view = bugView;
  const dis = $('dis');
  if (view === null || dis === null || at < 0) return;
  const row = view.rows[at];
  if (row === undefined) return;

  const box = dis.getBoundingClientRect();
  const line = row.getBoundingClientRect();
  if (line.top < box.top) dis.scrollTop -= box.top - line.top;
  else if (line.bottom > box.bottom) dis.scrollTop += line.bottom - box.bottom;
}

/**
 * Write one byte of the watched bug's program.
 *
 * The whole panel is rebuilt afterwards rather than patched, and that is the honest
 * cost of an edit: an opcode's length depends on which instruction it is, so
 * changing one byte re-decodes every row after it in the listing — and a row that
 * kept its old decode would show code the machine is not running. The scroll
 * position is carried across the rebuild, so the row being edited stays put.
 */
function writeByte(address, value) {
  const bug = watched;
  const previous = bug.patchCode(address, value);
  const scroll = $('dis')?.scrollTop ?? 0;
  const hash = locateWatched();
  if (hash === null) {
    watchedDied ??= dish.time;
    showBugInfo(`this bug is gone -- it died around tick ${watchedDied}. Click another.`);
    return;
  }

  bugNote = {
    text: previous === value
      ? `address ${hex4(address)} already held ${hex2(value)} — written anyway, nothing changed`
      : `wrote ${hex2(value)} at ${hex4(address)}, was ${hex2(previous)} — `
        + 'into the program this bug runs and the genome its children inherit',
    bad: false,
  };
  renderBugPanel(bug, hash);
  const dis = $('dis');
  if (dis !== null) dis.scrollTop = scroll;
  refreshGenome();     // the strip is the same bytes
  draw();
}

/** Turn a byte into the box that edits it, and put it back if nothing is written. */
function beginByteEdit(span) {
  const address = Number(span.dataset.a);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'byteEdit';
  input.value = span.textContent;
  input.spellcheck = false;
  input.setAttribute('aria-label', `byte at address ${address}`);

  // Enter, blur and the rebuild that follows a write can all arrive for one edit,
  // and a second write of the same address would report the byte it had just
  // written as the byte it replaced.
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const text = String(input.value).trim();
      if (!/^[0-9a-fA-F]{1,2}$/.test(text)) {
        bugNote = { text: `"${text}" is not a byte, so ${hex4(address)} was left alone`, bad: true };
        input.replaceWith(span);
        const hash = locateWatched();
        if (hash !== null) updateBugLive(watched, hash);
        return;
      }
      writeByte(address, Number.parseInt(text, 16));
      return;   // the rebuild has already replaced the input
    }
    input.replaceWith(span);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  span.replaceWith(input);
  input.focus();
  input.select();
}

// One delegated listener for the panel, since its rows are rebuilt on every edit.
$('bug').addEventListener('click', (event) => {
  if (watched === null || bugView === null) return;
  const span = event.target.closest('span.b');
  if (span === null || !span.dataset.a) return;
  beginByteEdit(span);
});

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

// A measurement belongs to one world (see worldSerial, bumped by adoptDish):
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

function measureVariance() {
  // A hidden section has zero width, and `sizeChart` would take that literally:
  // one column of one pixel. Measuring is also the expensive half, so a chart
  // nobody is looking at does not follow the world -- `showTab` measures once when
  // the section appears, which is the moment the reading matters.
  if (varCanvas.clientWidth === 0) return;

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
    varCtx.fillStyle = cssFor(barIndex(value));
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
  if (varCanvas.clientWidth === 0) return;   // nothing on screen to clear
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
    clearVariance(measured === null ? 'not measured yet' : 'world rebuilt -- not measured yet');
  }
}

varCanvas.addEventListener('click', (event) => {
  if (measured === null) {
    message('nothing measured -- turn follow on to measure this world', false, 'varMsg');
    return;
  }
  const rect = varCanvas.getBoundingClientRect();
  const column = Math.floor(((event.clientX - rect.left) / rect.width) * measured.columns);
  const gene = geneAtColumn(column, measured.columns, measured.spread.length);
  $('showByte').value = String(gene);
  applyViewMode();      // the DNA-value mode reads showByte, so refresh the view
  draw();
  message(
    `gene ${gene} spread ${measured.spread[gene].toFixed(3)} at tick ${measured.tick} -- the DNA-value view mode shows that byte`,
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
    message(`held at tick ${measured.tick} -- the world keeps running`, false, 'varMsg');
  }
});

// ---------------------------------------------------------------- genome
/**
 * The Genome section: the inherited material, shown two ways.
 *
 *   1. THE SELECTED BUG'S PROGRAM, as a strip. One band per decoded instruction,
 *      its width the bytes it actually occupies -- so a three-byte JMP is wider
 *      than a one-byte NOOP, which is the whole reason this is not a heat map of
 *      bytes. The bands come from genomeStrip(), which reuses the dish's own
 *      decode rather than a second copy of the opcode table.
 *
 *   2. THE POPULATION'S REPERTOIRE: which opcodes exist at all, and what share of
 *      the instruction stream each one is. That is a statement about a language
 *      rather than about a bug -- a world whose population has stopped emitting
 *      arithmetic is visible here and nowhere else.
 *
 * The strip is a picture of ONE sweep from address 0, which is not the same thing
 * as the set of instructions that can execute: a jump can land in the middle of a
 * band. genomeMap.ts's header spells out what that costs and what it does not.
 */
const CLASS_COLOR = {
  control: '#6ee7ff',
  stack: '#3ed6b4',
  memory: '#7ec46b',
  arith: '#e0c46a',
  logic: '#c9a0ff',
  io: '#e0916a',
  other: '#6b7681',
};

/** How many genomes the repertoire is measured over. Enough to describe a
 *  population of hundreds without decoding all of them twice a second. */
const POOL_SAMPLE = 64;

function renderStrip(bug) {
  const host = $('genomeHost');
  const strip = el('div', 'strip');
  const segments = genomeStrip(bug.dna.data);

  for (const segment of segments) {
    const band = el('div', 'b');
    band.style.background = CLASS_COLOR[segment.klass] ?? CLASS_COLOR.other;
    // Width is the instruction's own size, so operands are drawn as part of what
    // they belong to. Nine pixels a byte keeps a one-byte opcode clickable.
    band.style.flex = `0 0 ${segment.length * 9}px`;
    band.dataset.address = String(segment.address);
    band.title = `${segment.name} at ${segment.address}, ${segment.length} byte${segment.length === 1 ? '' : 's'}`
      + ` (${CLASS_LABEL[segment.klass] ?? segment.klass})`
      + (segment.wrapped ? ' -- operands wrap to the start of the genome' : '')
      + ' -- click to read that byte in the DNA-value view';
    strip.append(band);
  }

  host.append(strip);

  // The legend carries counts, not just colours: how much of this program is
  // control flow is the sentence the picture is trying to say.
  const legend = el('div', 'note');
  const totals = new Map();
  for (const segment of segments) {
    totals.set(segment.klass, (totals.get(segment.klass) ?? 0) + segment.length);
  }
  const parts = [];
  for (const klass of CLASS_ORDER) {
    const bytes = totals.get(klass);
    if (bytes === undefined) continue;
    parts.push(`${bytes} ${CLASS_LABEL[klass] ?? klass}`);
  }
  legend.textContent = parts.length === 0 ? 'the genome is empty' : parts.join(' · ');
  host.append(legend);
}

function renderPool() {
  const host = $('genomeHost');
  // The Genome section and the Diversity series want the same measurement, and it
  // reads the whole population's genomes: taken once per tick, shared by both.
  const pool = poolNow();

  host.append(el('div', 'group', 'population repertoire'));
  if (pool.instructions === 0) {
    host.append(el('div', 'dim', 'nothing decoded -- there are no bugs to read'));
    return;
  }

  // The eight commonest opcodes, and "other" as the remainder: a full 60-row list
  // is a spreadsheet, and the tail is what a reader checks last.
  const top = pool.shares.filter((share) => share.count > 0).slice(0, 8);
  const widest = top[0]?.share ?? 1;
  for (const share of top) {
    const row = el('div', 'poolRow');
    row.append(
      el('span', 'nm', share.name),
      (() => {
        const track = el('div', 'bar');
        const fill = el('i');
        fill.style.width = `${Math.max(1, Math.round((share.share / widest) * 100))}%`;
        fill.style.background = CLASS_COLOR[opClass(share.opcode)] ?? CLASS_COLOR.other;
        track.append(fill);
        return track;
      })(),
      el('span', 'pc', `${(share.share * 100).toFixed(1)}%`),
    );
    row.title = `${share.name}: ${share.count} of ${pool.instructions} instructions in the sample`;
    host.append(row);
  }

  const rest = pool.shares.filter((share) => share.count > 0).slice(8);
  const restShare = rest.reduce((sum, share) => sum + share.share, 0);
  if (rest.length > 0) {
    host.append(el('div', 'note', `${rest.length} more opcodes, ${(restShare * 100).toFixed(1)}% between them`));
  }

  host.append(el('div', 'note',
    `${pool.distinct} distinct opcodes over ${pool.bugs} bugs (${pool.instructions} instructions)`
    + ` · evenness ${pool.evenness.toFixed(3)} of 1`
    + ` · genome length ${pool.minLength}..${pool.maxLength}, mean ${pool.meanLength.toFixed(1)} bytes`));
}

/** Redraw the Genome section for the current selection and population. */
function refreshGenome() {
  const host = $('genomeHost');
  host.textContent = '';
  $('genomeHint').hidden = watched !== null;
  if (watched !== null && locateWatched() !== null) renderStrip(watched);
  renderPool();
}

// The strip's bands are clickable, and the section is rebuilt on every refresh, so
// one delegated listener rather than one per band.
$('genomeHost').addEventListener('click', (event) => {
  const band = event.target.closest('.strip .b');
  if (band === null || band.dataset.address === undefined) return;
  const address = Number(band.dataset.address);
  $('showByte').value = String(address);
  applyViewMode();
  draw();
  message(`the DNA-value view mode now reads byte ${address}`, false, 'banner');
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
  refreshBug();       // same cadence as the stats: a live view, not a snapshot
  sampleHistory();

  // Two measurements of the population, both of which read the whole world, and
  // both of which are only worth taking while their section is on screen. The last
  // reading stays in `measured` across a tab switch, so a held chart is still the
  // chart the reader left behind rather than one that blinked out of existence.
  if (activeTab === 'genome') {
    refreshVariance();
    refreshGenome();
  }
}

// ---------------------------------------------------------------- saved worlds
/**
 * Save, load, export, import.
 *
 * Four decisions worth stating, because each one is a way this could have been
 * built and would have been worse:
 *
 *   - storage is `localStorage`, so a saved world belongs to THIS browser and
 *     survives a reload but not a machine. The panel says so, and the export path
 *     exists precisely because of it: a file is the only version that travels.
 *   - saving under a name that already exists is an overwrite, so it asks first.
 *     Loading never asks: it stops the run and says what it loaded, and the world
 *     it replaced was whatever the page had open.
 *   - a listing that cannot read one entry still lists the others (that is the
 *     store's contract, and the test pins it). The row shows the problem and its
 *     Load button is not there, rather than the entry vanishing.
 *   - a failed write reports the store's own sentence, which says what to do. A
 *     silent save and a silent load are indistinguishable until someone loses work,
 *     which is the whole reason the store's errors are written in words.
 */
const storage = (() => {
  try {
    const probe = '__tsbugs_storage_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;   // a browser that refuses storage entirely (some private modes)
  }
})();

function savedMessage(text, bad = false) {
  message(text, bad, 'savedMsg');
}

function kilobytes(chars) {
  return chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)} MB` : `${Math.round(chars / 1024)} KB`;
}

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'world';
}

/** The name box, or the date and time of this save when the box is empty.
 *
 *  A tick number was what this used to fall back to, and it made a poor label: it
 *  says where the world is in its own run rather than when the save was made, so
 *  two different worlds could both be "tick 200" and the list read as a sequence
 *  that had never happened. The collision case is real rather than theoretical --
 *  save, step, save is an ordinary thing to do -- so the second save inside a
 *  second takes a suffix instead of raising the overwrite prompt about a world it
 *  has nothing to do with. */
function worldName() {
  const typed = $('saveName').value.trim();
  if (typed !== '') return typed;
  const taken = (name) => storage !== null && storage.getItem(WORLD_KEY_PREFIX + name) !== null;
  return uniqueWorldName(defaultWorldName(new Date()), taken);
}

function saveCurrent() {
  if (storage === null) {
    savedMessage('this browser will not let the page keep anything -- use Export instead', true);
    return null;
  }
  const name = worldName();
  if (!isValidWorldName(name)) {
    savedMessage(`"${name}" is not a name this store accepts (1..40 characters)`, true);
    return null;
  }
  if (storage.getItem(WORLD_KEY_PREFIX + name) !== null && !window.confirm(`Overwrite "${name}"?`)) {
    savedMessage('nothing saved');
    return null;
  }
  try {
    const saved = saveWorld(storage, name, dish.snapshot());
    // The box is left as the person left it. It used to be filled with the name
    // that was just used, which was right when the name was derived from the world
    // (a second Save meant "write this again"); with a timestamp it would mean the
    // next Save silently replaces the entry it just made, and the date-and-time
    // naming would produce exactly one entry per session. A typed name is still in
    // the box, so re-saving a named world stays one click.
    savedMessage(`saved "${name}" -- tick ${saved.tick}, ${saved.population} bugs, ${kilobytes(saved.storedBytes)}`);
    refreshSaved();
    return saved;
  } catch (error) {
    savedMessage(error.message, true);
    return null;
  }
}

function applySaved(name) {
  if (storage === null) return false;
  stopRunning();
  try {
    const snapshot = loadWorld(storage, name);
    if (snapshot === null) {
      savedMessage(`no saved world called "${name}" -- deleted in another tab?`, true);
      refreshSaved();
      return false;
    }
    adoptDish(PetriDish.restore(snapshot));
    message(`loaded "${name}"`);
    savedMessage(`loaded "${name}" -- tick ${dish.time}, ${dish.population} bugs`);
    return true;
  } catch (error) {
    savedMessage(`"${name}" could not be loaded: ${error.message}`, true);
    return false;
  }
}

function removeSaved(name) {
  if (storage === null) return false;
  if (!window.confirm(`Delete "${name}"?`)) return false;
  const gone = deleteWorld(storage, name);
  savedMessage(gone ? `deleted "${name}"` : `"${name}" was already gone`, !gone);
  refreshSaved();
  return gone;
}

/** The world as a file: the same text the store keeps inside, so the two agree. */
function exportCurrent() {
  const text = encodeWorld(dish.snapshot());
  const filename = `tsbugs-${slug(worldName())}-tick${dish.time}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Not revoked immediately: some browsers have not finished reading the blob when
  // click() returns, and a revoked URL downloads a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  savedMessage(`exported ${filename} -- ${kilobytes(text.length)}`);
}

function importText(text) {
  try {
    const snapshot = decodeWorld(text);
    stopRunning();
    adoptDish(PetriDish.restore(snapshot));
    $('saveName').value = '';
    message(`imported a ${dish.width}x${dish.height} world`, false, 'banner');
    savedMessage(`imported -- tick ${dish.time}, ${dish.population} bugs`);
    return true;
  } catch (error) {
    savedMessage(`not a tsbugs world: ${error.message}`, true);
    return false;
  }
}

/** One row per entry, newest first, with what each one holds. */
function refreshSaved() {
  const host = $('savedList');
  host.textContent = '';

  if (storage === null) {
    savedMessage('this browser will not let the page keep anything -- use Export instead', true);
    return;
  }

  const entries = listWorlds(storage);
  for (const entry of entries) {
    const row = el('div', 'saved');

    const what = el('span', 'what');
    const name = el('b', '', entry.name);
    const detail = el('span', entry.problem !== null ? 'bad' : '',
      // The store's problem strings already name their class ("unreadable: ...",
      // "not a saved world", "incomplete: ..."); a prefix here would diagnose twice.
      entry.problem !== null
        ? entry.problem
        : `tick ${entry.tick} · ${entry.population} bugs · ${kilobytes(entry.storedBytes)}`);
    what.append(name, detail);
    row.append(what);

    if (entry.problem === null) {
      const load = el('button', '', 'Load');
      load.addEventListener('click', () => applySaved(entry.name));
      row.append(load);
    }

    const remove = el('button', '', 'Delete');
    remove.addEventListener('click', () => removeSaved(entry.name));
    row.append(remove);

    host.append(row);
  }

  if (entries.length === 0) {
    savedMessage('nothing saved yet -- Save keeps a world in this browser, Export gives you a file');
  } else {
    savedMessage(`${entries.length} saved, ${kilobytes(storageUsed(storage))} of this browser's storage`);
  }
}

function stopRunning() {
  running = false;
  $('run').textContent = 'Run';
}

// Another tab's write is not visible to this one until something re-reads it, and
// a list that silently disagrees with the store is how someone saves over a world
// they were told did not exist.
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key.startsWith(WORLD_KEY_PREFIX)) refreshSaved();
});

$('save').addEventListener('click', saveCurrent);
$('export').addEventListener('click', exportCurrent);
$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files?.[0];
  if (!file) return;
  try {
    importText(await file.text());
  } catch (error) {
    savedMessage(`could not read the file: ${error.message}`, true);
  } finally {
    $('importFile').value = '';   // so choosing the same file twice fires again
  }
});

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
// in-browser run is checked against the same seed under Node. The section and
// layout handles exist for the same reason -- a probe that can only read the
// Params panel cannot check what the Bug panel says.
window.__tsbugs = {
  dish: () => dish,
  view: ViewMode,
  stop: stopRunning,
  /** Rebuild from the control values, so a check starts from a stated world
   *  rather than from however far the page happened to have run. */
  newWorld() { stopRunning(); buildWorld(); return fingerprint(dish); },
  /** A scripted Step, behaving exactly like the Step button -- including the stats
   *  refresh, so a probe cannot read a chart describing the state before the step. */
  step(n = 1) {
    for (let i = 0; i < n; i++) dish.step();
    draw();
    stats(performance.now(), true);
    return this.hash();
  },
  /** The saved-world paths, exposed as the buttons use them rather than as a
   *  parallel implementation: a probe that saves and loads is testing the page. */
  save(name) {
    if (name !== undefined) $('saveName').value = name;
    const saved = saveCurrent();
    return saved === null ? null : { name: saved.name, tick: saved.tick, bytes: saved.storedBytes };
  },
  load(name) { return applySaved(name) ? this.hash() : null; },
  remove(name) { return removeSaved(name); },
  saved: () => listWorlds(storage).map((entry) => ({ ...entry })),
  /** Re-render the list. Exposed because a probe that writes a corrupt entry
   *  needs the panel's own view of it, and the buttons are what a person sees. */
  refreshSaved,
  exportText: () => encodeWorld(dish.snapshot()),
  importText(text) { return importText(text) ? this.hash() : null; },
  /** Shared with Node, so a browser run and a headless run are comparable. */
  hash: () => fingerprint(dish),

  /** The rail as a probe sees it: which section is showing, and what is in it. */
  tab(name) {
    if (name === undefined) return activeTab;
    showTab(name);
    return activeTab;
  },
  layout(name) {
    if (name === undefined) return document.body.dataset.layout;
    showLayout(name);
    return document.body.dataset.layout;
  },
  /** Select the bug at a cell, the way a click does -- including the pause, so a
   *  probe can read the same still world a person would be reading. */
  select(x, y) {
    selectBug(x * dish.height + y);
    return this.watched();
  },
  /** Everything the Bug section claims about the selected bug, read back through
   *  the same readers the panel uses. */
  watched() {
    if (watched === null) return null;
    const hash = locateWatched();
    if (hash === null) return { gone: true, diedAt: watchedDied };
    const regs = registersOf(watched.processor);
    const senses = sensesOf(watched.processor);
    const decided = decisionOf(watched.processor);
    return {
      hash,
      cell: { x: Math.trunc(hash / dish.height), y: hash % dish.height },
      registers: regs,
      energy: watched.energy,
      age: watched.age,
      generation: watched.generation,
      children: watched.children,
      genome: watched.dna.data.length,
      vision: senses.vision,
      senseEnergy: senses.energy,
      decision: { dir: decided.dir, move: decided.move, colour: decided.colour, splits: decided.splits },
      ipRow: instructionIndexAt(bugView?.listing ?? [], regs.ip),
      rows: bugView?.rows.length ?? 0,
      cursor: bugView?.at ?? -1,
    };
  },
  /** What the Genome section is showing: the strip's bands, and the repertoire. */
  genome() {
    if (watched === null) return null;
    const hash = locateWatched();
    if (hash === null) return null;
    const strip = genomeStrip(watched.dna.data);
    const genomes = [];
    dish.forEachBug((bug) => genomes.push(bug.dna.data));
    const pool = genePool(genomes, POOL_SAMPLE);
    return {
      bands: strip.map((segment) => ({ ...segment })),
      covered: strip.reduce((sum, segment) => sum + segment.length, 0),
      pool: { bugs: pool.bugs, instructions: pool.instructions, distinct: pool.distinct, evenness: pool.evenness },
    };
  },
  /** What the chart is claiming, or null when it is holding nothing valid. */
  measured: () => (measured === null ? null : { world: measured.world, tick: measured.tick, columns: measured.columns }),
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


// ---------------------------------------------------------------- parameters
/**
 * The world-parameter panel, built from the model rather than written out here.
 *
 * The field list is the model's own key list, so a new parameter appears without
 * anyone remembering to edit this file; the group each control sits in is
 * discovered by asking setParams (see src/ui/paramPanel.ts), so a control cannot
 * claim to be live when the simulation only reads it at construction time. Every
 * change is followed by renderParams(), which re-reads dish.worldParams -- a
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

    host.append(
      el('div', 'group', GROUP_TITLES[group]),
      el('div', 'note', GROUP_NOTES[group]),
    );
    for (const key of keys) host.append(paramRow(key, params[key]));
  }
}

/**
 * What a control needs so the browser and a password manager leave it alone.
 *
 * Chrome reports "form field should have an id or name attribute" for a control
 * with neither, and LastPass does not wait for a name: it decides for itself that
 * a field is an account field and injects its icon inside it, which is what put a
 * second control in the mutation rate box. The id and name are the browser's
 * request answered honestly; the attributes below are each manager's own opt-out
 * (LastPass, 1Password, Bitwarden, Dashlane), and none of them changes behaviour
 * anywhere that is not a password manager. `autocomplete="off"` is the fourth
 * layer and the weakest, which is why it is not the only one.
 */
const AUTOFILL_OPTOUT = [
  ['autocomplete', 'off'],
  ['data-lpignore', 'true'],
  ['data-1p-ignore', ''],
  ['data-bwignore', ''],
  ['data-form-type', 'other'],
];

function nameControl(control, key, suffix = '') {
  control.id = `param-${key}${suffix}`;
  control.name = key;
  for (const [attribute, value] of AUTOFILL_OPTOUT) control.setAttribute(attribute, value);
  return control;
}

function paramRow(key, value) {
  const row = el('div', 'row');
  const name = el('span', '', label(key));
  name.title = key;
  row.append(name);

  let control;
  if (key === 'energyLayout') {
    control = document.createElement('select');
    for (const [text, option] of ENERGY_LAYOUTS) {
      const item = document.createElement('option');
      item.value = String(option);
      item.textContent = text;
      control.append(item);
    }
    control.value = String(value);
  } else if (key === 'killOnEdge') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = value === true;
  } else if (key === 'mutation') {
    // Two controls, because the slider cannot say the value: it quantises, so the
    // slider is how a rate is reached and the box is what states one
    // (mutationScale.ts). Neither reads its own output back -- that is what would
    // rewrite a typed 0.1234 into the slider's nearest grid point.
    const { slider, box, note } = mutationControls(value);
    const cell = el('span', 'rate');
    cell.append(slider, box);
    row.append(cell);

    // The reading is on its own line, under the whole row, rather than inside the
    // cell with the controls. In the cell it was as wide as its own sentence, and
    // the row is `space-between`, so every change of reading dragged the slider
    // left or right: the control moved while it was being dragged.
    const wrap = el('div', 'param');
    wrap.append(row, note);
    return wrap;
  } else {
    control = document.createElement('input');
    control.type = 'number';
    control.step = '1';
    // No min/max: upstream's dialog had validators, not ranges, and the
    // simulation is the thing that has to refuse a range it cannot use.
    control.value = String(value);
    control.size = 8;
  }

  nameControl(control, key);
  control.dataset.key = key;
  control.addEventListener('change', () => applyParam(key, control));

  const cell = el('span');
  cell.append(control);
  row.append(cell);
  return row;
}

/**
 * The mutation rate's slider, its exact box, and the line that says what the rate
 * means -- "1 birth in 8,333 is mutated" is the form the number is reasoned about
 * in, and it is what makes a fine adjustment visible while dragging.
 *
 * The slider is two-section: geometric from 1e-4 to 0.1, then linear to 1, because
 * a mutation rate spans four orders of magnitude and a linear slider spends 99.9%
 * of its travel above 0.1, which is not where anyone works.
 */
function mutationControls(rate) {
  const slider = nameControl(document.createElement('input'), 'mutation', '-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(SLIDER_MAX);
  slider.step = '1';
  const position = sliderPosition(rate);
  slider.value = String(position ?? 0);
  slider.disabled = position === null;
  slider.title = position === null
    ? `${rate} is not a rate this slider can hold -- use the box`
    : 'drag to a rate; the box is what states one exactly';

  const box = nameControl(document.createElement('input'), 'mutation');
  box.type = 'number';
  box.min = '0';
  box.step = 'any';
  box.value = String(rate);
  box.size = 8;
  box.title = 'the rate exactly -- any value, including ones the slider cannot reach';

  // The number leads and is printed exactly as it stands, because this line sits
  // beside the box the reader typed into: a rate printed to four figures while the
  // world held six would be the panel disagreeing with itself.
  const note = el('div', 'rateNote', summariseRate(rate));
  // The line is clipped to one line so its height cannot change with its wording;
  // the whole sentence stays reachable, since the part that gets trimmed is the
  // explanation, never the number.
  note.title = note.textContent;

  // `input` while dragging, so the reading follows the thumb; `change` once, on
  // release, so one drag is one write to the world rather than a hundred. The
  // title follows the text, so the sentence this line clips is still readable.
  slider.addEventListener('input', () => {
    note.textContent = summariseRate(sliderToRate(Number(slider.value)));
    note.title = note.textContent;
  });
  slider.addEventListener('change', () => applyMutation(sliderToRate(Number(slider.value))));

  box.addEventListener('change', () => {
    const text = String(box.value).trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) {
      message('mutation needs a number -- nothing changed', true);
      renderParams();
      return;
    }
    if (value < 0 || value > 1) {
      // A rate is the share of births that mutate, so the range is the definition
      // rather than a limit: 2 is not a fast mutation rate, it is a typo.
      message(`mutation runs from 0 to 1 -- ${value} is not a share of births, so nothing changed`, true);
      renderParams();
      return;
    }
    applyMutation(value);
  });

  return { slider, box, note };
}

function applyMutation(rate) {
  const update = dish.setParams({ mutation: rate });
  const reading = summariseRate(rate);
  if (update.refused.length > 0) {
    message(`refused: ${update.refused.join('; ')} -- nothing changed`, true);
  } else if (update.ignored.includes('mutation')) {
    message(`mutation = ${reading}, but only a new world reads it -- rebuild to apply`, true);
  } else if (update.deferred.includes('mutation')) {
    message(`mutation = ${reading}; bugs born from now on are built with it`);
  } else {
    message(`mutation = ${reading} -- live on the next tick`);
  }
  renderParams();
  applyViewMode();
  draw();
}

function applyParam(key, control) {
  const raw = control.type === 'checkbox' ? null : String(control.value).trim();
  const value = control.type === 'checkbox'
    ? control.checked
    : key === 'energyLayout' ? Number(control.value) : Number(raw);

  if (control.type !== 'checkbox' && (raw === '' || !Number.isFinite(value))) {
    message(`${label(key)} needs a number -- nothing changed`, true);
    renderParams();
    return;
  }

  const update = dish.setParams({ [key]: value });
  const shown = key === 'energyLayout' ? ENERGY_LAYOUTS.find(([, v]) => v === value)?.[0] ?? value : value;

  if (update.refused.length > 0) {
    message(`refused: ${update.refused.join('; ')} -- nothing changed`, true);
  } else if (update.ignored.includes(key)) {
    message(`${label(key)} = ${shown}, but only a new world reads it -- rebuild to apply`, true);
  } else if (update.deferred.includes(key)) {
    message(`${label(key)} = ${shown}; bugs born from now on are built with it`);
  } else {
    message(`${label(key)} = ${shown} -- live on the next tick`);
  }

  renderParams();
  applyViewMode();   // the energy view scales by min/max energy, so refresh it
  draw();
}

// ---------------------------------------------------------------- history
/**
 * The chart along the bottom of the stage: one series at a time, sampled as the
 * world runs.
 *
 * Three decisions here.
 *
 *   - The SVG's viewBox is set from the element's own pixel size on every draw, so
 *     one unit is one pixel and the axis text is not stretched. The alternative --
 *     a fixed viewBox with `preserveAspectRatio="none"`, which is what the markup
 *     declares -- scales x and y by different factors, which is right for the curve
 *     and wrong for every glyph on it.
 *   - A sample is taken only when the world has actually moved, so pausing for ten
 *     minutes does not fill the buffer with the same reading repeated. History is
 *     of the world, not of the wall clock.
 *   - Diversity is the expensive series -- it reads a sample of the population's
 *     genomes -- so it is measured once per sample and cached, and the Genome
 *     section's repertoire uses the same measurement rather than taking its own.
 */
const HISTORY_MAX = 600;      // 500 ms per sample: five minutes of run

/** samples: { tick, population, generation, evenness, bugEnergy } */
let history = [];
let poolCache = null;         // { world, tick, pool }

/** The population's repertoire at this instant, measured at most once per tick. */
function poolNow() {
  if (poolCache !== null && poolCache.world === worldSerial && poolCache.tick === dish.time) {
    return poolCache.pool;
  }
  const genomes = [];
  dish.forEachBug((bug) => genomes.push(bug.dna.data));
  const pool = genePool(genomes, POOL_SAMPLE);
  poolCache = { world: worldSerial, tick: dish.time, pool };
  return pool;
}

const SERIES = {
  population: { label: 'population', read: () => dish.population, format: (v) => String(v) },
  generation: { label: 'highest generation', read: () => dish.maxGen, format: (v) => String(v) },
  evenness: { label: 'opcode evenness', read: () => poolNow().evenness, format: (v) => v.toFixed(3) },
  bugEnergy: { label: 'bug energy', read: () => dish.bugEnergy, format: (v) => String(v) },
};

let series = 'population';

function sampleHistory() {
  const last = history[history.length - 1];
  if (last !== undefined && last.tick === dish.time) return;   // paused, or nothing ran
  history.push({
    tick: dish.time,
    population: dish.population,
    generation: dish.maxGen,
    evenness: poolNow().evenness,
    bugEnergy: dish.bugEnergy,
  });
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  drawChart();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, className) => {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
};

/** The chart's own geometry, in the SVG's units, which are CSS pixels here. */
function chartBox() {
  const width = Math.max(1, Math.round(chart.clientWidth));
  const height = Math.max(1, Math.round(chart.clientHeight));
  return { width, height, left: 2, right: width - 44, top: 9, bottom: height - 14 };
}

function drawChart() {
  const { width, height } = chartBox();
  if (chart.getAttribute('viewBox') !== `0 0 ${width} ${height}`) {
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  const box = chartBox();
  const plotW = Math.max(1, box.right - box.left);
  const plotH = Math.max(1, box.bottom - box.top);

  const definition = SERIES[series] ?? SERIES.population;
  $('chartNowLabel').textContent = definition.label;
  $('chartNowValue').textContent = definition.format(definition.read());

  const grid = chart.querySelector('.grid');
  const axis = chart.querySelector('.axis');
  const area = chart.querySelector('.area');
  const line = chart.querySelector('.line');
  const cursor = chart.querySelector('.cursor');
  grid.textContent = '';
  axis.textContent = '';
  cursor.setAttribute('hidden', '');
  area.setAttribute('d', '');
  line.setAttribute('d', '');

  const values = history.map((sample) => sample[series]).filter((v) => typeof v === 'number' && Number.isFinite(v));

  if (history.length < 2 || values.length < 2) {
    // A line needs two points. Saying so beats a flat line at zero, which is what
    // an empty series and a world at zero would otherwise have in common.
    const note = svgEl('text', 'empty');
    note.setAttribute('x', String(box.left + 2));
    note.setAttribute('y', String(box.top + 12));
    note.textContent = history.length === 0 ? 'collecting history -- the chart fills as the world runs' : 'one sample so far';
    axis.append(note);
    chartState.geometry = null;
    return;
  }

  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  // A series that never moves still has to be drawn somewhere sensible: give it a
  // band rather than dividing by a zero range.
  if (high - low < 1e-9) {
    const pad = Math.abs(high) > 0 ? Math.abs(high) * 0.1 : 1;
    low -= pad;
    high += pad;
  }

  const xAt = (i) => box.left + (history.length === 1 ? 0 : (i / (history.length - 1)) * plotW);
  const yAt = (v) => box.bottom - ((v - low) / (high - low)) * plotH;
  const point = (v, i) => `${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`;

  // Grid: three levels, so the eye has a reference without a lattice.
  for (let i = 0; i <= 2; i++) {
    const v = low + ((high - low) * i) / 2;
    const row = svgEl('line');
    row.setAttribute('x1', String(box.left));
    row.setAttribute('x2', String(box.right));
    row.setAttribute('y1', yAt(v).toFixed(2));
    row.setAttribute('y2', yAt(v).toFixed(2));
    grid.append(row);
  }

  const points = [];
  history.forEach((sample, i) => {
    const v = sample[series];
    if (typeof v === 'number' && Number.isFinite(v)) points.push({ i, v });
  });

  const path = points.map((p, n) => `${n === 0 ? 'M' : 'L'}${point(p.v, p.i)}`).join(' ');
  line.setAttribute('d', path);
  const first = points[0];
  const last = points[points.length - 1];
  area.setAttribute('d',
    `${path} L${xAt(last.i).toFixed(2)} ${box.bottom} L${xAt(first.i).toFixed(2)} ${box.bottom} Z`);

  // Two labels only: the top of the band and its floor. A full scale along the y
  // axis is more ink than a 108-pixel strip can carry, and the cursor reports the
  // value under the pointer precisely.
  const topLabel = svgEl('text');
  topLabel.setAttribute('x', String(box.right + 4));
  topLabel.setAttribute('y', String(box.top + 4));
  topLabel.textContent = definition.format(high);
  const lowLabel = svgEl('text');
  lowLabel.setAttribute('x', String(box.right + 4));
  lowLabel.setAttribute('y', String(box.bottom + 4));
  lowLabel.textContent = definition.format(low);
  axis.append(topLabel, lowLabel);

  const span = history[history.length - 1].tick - history[0].tick;
  const spanLabel = svgEl('text');
  spanLabel.setAttribute('x', String(box.left));
  spanLabel.setAttribute('y', String(height - 3));
  spanLabel.textContent = `${span} ticks`;
  axis.append(spanLabel);

  chartState.geometry = { box, low, high, xAt, points };
}

/** What the pointer is over, kept so the next layout draw can put the cursor back. */
let chartState = { geometry: null };

function chartCursor(event) {
  const geometry = chartState.geometry;
  const cursor = chart.querySelector('.cursor');
  if (geometry === null) {
    cursor.setAttribute('hidden', '');
    return;
  }
  const rect = chart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { box, xAt, points } = geometry;

  let best = points[0];
  for (const p of points) {
    if (Math.abs(xAt(p.i) - x) < Math.abs(xAt(best.i) - x)) best = p;
  }

  const px = xAt(best.i);
  const py = geometry.box.bottom - ((best.v - geometry.low) / (geometry.high - geometry.low))
    * (geometry.box.bottom - geometry.box.top);
  const lineEl = cursor.querySelector('line');
  const dot = cursor.querySelector('circle');
  const text = cursor.querySelector('text');
  lineEl.setAttribute('x1', px.toFixed(2));
  lineEl.setAttribute('x2', px.toFixed(2));
  lineEl.setAttribute('y1', String(box.top));
  lineEl.setAttribute('y2', String(box.bottom));
  dot.setAttribute('cx', px.toFixed(2));
  dot.setAttribute('cy', py.toFixed(2));
  // The label goes on the side of the line with room for it, so it never runs off
  // the right edge on the newest sample -- which is the one people hover.
  const flip = px > box.left + (box.right - box.left) * 0.7;
  text.setAttribute('x', (flip ? px - 4 : px + 5).toFixed(2));
  text.setAttribute('y', String(box.top + 9));
  text.setAttribute('text-anchor', flip ? 'end' : 'start');
  text.textContent = `${(SERIES[series] ?? SERIES.population).format(best.v)} @ ${history[best.i].tick}`;
  cursor.removeAttribute('hidden');
}

const chart = $('chart');
chart.addEventListener('pointermove', chartCursor);
chart.addEventListener('pointerleave', () => chart.querySelector('.cursor').setAttribute('hidden', ''));

for (const button of document.querySelectorAll('#chartTabs button')) {
  button.addEventListener('click', () => {
    series = button.dataset.series;
    for (const other of document.querySelectorAll('#chartTabs button')) {
      other.setAttribute('aria-selected', other === button ? 'true' : 'false');
    }
    drawChart();
  });
}

// ---------------------------------------------------------------- start
// Last, so every top-level binding above has been evaluated. This block used to
// sit mid-file, and `currentDish` (declared further down) was in its temporal dead
// zone when buildWorld() reached for it: the page threw before showing a single
// section, and the symptom was a blank tab body rather than an error anyone saw.
// A module body runs top to bottom, so "start" belongs at the bottom.
renderPresets();
$('speedVal').textContent = $('speed').value;
buildWorld();
refreshSaved();

// The layout and section last used. Read through the same probe the save path uses:
// a browser that refuses storage must not stop the page here.
function remembered(key, fallback) {
  try {
    return storage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

showLayout(remembered(LAYOUT_KEY, 'split'));
showTab(remembered(TAB_KEY, 'params'));
requestAnimationFrame(frame);
