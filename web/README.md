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

That second command builds the same page into **one file** — 112 kB, 16 modules
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
the six view modes compared by the content of the canvas rather than by counting
lit pixels: 6 distinct, and 15,156 non-black canvas pixels in the Default view. That
pixel count is 1,684 of 57,600 world cells at 3 px each, and it is worth stating its
composition because on its own it reads as a measurement of the world: 1,603 energy
cells, 5 poison cells, and one cell per bug — 76 for a population of 77, because two
bugs in one cell paint once. Counting pixels would have called five of the six modes
identical: each draws one cell per bug, so the counts match and only the colours
differ.
Zero page errors, and exactly one network request, the file itself, which is the
strongest form of "self-contained" available. The git revision is embedded in the
page (`window.__tsbugsBuild`, and the footer), so a copy on someone's disk traces
back to a commit.

## Controls

| Control | What it does |
|---|---|
| **Stop / Run** | Starts and stops the tick loop. |
| **Step** | One tick, paused. |
| **Ticks/frame** | How many simulation ticks to run per animation frame (1..64). |
| **Fill the frame** | Spend the frame's time on ticks instead of running a fixed number of them. |
| **View mode** | Six: Default, Bugs only, Bug energy, Age, DNA size, DNA value. |
| **DNA byte** | Which genome position the DNA-value mode reads; the variance chart sets it too. |
| **World parameters** | The parameters are editable, and every change is followed by a read-back so the panel shows what the world actually holds. |
| **Bug inspector** | Click a bug: the world **stops** at that tick — the button reads Run and the panel says `paused at tick N — Run continues, Step advances one tick` — then its state, its registers, and its program disassembled around the instruction pointer in a listing that scrolls. Click a byte in the listing to edit it; Enter writes it into the program the bug runs and the genome its children inherit. Clicking empty ground picks the nearest bug and says how far it was. |
| **Gene variance** | Per gene position, the fraction of the population not holding the commonest byte there. Click a column to set the DNA byte. |
| **Size / Seed / New world** | Rebuilds the world from the current seed and size. There is nothing else to configure here — the ground is flat, nothing in the simulation changes it, and there is one sensory model (DIVERGENCES.md §13). |
| **Saved worlds** | Name, Save, Export, Import, and the stored list. The next section. |
| **Stats** | Time, population, generation, and the energy accounting including the undistributed remainder. |

The fingerprint is not a control: it is on `window.__tsbugs.hash()`, because its
purpose is to be compared against Node rather than to be read off a screen.

## Saving a world

A world is saved as text: into this browser's storage under a name, or out to a
`.json` file and back in. Both paths use `src/ui/worldStore.ts`, so the stored format
and the file format are one format rather than two that drift.

Three decisions in that format are worth stating, because each rules out a way of
being wrong:

**The stream position is saved, not just the seed.** A seed cannot resume anything —
two worlds built from the same seed diverge after one tick, so restoring from a seed
would replay and still arrive somewhere else. A snapshot carries the RNG's live
position, and the claim that a loaded world *continues* is checked rather than
asserted: a world saved at tick 200, rebuilt from nothing, loaded and stepped once has
exactly the fingerprint of a run that never stopped (`0xbbf34742` at tick 201 in the
browser). `test/snapshot.test.ts` holds the same line for 200 ticks from Node, and
carries two falsifications — one step of stream offset must diverge within twenty
ticks, or the comparison cannot see anything and proves nothing. The interface is
separate from `RandomSource` on purpose: a scripted source in a test has no meaningful
position, so a world whose stream cannot state where it is refuses to be snapshotted
instead of inventing an answer.

**The processor's inputs are not saved; its outputs are.** Both look like the same
kind of field and they are not. `Bug.update()` writes all twenty input slots before
every `run()`, so a saved input can never be read — while a program that never
executes OUT leaves `out` holding the previous tick's answer, which `Bug.update()`
then reads as this tick's.

**The genome is base64, and the program is a diff against it.** The genome is the bulk
of a world and it does not compress: 580,606 bytes across 98 bugs is 774,272 chars as
base64 against 2,072,926 as JSON numbers. RAM *is* the genome until a `STORE` overwrites
it, so writing both would nearly double the file; only the addresses a bug actually
rewrote are stored, as `[address, byte]` pairs. The grid arrays are sparse in their own
ways — energy is `[hash, value]` pairs for the 1,557 of 57,600 cells that hold any —
and pairs can be read by eye.

Nothing derived is saved: the palette arrays are recomputed by a restore, because a
saved copy of a rendering rule is a second copy of it. The format is versioned, and a
version this build does not know is refused naming both versions. Upstream versioned its
binary with a bare leading int, read at `>= 2` and `>= 3` (`main_window.cpp:216`, `:336`)
— which told a reader nothing about the format and could not tell a truncated file from
a foreign one. This format names itself, so a wrong file is refused by name.

Size is the practical limit, and it is measured rather than estimated: in the built page
a world is 720,534 chars at tick 200 (77 bugs) and 940,638 at tick 1510 (98). The stored
envelope is a little larger than the file, because embedding the world as one JSON string
re-escapes each of its quotes — 3,431 chars over the world text at tick 200, 117 of which
is the envelope's own fields. Browser storage is a few megabytes, so the store holds a
handful. A save that does not fit says so in words, and a failed write leaves the world
it was replacing exactly where it was: `setItem` either lands or throws.

**A save is named for when it was made, not for where the world was in its run.** An
empty name box produces a local timestamp (`2026-10-27 13:33:07`) instead of the tick.
A tick is not a label: two different worlds reach tick 200, and the same world is at
tick 200 exactly once, so a list of tick names read as a sequence that had never
happened. It is local time because the list is read by whoever pressed Save, and the
unambiguous instant is already inside the entry as `savedAt` (ISO 8601, UTC). Two saves
inside the same second would collide — save, step, save is an ordinary thing to do — so
the second takes a ` (2)` suffix rather than raising the overwrite prompt about a world
it has nothing to do with. The box is left as the person left it: after a default save
it is empty again, so the next Save is a new entry, while a typed name stays so
re-saving that world is one click.

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
| Bug-cell count vs population, t=200, 300 and 2,000 | 76 cells / pop 77, 88 / 91, 87 / 87 — the render and the counter agree |
| A saved world continues | saved at tick 200, rebuilt from nothing and loaded, then stepped once: `0xbbf34742`, the fingerprint of a run that never stopped; the same equality holds at tick 1510 |
| A corrupt entry cannot hide the rest | three entries written where the store looks — truncated JSON, valid JSON of another shape, and a matching header with no world — each listed and named (`unreadable: …`, `not a saved world`, `incomplete: carries no world`), none with a Load button; loading one states the reason and leaves the current world untouched |
| Import runs through the file input, not a side door | a 150-tick world exported, rebuilt from nothing, then handed to the page's own `change` handler: back at tick 150 with 96 bugs and an equal fingerprint; a `.json` of another shape refused `not a tsbugs world: not a saved world (format undefined)`, world unchanged |
| Export hands the browser a real file | the blob is 940,638 chars of `application/json` at tick 1510 and the anchor says `download="tsbugs-sweep-tick1510.json"` |
| A save is named for when it was made | blank box → `2026-10-27 13:33:07`; a second save in the same second → `2026-10-27 13:33:07 (2)`, so no overwrite prompt appears about a different world; the box is empty again after a default save and still holds `my run` after a typed one; the export anchor reads `tsbugs-2026-10-27-13-33-11-tick205.json` |
| Selecting a bug stops the world | clicked a bug while the page was running: the button read Stop and then Run, and the tick did not move across the next 20 frames (held at 120), the panel naming that tick. A selection on a paused world stays paused, and Run picks the run up from the tick the panel states |
| The listing is the whole program, and it scrolls | 3,589 rows (64,610 px of content in a 238 px box, `overflow: auto`) for a 4,106-byte genome on one bug and 2,037 for another; the cursor row carries the pointer's address, and a wrapped row says so in its own text — `> 0c2b  05 b8 c7  SUBROUTINE  #1856 (51128 wrapped)` |
| Register zeros are readable | `ip 3115`, `sp / bp 38 / 38`, `accumulator 255` — the earlier build printed nothing at all for a register holding zero |
| A byte edit reaches both copies | on the live page the byte at `0361` held `fc`; typed `3c` and pressed Enter → `wrote 3c at 0361, was fc — into the program this bug runs and the genome its children inherit`; afterwards exactly 1 of 102 bugs held `3c` at that address, in its genome *and* in its processor RAM, the listing had re-decoded the row as `RET`, and the scroll position was kept |
| The mutation rate is stated in the units it is thought in | the box accepted rates the slider cannot hold: `0.0001234567` reads `1 birth in 8,100 is mutated` (slider position 16), `0.02` → `1 birth in 50` (384), `0.0001` → `1 birth in 10,000` (1), `0.5` → `50% of births are mutated` (722); each read-back names what it reaches — `bugs born from now on are built with it` — and an out-of-range entry is refused in words with nothing changed |
| The byte slots and the two-copy write are falsified | writing the unwrapped `address + 1 + i` into `decodeLinear` fails `a row names the slot each of its bytes lives in, wrapped rows included` with `slot 64 is outside the genome`, the other eight tests in that file passing; removing the genome write from `patchCode` fails `a patched byte is what a child inherits` and `… survives the snapshot that a save writes` while `… is what the machine executes` still passes, which is what separates the two copies |
| The deployed page does the same thing | recorded on the live page at `bugs.lxg2it.com`, build `23eea75` (127,311 bytes, sha256 `96f25d81…`): `Cache-Control: no-cache`, the file served byte-identical to the build; a blank name box saved `2026-10-27 14:36:23` and a world rebuilt from nothing loaded back to the fingerprint it was saved at (tick 1360); clicking a bug stopped the world at its tick; the rate box read back `0.5 — 50% of births are mutated`; a byte written on the page appeared in that bug's genome and RAM; no page errors throughout. The naming checks recorded at build `32a1a0b` (116,105 bytes) — three saves in one second giving `13:34:06`, `… (2)` and a typed name — still hold: the suffix and the box's state are the same code |
| The naming rules are falsified, not just followed | `test/worldName.test.ts` writes the same two instants without zero padding and shows them sorting the wrong way (`2026-10-1` above `2026-9-30`), which is the failure the padding prevents; removing the collision suffix fails three tests, and removing the padding fails two |
| The text format round trips | re-encoding a decoded world gives the same bytes, then 200 ticks with no divergence — and `test/snapshot.test.ts` falsifies it twice (one step of stream offset, one changed genome byte) |

The fingerprint is the useful one: it covers 57,600 indices *and* the counters,
so a divergence anywhere in the tick — VM, RNG stream, list ordering, reproduction
order — lands in the hash. It is also what makes "the port is faithful" a
falsifiable statement rather than a description of intent.

The two kinds of agreement above are worth separating. The fingerprint is what makes
the port falsifiable: same code, two engines, one number. The cell count is a check of
the *renderer* against the simulation's own state, and it is a lower bound rather than
an exact count — a cell holding two bugs paints once, which is why t=200 reads 76 cells
for a population of 77 and t=300 reads 88 for 91.

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
