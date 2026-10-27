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

test('the empty inspector asks for a click only when there is something to click', () => {
  // A world from New World holds no bugs: they are created by `balance()`, which
  // runs in the step phase, so the dish is blank until the world has ticked. The
  // prompt it landed with -- "click a bug in the dish" -- was advice that could not
  // be taken, and nothing on screen said why, so the text is now chosen from the
  // world's own counters.
  //
  // This is a structural check, not a behavioural one: `app.mjs` runs in a browser
  // and cannot be imported here. What it pins is that the choice still EXISTS --
  // the realistic regression is someone collapsing three branches back into the one
  // unconditional prompt, which no other test in this file would notice.
  const fn = /function emptyInspectorText\(\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(fn !== null, 'app.mjs should choose the empty inspector text from the world');
  const body = fn[1];

  assert.match(body, /dish\.population/, 'the text should depend on whether the world holds bugs');
  assert.match(body, /dish\.time/, 'and on whether the world has ticked, which is why it is empty');

  // The prompt that exists is the one that says there is something to click, and it
  // must be the guarded branch rather than the fallback: a version whose last line
  // was the click prompt would tell a reader to click an empty dish.
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  assert.match(lines[0], /dish\.population > 0/, 'the click prompt should be the population>0 case');
  assert.match(lines[0], /click a bug in the dish/, 'and that is the string it should return');
  assert.match(lines[lines.length - 1], /return /, 'the last case must also return a sentence, not fall through');
});

test('the empty prompt is kept true while it is on screen, and only while', () => {
  // Choosing the text is half of it: the world changes underneath the panel. Press
  // Step on a fresh world and it fills with bugs, so a prompt written at tick 0 is
  // stale by the next refresh -- and it was, which a browser check found after the
  // first version of this fix looked finished.
  //
  // The other half is knowing when NOT to rewrite it: the inspector also reports a
  // bug that died and a click that found nothing, and those are reports about a
  // moment rather than statements about the world. Rewriting one of those into
  // "click a bug in the dish" would erase what the reader was told.
  const refresh = /function refreshEmptyInspector\(\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(refresh !== null, 'app.mjs should keep the empty prompt in step with the world');
  assert.match(refresh[1], /if \(!inspectorEmpty\) return;/, 'it must only rewrite while the empty prompt is showing');
  assert.match(refresh[1], /emptyInspectorText\(\) === bugInfoText/, 'and only when the text would actually change');

  const show = /function showBugInfo\(text\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(show !== null, 'showBugInfo should still be the single writer of the panel');
  assert.match(show[1], /inspectorEmpty = false;/, 'every other message must clear the empty flag, or a death report gets overwritten');

  const rb = /function refreshBug\(\) \{([\s\S]*?)\n\}/.exec(js);
  assert.ok(rb !== null, 'refreshBug should exist');
  const nothingWatched = /if \(watched === null\) \{([\s\S]*?)\n  \}/.exec(rb[1]);
  assert.ok(nothingWatched !== null, 'refreshBug should branch on there being no selection');
  assert.match(nothingWatched[1], /refreshEmptyInspector\(\)/, 'and that is where the empty prompt gets refreshed');
});
