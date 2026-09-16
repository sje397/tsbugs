/**
 * The single-file page: what it emits, and the two builds it refuses.
 *
 * `web/build-single.mjs` is a dozen lines of assembly and two guards, and the
 * guards are the only reason it exists as a function rather than a shell
 * one-liner: a page that fails them works on the machine that built it and
 * nowhere else, which is not a failure that shows up in the builder's output.
 * Both refusals are exercised here, and so is the case they must *not* refuse —
 * prose citing a relative path, which this codebase is full of.
 *
 * The end-to-end claim (the emitted file opens from `file://` and reproduces the
 * Node fingerprint) needs a browser and is measured in `web/README.md`, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The builder is plain ESM beside the page it builds, so it is reached by path
// rather than compiled into dist/test; the URL is relative to this module's
// location (dist/test/) at runtime, which is where the two directories differ.
const { inlineIntoShell, hasRelativeImport, SCRIPT_TAG } = (await import(
  new URL('../../web/build-single.mjs', import.meta.url).href
)) as {
  inlineIntoShell: (a: { shell: string; js: string; revision: string; files: string[] }) => {
    html: string;
    banner: string;
  };
  hasRelativeImport: (js: string) => boolean;
  SCRIPT_TAG: string;
};

const revision = 'abc1234';
const files = ['web/app.mjs', 'src/sim/dish.js'];

const emit = (over: Partial<{ shell: string; js: string }> = {}) =>
  inlineIntoShell({
    shell: `<body>${SCRIPT_TAG}<footer>Port of QtBugs @ fb3e2d4.</footer></body>`,
    js: 'const x = 1;\n',
    revision,
    files,
    ...over,
  });

test('the built page is self-contained and says where it came from', () => {
  const { html, banner } = emit();

  // The module script tag is gone: nothing is fetched, so nothing can go stale.
  assert.ok(!html.includes(SCRIPT_TAG), 'the external module script tag should be replaced');
  assert.ok(html.includes('<script type="module">'), 'the bundle should be inlined as a module');
  assert.ok(html.includes('const x = 1;'), 'the bundle body should be in the page');

  // Provenance, in the artefact rather than only in the build log: a file someone
  // copies elsewhere can still be traced to a commit.
  assert.ok(banner.includes(`"${revision}"`), 'the banner should name the revision');
  assert.ok(html.includes(`window.__tsbugsBuild = `), 'the page should carry its build info');
  assert.ok(html.includes(`built from ${revision}`), 'the footer should name the revision too');

  // The banner is the *first* thing in the module, so the revision is set before
  // any simulation code runs.
  assert.ok(
    html.indexOf('window.__tsbugsBuild') < html.indexOf('const x = 1;'),
    'build info should be assigned before the bundle body',
  );
});

test('a shell that no longer loads the app as a module is refused, not built', () => {
  // The failure this catches: the shell is edited (script moved, attribute
  // changed) and the builder silently emits a page with no simulation in it.
  // Nothing downstream would notice — the file still opens.
  assert.throws(
    () => emit({ shell: '<body><script src="./app.mjs"></script></body>' }),
    /no longer loads web\/app\.mjs as a module script/,
  );
});

test('a bundle that still imports a relative path is refused', () => {
  for (const js of [
    `import { a } from './other.js';\n`,
    `export { a } from '../src/sim/dish.js';\n`,
    `const m = await import('./lazy.js');\n`,
  ]) {
    assert.throws(() => emit({ js }), /still imports a relative path/, `accepted: ${js.trim()}`);
  }
});

test('the relative-import guard reads code, not prose', () => {
  // Both directions, because a guard that fires on everything is as useless as one
  // that fires on nothing. Comments citing paths are everywhere in this repo; a
  // bundler-level bare specifier is not a missing file (esbuild inlined it).
  // Prose and real imports, at the same shape: each pair differs only in whether
  // the relative path is code. Stated as a quote *and* a path, because anything
  // looser passes whether or not comments are stripped — which is how the first
  // version of this test passed against a guard that read raw text.
  assert.equal(hasRelativeImport(`// re-exported from './app.mjs'\nconst x = 1;\n`), false);
  assert.equal(hasRelativeImport(`/* re-exported from "./app.mjs" */\nconst x = 1;\n`), false);
  assert.equal(
    hasRelativeImport(`const u = 'https://example.com/'; // see from './x.js'\n`),
    false,
  );
  assert.equal(hasRelativeImport(`import { createHash } from 'node:crypto';\n`), false);
  assert.equal(hasRelativeImport(`import { a } from './a.js';\n`), true);
  assert.equal(hasRelativeImport(`export { a } from "../src/sim/dish.js";\n`), true);
  assert.equal(hasRelativeImport(`await import('./lazy.js');\n`), true);
});
