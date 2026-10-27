/**
 * The page's own wiring: the ids it looks up, and the tabs it switches between.
 *
 * `web/app.mjs` is not type-checked against `web/index.html` — it reaches into the
 * document by id at runtime, and `$` throws on a missing one, which is a failure
 * that appears when a reader opens the page rather than when the suite runs. So
 * this file reads both as text and checks the agreement between them.
 *
 * It is deliberately about STRUCTURE rather than appearance. Nothing here says a
 * control should be 78px wide or that the tabs are in the right order; those are
 * judged by looking. What it pins is the class of breakage a restructure causes
 * silently: a control that moved into a section nobody can reach, an id that
 * survived in the script and not in the page, or two elements claiming one id
 * (which `document.getElementById` resolves by picking the first, quietly).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string): string =>
  readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

const html = read('index.html');
const js = read('app.mjs');

const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

/** Every id the page script asks the document for, through the `$` helper. */
const lookedUp = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))].sort();

/**
 * Ids the page builds at runtime, so their absence from index.html is correct.
 *
 * `dis` is the code listing, created when a bug is selected. Anything not listed
 * here and not in the document is a lookup that throws the moment it is reached,
 * which is why the list is short and says why each entry is on it.
 */
const BUILT_AT_RUNTIME = new Set(['dis']);

test('every id the script looks up exists in the page', () => {
  const missing = lookedUp.filter((id) => !htmlIds.includes(id) && !BUILT_AT_RUNTIME.has(id));
  assert.deepEqual(missing, [], `app.mjs looks up ids that index.html does not define: ${missing.join(', ')}`);
});

test('no two elements share an id', () => {
  const seen = new Set<string>();
  const repeated = htmlIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(repeated, [], `duplicate ids: ${[...new Set(repeated)].join(', ')}`);
});

test('every runtime-built id is actually built', () => {
  // The allowlist above is a claim about the script; this checks the claim still
  // holds, so an id cannot be excused from the document after the code that
  // creates it was deleted.
  for (const id of BUILT_AT_RUNTIME) {
    assert.match(js, new RegExp(`\\.id = '${id}'|id="\\$\\{`), `nothing in app.mjs creates #${id}`);
  }
});

/** The tab buttons, in document order, and the sections they switch between. */
const tabButtons = [...html.matchAll(/<button[^>]*data-tab="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const tabSections = [...html.matchAll(/<section[^>]*data-tab="([^"]+)"[^>]*>/g)].map((m) => m[1]);

test('the tab bar and the sections name the same tabs, in the same order', () => {
  assert.ok(tabButtons.length > 1, 'the page should have more than one tab');
  assert.deepEqual(tabSections, tabButtons);

  // The script's own list is what `showTab` validates against: a name it does not
  // hold falls back to Params, so a tab the page offers and the script does not
  // know would look like a button that does nothing.
  const declared = /const TABS = \[([^\]]+)\]/.exec(js);
  assert.ok(declared !== null, 'app.mjs should declare its tab list');
  const names = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), [...tabButtons].sort());
});

test('every tab section starts hidden, so no section flashes before the script picks one', () => {
  // The script shows the saved tab at the end of init. A section without `hidden`
  // renders in the meantime, which would put four sections on screen for a frame
  // and then collapse three of them — visible as a page that jumps on load.
  const sections = html.match(/<section[^>]*data-tab="[^"]+"[^>]*>/g) ?? [];
  assert.equal(sections.length, tabButtons.length);
  const unguarded = sections.filter((tag) => !/\shidden(\s|>)/.test(tag));
  assert.deepEqual(unguarded, [], 'a section can render before a tab is chosen');
});

test('every input has an id, and every typed one refuses autofill', () => {
  // Chrome reports "form field should have an id or name attribute" for one with
  // neither, and a password manager does not wait for a name before injecting its
  // own icon into the control. Every input the page writes out by hand is checked
  // here; the ones it builds at runtime go through `nameControl` instead, which a
  // browser check covers because it needs a DOM.
  //
  // The opt-out is required of the types a manager might claim, not of checkboxes
  // and sliders: uniformity is not the point, being left alone is.
  const typed = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/\shidden(\s|>)/.test(tag));
  assert.ok(inputs.length > 0, 'the page should have inputs to check');

  for (const tag of inputs) {
    assert.match(tag, /\sid="/, `input without an id: ${tag}`);
    const type = /\stype="([^"]+)"/.exec(tag)?.[1] ?? 'text';
    if (typed.has(type)) assert.match(tag, /data-lpignore/, `input without the autofill opt-out: ${tag}`);
  }
});
