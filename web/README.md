# The tsbugs page

`web/` is the running port in a browser: one page, the simulation from `src/sim/`,
and the view modes that simulation still has to show — six of upstream's seven. The
seventh existed only to draw terrain, which this port does not have
(`DIVERGENCES.md` §12). It is the "put it on a web page" half of the brief — and it
is deliberately *not* the GPU half. There is no WebGPU here, no shader, no parallel
kernel; this is the reference implementation running unmodified, which is what makes
it a baseline worth measuring the GPU work against.

    npm run web          # tsc, then serve. Open http://localhost:8077/
    PORT=9000 npm run web

The page imports the simulation from `../dist/src/sim/*.js`, so it has to be served
from the repository root, not from `web/`. That is the whole of the build step:
`tsc` output is the artefact, `web/serve.mjs` is a 90-line static server with no
dependencies. Nothing is bundled, rewritten or transpiled at serve time.

    npm run web:single     # tsc, then bundle everything into dist/tsbugs.html

That second command builds the same page into **one file** — 52 kB, 9 modules
inlined, no imports left — which opens by double-click from anywhere, with no server
and no repository. It exists for the two things a served page is bad at: a copy you
can send someone, and a page with nothing that can go stale (no cache, no relative
path, no second copy of a module). esbuild follows the imports and concatenates; it
does not transpile (`tsc` has already run) and does not minify, because this is a
reference implementation and a file someone may want to read.

Two things are checked rather than assumed in that build. The bundle must contain no
surviving relative import — that check exists because the failure it catches is a
page that works on the machine that built it and nowhere else. And the built file is
opened and held to the *same* fingerprint as Node (**2372629348** at seed 2024,
200 steps — `0x8d6b7364`, the value `test/fingerprint.test.ts` pins), with
the six view modes swept for distinct canvases: 6 distinct, 15,228 non-black canvas
pixels in the Default view. That pixel count is 1,692 of 57,600 world cells, and it is
worth stating its composition because on its own it reads as a measurement of the
world: 80 bug cells, 1,607 energy cells, 5 poison cells, and background for the rest.
Zero page errors, and exactly one network request, the file itself, which is the
strongest form of "self-contained" available. The git revision is embedded in the
page (`window.__tsbugsBuild`, and the footer), so a copy on someone's disk traces
back to a commit.

## Controls

| Control | What it does |
|---|---|
| **Play / Pause** | Starts and stops the tick loop. |
| **Step** | One tick, paused. |
| **Ticks/frame** | How many simulation ticks to run per animation frame (1..200). |
| **View mode** | Six: Default, Bugs only, Bug energy, Age, DNA size, DNA value. |
| **RNG seed** | The simulation is fully deterministic given this. Change it, reset, and you get a different world. |
| **Reset** | Rebuilds the world from the current seed. There is nothing else to configure here — the ground is flat, nothing in the simulation changes it, and there is one sensory model (DIVERGENCES.md §13). |
| **Fingerprint** | A 32-bit hash of the whole rendered grid plus the simulation counters. Its purpose is the next section. |

## What is verified, and how

The claim "this is the same simulation as the Node build" is not an impression;
the page computes it. `fingerprint()` (`src/sim/fingerprint.ts`) hashes every
view index in the grid plus time, population, max generation, births, deaths,
bug energy and energy energy. Same inputs, same hash, or the port is not faithful.

| Check | Result |
|---|---|
| Fingerprint, seed 2024, 200 steps | **2372629348** — identical in Node and Chromium |
| …and its components | pop 77, time 200, maxGen 3, births 49, deaths 74, bugEnergy 40030, energyEnergy 76067 — all equal |
| All six view modes | render 6 distinct canvases (`allDistinct`), no page errors during the sweep |
| Bug-cell count vs population, t=200, 300 and 2,000 | 80 cells / pop 81, 98 / 99, 97 / 97 — the render and the counter agree |

The fingerprint is the useful one: it covers 57,600 indices *and* the counters,
so a divergence anywhere in the tick — VM, RNG stream, list ordering, reproduction
order — lands in the hash. It is also what makes "the port is faithful" a
falsifiable statement rather than a description of intent.

The two kinds of agreement above are worth separating. The fingerprint is what makes
the port falsifiable: same code, two engines, one number. The cell count is a check of
the *renderer* against the simulation's own state, and it is a lower bound rather than
an exact count — a cell holding two bugs paints once, which is why t=200 reads 80 cells
for a population of 81.

## Measured (M4 Max — spread is the point)

| | Browser (Chromium) | Node |
|---|---|---|
| Tick, pop 80-103 | 6,957-7,070 /s — 0.141-0.144 ms | 6,945-7,086 /s — 0.141-0.144 ms |
| Full-grid pass (57,600 cells) | 1.1-2.1 ms (three runs; the first carries warm-up) | 1.53-1.57 ms |
| Draw (palette expand + blit) | 0.218-0.382 ms | — |

The two tick ranges overlap — 6,945-7,086 in Node against 6,957-7,070 in the
browser — and the spread within each arm is run-to-run variance on one machine rather
than a browser penalty: this is the same code doing the same work. The browser figures
come from Chrome 120 driven headless through Playwright and should be read as that
instrument's numbers; the Node figures come from `npm run bench`, the browser's from
the page's own `bench()`. Both were re-measured after terrain was removed
(`DIVERGENCES.md` §12): earlier revisions of the numbers in this file and in
`PERFORMANCE.md` describe a build that still carried the terrain code, and are not
comparable to these. One single earlier Node run on this same build read 7,467/s and
1.41 ms for the full-grid pass; the machine was in a different state, which is why
ranges and sample counts are stated here rather than a single figure.

At the page's default 4 ticks/frame the simulation costs ~0.57 ms of a 16.7 ms frame
(4 x 0.142 ms), and a frame's four ticks plus a draw is ~0.84 ms. The frame's remaining
budget would fit well over a hundred ticks. Rendering is not the constraint at 240x240; `PERFORMANCE.md` breaks the
tick itself down — **64% VM, 36% world**, with a full-grid pass at ~24.5 ns/cell — and
asks what a GPU would and would not buy.

## The world, measured

**Population is an attractor, and the arithmetic says why.** At 20,000 ticks the
sighted model settles near 100 whatever the seed: final populations 102 / 97 / 102 /
100 / 101 / 100 for seeds 1-6, every one of those six runs inside 97-107, with no
sample above 114. That is `balance()`, not luck — it tops bug energy up toward
`min_bug_energy` (40,000) and spawns at a mean of ~410 energy, and 40,000 / 410 is
~97 bugs.

**A high population is not a live world, and this is the measurement everything else
here depends on.** `balance()` maintains a population by *injection* — it adds bugs at
a target energy — while reproduction happens only when two bugs share a cell. So a
world can sit at ~100 bugs with no births at all and never recover: the counter says
population, the mechanism says corpse. The probe therefore scores worlds by
reproduction rather than by level, and its operational definition is explicit: **a run
is reproducing when its population holds at or above 250 for 5,000 consecutive ticks.**

That threshold is not a proxy for a number I could not measure, and it is not chosen
for convenience — it sits inside a gap that is itself measured. Injection alone tops a
world up to ~100-114 and no further (the flat worlds below peak at 118-140); a world
that is genuinely reproducing passes 640 (those peak at 645-798). Nothing observed
lands between 141 and 645. A level threshold is used at all because births cannot be
attributed cleanly from outside — they are entangled with `balance()`'s own top-up —
but the level a reproducing world reaches is not reachable any other way.

**The as-shipped senseless model escapes the attractor entirely.** *Historical: this
measurement used the `AS_SHIPPED` sense model, which the port no longer has
(DIVERGENCES.md §13). The numbers are as recorded and cannot be re-run here; they are
kept because the claim below — that a single run's population is not a fact about the
world — is still the reason the measurements in this file are shaped the way they are.*
Twelve runs at the
same seeds, and exactly one of them leaves: seed 2 on flat ground goes 142 at
t=2,500 → 706 at t=5,000 and never returns — sampled populations after that are 647 /
703 / 654 / 595 / 639 / 584 — ending at 584 with generation 623, against generation 8
for the sighted model on the same seed. It is deterministic; re-running gives
byte-identical rows except the probe's wall-clock rate column.

That single run is where two claims in this file's history came from. A "620 bugs"
figure sat in a list of seed results as though the seeds were comparable, and a reading
of "rough terrain supports 7× fewer bugs" is what a flat/rough comparison looks like
when one arm booms and the other does not. Both are sense-model artefacts rather than
terrain effects — which is the argument for fixing the senses before benchmarking
anything on this simulation, and against quoting a single run's population for any
purpose.

**What the ground was doing to the world.** This is the measurement that removed the
terrain feature, and it is a 2 × 3 comparison: 24 seeds (2024, 1-23) per arm, each run
10,000 ticks, then every bug removed mid-run, then 60,000 ticks more — and, as a
separate arm, 60,000 ticks from genesis. Instrument: `tools/escape-probe.mts`.

| | re-ignites after a die-off | reproduces from a fresh world |
|---|---|---|
| no terrain (flat) | **16 / 24** | **16 / 24** |
| terrain, roughness 20 | 0 / 24 | 0 / 24 |
| terrain, roughness 0 (seeded flat) | 0 / 24 | 3 / 24 |

The third row is the one that identifies the cause. With the terrain code present but
seeded *flat* — the same starting world the port now has by construction — a die-off is
still terminal in 24 of 24, and a fresh world reproduces in 3 of 24. So it is the
terrain *feature* that blocks re-ignition, not the amplitude of the seeding.

The mechanism I read from that, stated as a reading rather than as a measurement: the
ground does not stay flat. Deaths deposit payload, digs write relief, and the move-cost
rule charges `moveEnergy * (climb + 1)` per step, so relief makes travel expensive over
exactly the distance a world needs to cover — a roamer onto an occupied cell — and the
world cannot do the one thing it needs to do. What is measured is the behaviour; the
mechanism is an inference that fits it.

Two limits on that result, both worth stating rather than leaving to be discovered:

* Flatness fixes the die-off case and does not promise permanent viability. **8 of the
  24 seeds never re-ignite even with the terrain gone** (1, 3, 7, 8, 13, 20, 22, 23),
  so the ground was a barrier and not the only one.
* On an earlier and finer statistic — the ratio of replacements to deaths after a
  die-off — removing terrain improved the early run (0.46-0.57 against 0.31) and still
  decayed to ~0.3 later in the run. So on that evidence this change answers the
  re-ignition question without settling the longer one.

## Fidelity notes

The rendering is ported from `petriwidget.cpp` / `petri_dish.cpp` and the palette
from the 256-entry table built once in the `PetriWidget` constructor: a red→yellow→
green ramp at indices 1..252, `0` black, `253` cyan, `254` magenta (poison), `255`
blue (energy). The canvas is drawn nearest-neighbour to the widget size and the
image is not smoothed, matching `Qt::FastTransformation`.

Where this port deviates from upstream — including the fixed senses, the removed
terrain (§12, which supersedes the terrain storage and ramp in §8), the one sensory
model and the closed-up input layout (§13), and the upstream bugs that were fixed
rather than reproduced — `DIVERGENCES.md` §8, §9, §12 and §13 are the record.
