/**
 * Static server for the tsbugs page.
 *
 * The page imports the simulation from `../dist/src/sim/*.js`, so it must be
 * served from the repository root rather than from `web/` — the layout the page
 * expects is `web/index.html` beside `dist/`, which is exactly the checkout. No
 * bundler, no dependencies, no rewrite step: `tsc` output is the artefact.
 *
 * `npm run web` compiles first, then runs this. Port is 8077 unless PORT says
 * otherwise (3000/3001 are the Lex server's).
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, join, sep, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8077);

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

/**
 * Map a request path to a file inside ROOT, or null if it escapes.
 *
 * Normalising before joining is what makes this safe: `/../etc/passwd` becomes
 * `/etc/passwd`, which is under ROOT after the join and therefore served as a
 * 404 rather than as the file. The `startsWith(ROOT + sep)` check then catches
 * anything normalisation alone would let through.
 */
function pathFor(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = join(ROOT, relative);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

async function resolveFile(candidate) {
  if (!candidate) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      const index = join(candidate, 'index.html');
      const indexInfo = await stat(index);
      return indexInfo.isFile() ? index : null;
    }
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  // `/` redirects rather than serving web/index.html in place. The page loads
  // `./app.mjs` relatively, and app.mjs imports `../dist/...`; serving the file
  // at `/` would leave the browser's base URL at the root, so those resolve to
  // `/app.mjs` and `/dist/...` — the first 404s and the page silently stays dead
  // (canvas 300x150, no error in the console). The redirect keeps the base URL
  // honest, which is what the ../ imports in the page depend on.
  if (req.url === '/' || req.url === '') {
    res.writeHead(302, { location: '/web/' });
    res.end();
    return;
  }

  const path = req.url.split('?')[0];
  const file = await resolveFile(pathFor(path));

  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${path}\n\nTry http://localhost:${PORT}/ — the page is at /web/.\n`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES.get(extname(file)) ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tsbugs: http://localhost:${PORT}/`);
  console.log(`serving ${ROOT}`);
});
