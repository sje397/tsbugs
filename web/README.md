# The tsbugs page

`web/` is the running port in a browser: one page, the simulation from `src/sim/`,
and every view mode the original had. It is the "put it on a web page" half of the
brief — and it is deliberately *not* the GPU half. There is no WebGPU here, no
shader, no parallel kernel; this is the reference implementation running
unmodified, which is what makes it a baseline worth measuring the GPU work against.

    npm run web          # tsc, then serve. Open http://localhost:8077/
    PORT=9000 npm run web

The page imports the simulation from `../dist/src/sim/*.js`, so it has to be
served from the repository root, not from `web/`. That is the whole of the build
step: `tsc` output is the artefact, `web/serve.mjs` is a 90-line static server
with no dependencies. Nothing is bundled, rewritten or transpiled at serve time.

The page imports the simulation from `../dist/src/sim/*.js`, so it has to be
served from the repository root, not from `web/`. That is the whole of the build
step: `tsc` output is the artefact, `web/serve.mjs` is a 90-line static server
with no dependencies. Nothing is bundled, rewritten or transpiled at serve time.

    npm run web:single     # tsc, then bundle everything into dist/tsbugs.html

That second command builds the same page into **one file** — 56 kB, 9 modules
inlined, no imports left — which opens by double-click from anywhere, with no
server and no repository. It exists for the two things a served page is bad at: a
copy you can send someone, and a page with nothing that can go stale (no cache,
no relative path, no second copy of a module). esbuild follows the imports and
concatenates; it does not transpile (`tsc` has already run) and does not minify,
because this is a reference implementation and a file someone may want to read.

Two things are checked rather than assumed in that build. The bundle must contain
no surviving relative import — that check exists because the failure it catches is
a page that works on the machine that built it and nowhere else. And the built
file is opened from `file://` and held to the *same* fingerprint as Node
(3030175021 at seed 2024, roughness 20, SIGHTED, 200 steps — `0xb49ccd2d`, the value
`test/fingerprint.test.ts` pins), with the seven view modes swept for distinct
canvases: 7 distinct, 15228 non-black canvas pixels in the Default view — that is
1692 of 57600 world cells at the 3x scale, and it is worth stating the mechanism
because the pixel count on its own reads as a measurement of the world — 0 page
errors, and exactly one network request, the file itself, which is the strongest
form of "self-contained" available. The git revision is embedded in the page
(`window.__tsbugsBuild`, and the footer), so a copy on someone's disk traces back
to a commit.


## Controls

| Control | What it does |
|---|---|
| **Play / Pause** | Starts and stops the tick loop. |
| **Step** | One tick, paused. |
| **Ticks/frame** | How many simulation ticks to run per animation frame (1..200). |
| **View mode** | All seven: Default, Bugs only, Bug energy, Age, DNA size, DNA value, Terrain. |
| **RNG seed** | The simulation is fully deterministic given this. Change it, reset, and you get a different world. |
| **Sense model** | `SIGHTED` (both channels wired as `fb3e2d4` intends) or `BLIND` (upstream's crossed-and-uninitialised channels, kept so the difference can be demonstrated rather than asserted). |
| **Roughness** | Relief for the terrain channel. 0 = flat, as the original world starts. It is read when the world is built, not live — there is no separate "seed terrain" button. |
| **Reset** | Rebuilds the world from the current seed, sense model and roughness. This is what applies roughness. |
| **Fingerprint** | A 32-bit hash of the whole rendered grid plus the simulation counters. Its purpose is the next section. |

## What is verified, and how

The claim "this is the same simulation as the Node build" is not an impression;
the page computes it. `fingerprint()` (`src/sim/fingerprint.ts`) hashes every
view index in the grid plus time, population, max generation, births, deaths,
bug energy and energy energy. Same inputs, same hash, or the port is not faithful.

| Check | Result |
|---|---|
| Fingerprint, seed 2024, roughness 20, SIGHTED, 200 steps | **3030175021** — identical in Node and Chromium |
| …and its components | pop 85, time 200, maxGen 7, births 40, deaths 76, bugEnergy 40352, energyEnergy 76030 — all equal |
| All seven view modes | render 7 distinct canvases (`allDistinct`), no page errors during the sweep |
| Bug-cell count vs population, t=300 and t=2000 | 86 cells / pop 86, and 93 cells / pop 93 — the render and the counter agree |

The fingerprint is the useful one: it covers 57,600 indices *and* the counters,
so a divergence anywhere in the tick — VM, RNG stream, list ordering, reproduction
order — lands in the hash. It is also what makes "the port is faithful" a
falsifiable statement rather than a description of intent.

## Measured (M4 Max, three runs each — spread is the point)

| | Browser (Chromium) | Node |
|---|---|---|
| Tick, pop 90-123 | 5,709-6,420 /s — 0.156-0.175 ms | 6,037-6,261 /s — 0.160-0.166 ms |
| Full-grid pass (57,600 cells) | 1.393 ms | 1.444-1.520 ms |

The browser and Node ranges overlap: this code costs the same in both, and the
14% spread within each row is run-to-run variance on one machine, not a browser
penalty. An earlier version of this table quoted one run each (5,709 against
7,372) and read as a 23% browser tax; the Node figure has not reappeared in
three runs since.

At the page's default 4 ticks/frame the simulation costs ~0.67 ms of a 16.7 ms
frame, and the frame's remaining budget would fit ~100 ticks. The blit is
*below reliable measurement* here — 0.042 ms and 0.203 ms on two runs, so
compositor scheduling dominates any real cost. No figure for it is quoted here
for that reason. Rendering is not the constraint at 240x240; `PERFORMANCE.md`
breaks the tick itself down (roughly 56% VM, 44% world) and asks what a GPU
would and would not buy.

**Caveats, because these are single runs.** One machine, one population point,
one seed. Population is *chaotic* with respect to seed: three seeds at 20k ticks
gave 88, 103 and 620 bugs on the same parameters, so any single-run comparison of
two configurations is meaningless — which is also why an earlier reading of
"rough terrain supports 7× fewer bugs" is not a claim this README makes. It was
one seed. Averaged over three, flat 270 vs rough-20 235, i.e. nothing.

## Two things that look like bugs and are not

**The terrain view looks almost uniform.** It is: the rendered value is
`clampByteRamp(elevation + 127)`, and `seedTerrain(20)` adds ±20 of noise and then
runs two 3×3 smoothing passes, which leaves a range of about −10..+14 with 8,026
of 57,600 cells exactly flat. Near-flat ground sits near elevation 0 → index 127 →
mid-ramp yellow. Raise roughness to 40 for visible relief (4,021 flat cells), or
start from roughness 0 and let the bugs dig: from a flat world, 20k ticks of bug
activity produces a range of −4..+8 on their own.

**Terrain under a bug is not drawn as terrain.** A cell containing a bug returns
`ENERGY_COLOR` in the terrain view, exactly as upstream had it. This is faithful,
and it means the terrain view cannot show the ground under the population.

## Fidelity notes

The rendering is ported from `petriwidget.cpp` / `petri_dish.cpp` and the palette
from the 256-entry table built once in the `PetriWidget` constructor: a red→yellow→
green ramp at indices 1..252, `0` black, `253` cyan, `254` magenta (poison), `255`
blue (energy). The canvas is drawn nearest-neighbour to the widget size and the
image is not smoothed, matching `Qt::FastTransformation`.

Where this port deviates from upstream — including the signed-byte terrain storage
and its monotonic ramp, which are *deliberate* changes, and the seven upstream bugs
that were fixed rather than reproduced — `DIVERGENCES.md` §8 and §9 are the record.
