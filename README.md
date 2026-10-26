# tsbugs

A TypeScript port of QtBugs, an artificial life simulation: bugs carry DNA, spend
energy, move, eat, mutate, reproduce and die, on a shared world of cells whose
energy is finite.

Upstream is `sje397/QtBugs` @ `fb3e2d4`. The simulation's behaviour is a port, not
a reinterpretation: `DIVERGENCES.md` is the list of everywhere this differs from
the original and why, and it is the file to read before changing the simulation.

The browser page is the point of the port. It runs the same compiled simulation
the tests and the Node benchmark run, so what is on screen is what is measured.

## Layout

    src/sim/     the simulation: world, bugs, DNA, mutation, energy, hash layout
    src/ui/      the page: view, parameter panel, disassembly, variance chart, picking
    web/         the shell, the dev server, and the single-file build
    test/        node:test suites, run against the compiled output
    tools/       benchmark and the VM-share sweep

## Commands

    npm run typecheck    tsc --noEmit
    npm test             compile, then run every test in dist/test
    npm run web          compile, then serve the page at http://127.0.0.1:8080
    npm run web:single   compile, then build dist/tsbugs.html
    npm run bench        throughput benchmark in Node
    npm run vm-share     sweep the VM share parameter and record the result

## The single-file build

`npm run web:single` produces `dist/tsbugs.html`: one file, no server, no imports
left to fetch, opens by double-click from anywhere. It is not minified, because it
is a reference implementation and a file someone may want to read.

The build stamps its own provenance into the artefact (`window.__tsbugsBuild`,
plus a line in the footer), so a page in front of you can be asked which commit
it came from rather than assumed. A build from a tree with uncommitted changes is
stamped `<sha>-dirty`, since a revision that cannot be checked out is not one.

Two refusals are tested rather than trusted: a shell that no longer loads
`web/app.mjs` as a module script, and a bundle with a surviving relative import
(which would work only on the machine that built it).

## Deploy

Live at <https://bugs.lxg2it.com/>, served by nginx on the AU box from
`/var/www/bugs/index.html` as a plain file — no container, no proxy, nothing to
restart. Config is `/etc/nginx/conf.d/bugs.conf`; TLS is a certbot certificate
for that one name, renewed by the box's existing timer.

    npm test && npm run web:single
    rsync -a dist/tsbugs.html ec2-user@13.54.219.192:/var/www/bugs/index.html

Run the tests first: the single-file build does not typecheck anything a test
would have caught, and a broken page is only visible in a browser. The response
carries `Cache-Control: no-cache`, so a redeploy is picked up on the next load
rather than served stale from a cache with no hash to bust it.

Verify from this machine with `--resolve` if the local resolver has not caught up
with a DNS change; curl against the public name is what proves the certificate:

    curl -sI --resolve bugs.lxg2it.com:443:13.54.219.192 https://bugs.lxg2it.com/
