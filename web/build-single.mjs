/**
 * Build the page into one HTML file that opens by double-click, with no server.
 *
 * The served page (`npm run web`) imports the compiled simulation over six
 * requests and therefore needs the repository at a fixed path on an HTTP origin.
 * That is right for development and wrong for the two things this file is for: a
 * copy that can be opened from anywhere, and a page with nothing to go stale —
 * no cache, no relative path, no second copy of a module.
 *
 * What this does NOT do is transpile the simulation. `tsc` has already run (the
 * npm script runs it first) and the bundle is those compiled modules, exactly as
 * the tests and the Node benchmark run them; esbuild only follows the imports and
 * concatenates. It does not minify either: this is a reference implementation and
 * a file someone may want to read.
 *
 * The page is assembled by `inlineIntoShell()`, which is pure and tested
 * (`test/web-single.test.ts`) — including both of its refusal cases, since a guard
 * that has never fired proves nothing. The command below is the esbuild call and
 * the file I/O around it.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRY = 'web/app.mjs';
export const SHELL = 'web/index.html';
export const OUT = 'dist/tsbugs.html';
export const SCRIPT_TAG = '<script type="module" src="./app.mjs"></script>';
const FOOTER_ANCHOR = 'Port of QtBugs @ fb3e2d4.';

/**
 * Does this bundle still need a file next to it?
 *
 * Comments are stripped first, and that direction matters: this codebase's prose
 * cites source paths freely ("see ../src/sim/dish.ts"), so a check over the raw
 * text would refuse good builds. Stripping cannot hide a real import — it only
 * removes text — so the guard stays strict about what it is strict about, and a
 * refusal (loud, at build time) remains the safe direction for anything ambiguous.
 */
export function hasRelativeImport(js) {
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return /\bfrom\s*["']\.\.?\//.test(code) || /\bimport\s*\(\s*["']\.\.?\//.test(code);
}

/**
 * Assemble the single file from the page shell and the bundle.
/**
 * Assemble the single file from the page shell and the bundle.
 *
 * Pure: same arguments, same bytes out. Both refusals are here rather than in the
 * command because they are properties of the *page*, and a page that fails them
 * is one that works on the machine that built it and nowhere else.
 */
export function inlineIntoShell({ shell, js, revision, files }) {
  if (!shell.includes(SCRIPT_TAG)) {
    throw new Error(`${SHELL} no longer loads ${ENTRY} as a module script — update this builder`);
  }
  // A surviving relative import means a `file://` page that silently needs the
  // repository after all. Invisible until someone opens the file somewhere else.
  if (hasRelativeImport(js)) {
    throw new Error('bundle still imports a relative path; it would not run from file://');
  }

  // Provenance in the artefact itself: the revision, and what went into it. Read
  // back from the page, so "the bundle ran" is proven rather than inferred from
  // the fact that a page rendered.
  const banner = [
    `// single-file build of ${revision} — ${files.length} modules inlined, no imports left.`,
    `window.__tsbugsBuild = ${JSON.stringify({ revision, modules: files.length, files })};`,
  ].join('\n');

  return {
    html: shell
      .replace(SCRIPT_TAG, `<script type="module">\n${banner}\n${js}</script>`)
      .replace(FOOTER_ANCHOR, `${FOOTER_ANCHOR} Single file, built from ${revision}.`),
    banner,
  };
}

/** The commit this file was built from — suffixed when the tree has uncommitted
 *  work, because a revision that cannot be checked out is not a revision. */
function revisionOf(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = git(['rev-parse', '--short', 'HEAD']);
  return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`;
}

/** Bundle `web/app.mjs` and everything it imports into one script. */
export async function bundle(root) {
  const result = await build({
    entryPoints: [path.join(root, ENTRY)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  return {
    js: result.outputFiles[0].text,
    files: Object.keys(result.metafile.inputs)
      .map((p) => p.replace(/^\.\//, ''))
      .sort(),
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [{ js, files }, shell] = await Promise.all([
    bundle(root),
    readFile(path.join(root, SHELL), 'utf8'),
  ]);

  const revision = revisionOf(root);
  const { html } = inlineIntoShell({ shell, js, revision, files });

  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, OUT), html);

  console.log(`${OUT} — ${(html.length / 1024).toFixed(1)} kB, ${files.length} modules, revision ${revision}`);
  for (const f of files) console.log(`  ${f}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
