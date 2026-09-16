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

## The ground, measured

What the world stores and what the canvas draws are the same object seen twice, so
both are measured here — and checked against each other rather than assumed to
agree.

**Every number below comes from one instrument.** `tools/terrain-probe.mts` reads
the simulation's own terrain array and prints a census at points through a run; it
seeds terrain through its own stream (`Rng(seed + 1)`), so a measurement taken with
a different stream is not comparable and numbers of that kind have been removed
from this file. For the page, the second instrument is the canvas itself — every
cell classified back through the palette — and where the two see the same world
they agree exactly, which is the only reason to trust either.

**Population is an attractor under the fixed senses, and a runaway without them.**
At 20,000 ticks the sighted model settles near 100 whatever the seed and whatever
the ground: final populations 102 / 97 / 102 / 100 / 101 / 100 for seeds 1–6 at
roughness 0, and 107 / 99 / 106 / 105 / 103 / 97 at roughness 20 — every one of
those twelve runs inside 97–107, with no sample in any of them above 114. That is
the mechanism, not luck: `balance()` tops bug energy up toward `min_bug_energy`
(40,000) and spawns at a mean of ~410 energy, and 40,000 / 410 is ~97 bugs. Flat
ground (mean 100.3) and roughness-20 ground (102.8) differ by less than the seed
spread does, so on this evidence terrain does not change the population at all.

The as-shipped senseless model is a different animal. Twelve runs at the same seeds
and grounds (as-shipped), and exactly one of them leaves the attractor: seed 2 on
flat ground goes 142 at t=2,500 → 706 at t=5,000 and never returns — the sampled
populations after that are 647 / 703 / 654 / 595 / 639 / 584 — ending at 584 with
generation 623, against generation 8 for the sighted model on the same seed and
ground. It is deterministic —
re-running gives byte-identical rows except the probe's wall-clock rate column.

That single run is where two claims in this file's history came from. A "620 bugs"
figure sat in a list of seed results as though the seeds were comparable, and a
reading of "rough terrain supports 7× fewer bugs" is what a flat/rough comparison
looks like when one arm booms and the other does not. Both are sense-model
artefacts rather than terrain effects — which is the argument for fixing the senses
before benchmarking anything on this simulation, and against quoting a single run's
population for any purpose.

**The terrain view is not uniform — it spans the whole ramp.** Flat ground
(elevation 1) renders at index 139, and at `TERRAIN_RAMP_SCALE = 10` — upstream's
`terrain / MAX_TERRAIN * 127 + 127` — the ramp is steep: 12.7 indices per unit of
elevation. The page's default world (seed 2024, roughness 20) is −10..+14, which
reaches both ends of it.

Read back from the canvas of a freshly seeded, stopped world — 240² = 57,600 cells,
all classified, none unmatched, none black:

* 21 distinct indices, spanning the full ramp from 1 to 252
* mode 139 with **8,026 cells**, which is exactly the flat count
* **23,728** cells below flat, **25,846** above (and 23,728 + 8,026 + 25,846 = 57,600)
* **2** cells at the red end (index 1), **69** at the green (index 252)

The probe on that same seed returns the same five quantities — flat 8,026, holes
23,728, hills 25,846, satL 2, satH 69 — so the array and the rendered canvas are one
world seen twice through two different instruments. The count of 21 is also what the
ramp arithmetic predicts for a −10..+14 world: everything at or above +10 collapses
onto 252 and everything at or below −10 onto 1, leaving the 19 elevations between
them mapping one-to-one.

An earlier revision of this port mapped one index per unit of elevation
(`clampByteRamp(elevation + 127)`), which is what produces a near-uniform yellow
field. It was dropped for upstream's scale; DIVERGENCES.md §8 has the reasoning.
A reader looking at a uniform field is looking at something older than this page.

**Raising the roughness past ~20 buys clipping, not relief.** Seeded ground on its
own, before a single tick (seeds 1–3): roughness 20 gives −11..+11, −10..+12 and
−9..+12, with 8,129 / 8,128 / 8,252 flat cells and only 0–4 and 24–61 cells sitting
at the ramp's two ends. Roughness 40 gives −21..+23, −20..+20 and −21..+22, with
4,195 / 4,131 / 4,104 flat, and 1,543–1,657 and 3,142–3,594 cells at the ends. So
the extra roughness is largely spent piling ground against the ramp's extremes,
where the terrain view cannot tell one cell from its neighbour.

Seed-dependence cuts both ways and belongs in the same breath: 8,026 is the page's
*default world* (seed 2024, roughness 20), not a constant — seeds 1–3 give 8,129 /
8,128 / 8,252 at that roughness. Quote a flat count with its seed or not at all.

**From a flat world the bugs dig their own relief**, and it does go below flat:
20,000 ticks at roughness 0 (seed 1) leaves −3..+7 with 4,222 cells below flat and
4,316 above, at a population of 102. The as-shipped sense model gives −4..+5 with
3,336 and 3,381. Neither run saturates the ramp (satL and satH are 0 at every
sample of both): the extremes that up end the ramp in seeded ground are the
seeding, not the evolution.

**Terrain under a bug is not drawn as terrain.** A cell containing a bug returns
`ENERGY_COLOR` in the terrain view, exactly as upstream had it. This is faithful,
and it means the terrain view cannot show the ground under the population — which is
measurable rather than merely true. At t=200 (seed 2024, roughness 20) the probe
reports flat 8,053 / hollow 23,714 / raised 25,833 and the canvas 8,045 / 23,674 /
25,796; the differences are 8, 40 and 37, summing to the **85 blue cells** the canvas
paints, one per bug. That the two instruments differ by exactly the population — no
residue, nothing unexplained — is a stronger statement than the t=0 agreement above,
because it holds at a moment when the ground has changed.

At t=1,164 from the same world the check gives **105 blue cells for a `population` of
105**: equal, so no cell held two bugs at that instant. The count is a *lower bound*
rather than an estimate — `bugList[hash]` is a list and any bug in it paints the cell
— so a moment with overlap would read below the population. (An earlier revision of
this file said 104 here. It was not reproducible: read back from the stated world and
tick, the canvas and the array both say 105.)

**No cell in the terrain view is black**, and that is a divergence rather than a
compliment. Upstream's terrain branch returned the background for ground at exactly
flat and palette index 1 for ground at zero, which painted the world's ordinary
ground black in the one view built to show relief. The port's ramp is monotonic over
the whole signed range, so flat ground lands at 139 and the background is never
returned — `DIVERGENCES.md` §8 has the reasoning and the tests that pin it.

## Fidelity notes

The rendering is ported from `petriwidget.cpp` / `petri_dish.cpp` and the palette
from the 256-entry table built once in the `PetriWidget` constructor: a red→yellow→
green ramp at indices 1..252, `0` black, `253` cyan, `254` magenta (poison), `255`
blue (energy). The canvas is drawn nearest-neighbour to the widget size and the
image is not smoothed, matching `Qt::FastTransformation`.

Where this port deviates from upstream — including the signed-byte terrain storage
and its monotonic ramp, which are *deliberate* changes, and the seven upstream bugs
that were fixed rather than reproduced — `DIVERGENCES.md` §8 and §9 are the record.
