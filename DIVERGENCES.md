# Divergences from QtBugs

The port is faithful to **what the original meant to do**, not to what it did. Every
place it knowingly differs from the C++ is listed here, with the evidence and the
reason. A divergence that is not on this list is either a bug in the port or an
undocumented drift — both of which are defects in their own right.

Upstream reference: `sje397/QtBugs` @ `fb3e2d4` (the sense fix). Line numbers are
from that revision.

---

## 1. Fixed: the sense channels were blind and crossed

**Upstream, before `fb3e2d4`.** `do_eating_and_seeing` (petri_dish.cpp:589-598) read
terrain correctly, wrote the *energy* reading into the terrain buffer, and passed an
**uninitialised** local array as the energy channel. Both getters also computed
`(nx, ny)` and then indexed `x * height + y`, so all nine cells held the same value.
Bugs have therefore been unable to see energy or a terrain gradient since
`8c71d14` (19 Nov 2011).

**The port.** Implements `fb3e2d4` semantics — the graded, correctly routed reading —
and nothing else. There is no switch (§13), so this is the port's only sensory
model. Two tests in `test/dish.test.ts` pin it: one that a bug fills colour 0-8 and
energy 9-17 with its own readings, and one that the energy window carries a real 3x3
gradient across the world. The second is the guard for this section — the shipped
build's failure mode was nine slots reading one value, and any return of that shape
fails there.

## 2. Fixed: the sensory scaling was undefined behaviour

**Upstream, still present at `fb3e2d4`.** Both getters end in
`(unsigned char)(array[...] / max * 255)` — a **float** converted straight to
`unsigned char`. In C that conversion is undefined whenever the float leaves 0..255,
and one edge is reachable in ordinary play:

- **Above the divisor's range** — the terrain channel divides by `MAX_TERRAIN` (10),
  and the ground rises past it. `removeBug()` deposits a dying bug's payload with no
  guard whatsoever (:481), and the drop branches of cases 3 and 4 add to a cell already
  at its floor (:533, :543). Ground of 11 computes 280.5 and leaves 0..255: on the
  shipped build that wraps to a *low* reading (11 reads 24/255), so a hill arrives at
  the VM as a hollow. `fb3e2d4` is what first routes terrain into this conversion;
  before it, the conversion read `energy`, which is never negative.
- **Above 255** — energy deposits are additive with no cap
  (`energy[hash] += e`), so a cell's energy can exceed `max_e_energy` (80).

*Not* below zero, which an earlier revision of this section asserted. Upstream's digs
are floored — `> 0` in case 1, `> 1` in cases 2 and 4 — and `terrain` is an `int`, so
nothing can write a negative into it at all. The `abs()` in case 0's drop guard reads as
though the author expected signed elevation; the floors are what stop it ever existing.
Section 8 covers that, and the port's deliberate departure from it.

**The port.** `senseByte(value, max)` (dish.ts) clamps to 0..255 and keeps truncation
toward zero, so every in-range reading is bit-identical to the original's. This is a
change **at the edges only**, and it matters because a wrap inverts rather than
blurs: terrain of −1 wraps to 231/255, i.e. near-maximum altitude. Tested in
`a sensory reading saturates at both ends instead of wrapping`.

## 3. Fixed: a birth left its cell stale for a tick

**Upstream.** `replicate()` prepends the newborn to the cell's list, making it
`bugs[0]` — the bug every per-bug view mode renders — and then its pixel refresh is
commented out (:647), as are the `x`/`y` it would need (:620), so the call could not
have compiled. The cell keeps its pre-birth colour until the next tick's move phase
sweeps it.

**The port.** Refreshes the cell in `replicate()`. Unshifting the newborn exists
*precisely* so that it renders; leaving the cell stale means the newborn is invisible
for a tick. Tested in `no cell ever renders stale, births included`.

## 4. Randomness: a seeded stream, not the global `qrand()`

**Upstream.** Every draw is `qrand()` from one global generator.
`qsrand(midnight.secsTo(QTime::currentTime()))` exists at main_window.h:52-53 but sits
inside `UpdateThread::run()`, and every `start`/`wait` on that thread is commented out
(main_window.cpp:59, 116, 129, 137, 138). The seed is therefore never applied — the
draws come from Qt's default seed — and the order they are consumed in is racy,
because `QtConcurrent::blockingMap` runs the per-cell work in parallel over that one
shared generator.

**The port.** One seeded `Rng` per dish. **It cannot be bit-identical to any upstream
run, and claiming otherwise would be false.** What it does is sample the same
ensemble, with the same draws in the same structural order — the strongest fidelity
claim available, and the only one that makes a trajectory reproducible. Upstream's
modulo bias is preserved deliberately (`% n` rather than an unbiased helper), because
the bias is part of the behaviour.

Deterministic *parallel* execution needs per-bug streams derived from
`(seed, bug identity)`. That changes the correlation structure between bugs, so it is
a step to take when parallelism lands — not a refactor to slip in silently.

## 5. Reproduction reads the pre-tick list

**Upstream.** `replicate()` iterates `bugList[hash]` while prepending newborns to it,
and draws the partner from that same live list via `.at(i2)`. Whether a newborn is
visible to either depends on `QList`'s internal layout and is not knowable from the
source.

**The port.** Takes the stable-list reading (`bugs.slice()` before the loop), which is
the only one under which the `i1`/`i2` index juggling means anything and under which
"a bug reproduces at most once per tick" is true.

## 6. Phases run serially

**Upstream.** The eat/see and replicate phases run under
`QtConcurrent::blockingMap`, partitioned by cell, with a mutex around the shared
counters — and `balance()` takes no lock at all.

**The port.** Serial. The partition is by cell, so the per-cell results are the same
without the race, and there are no shared counters to guard. This is a prerequisite
for the GPU work, not a preference.

## 7. Dead code is not carried

- `UpdateThread` and its `qsrand` seed (§4).
- The inlined birth block at :814-841, including the commented-out
  `r = qrand() % 255 + 1`. The live value is the literal `128`, so the threshold
  carries **no draw** and a bug splits whenever its split output is below 128. A port
  that "restored" that line would consume an extra draw per reproduction.
- The permanently disabled `spinDNAVal` (the .ui sets `enabled=false` and no code
  re-enables it — in the shipped app the DNA byte is reachable only by clicking the
  histogram). Revisiting this belongs with the UI controls.

## 8. Fixed: terrain renders monotonically — and diverged: it stores a signed byte

**Superseded — historical.** The terrain feature this section is about was removed
outright on 2026-09-16 (§12). Nothing below describes code the port still has, and it
is kept for two reasons: the reasoning is what justified *not* porting upstream's
signed-byte encoding, and §12's evidence refers back to the terrain behaviour measured
here. Read §12 first if you want to know what the port does now.

**Upstream, still present at `fb3e2d4`.** Two defects that arrived together with
`8c71d14`, both on the terrain path. The port fixes both, and then departs from upstream
twice more, deliberately: it stores elevation in a signed byte, and it lets the ground be
dug below flat. Both departures are recorded below rather than left implicit.

*Storage — what is actually there.* `terrain` is `int *terrain` (petri_dish.h:98),
initialised to 1 everywhere (:54) and serialised as an int (:112, :134). It is never
generated: a world is saved and loaded, so the port's `seedTerrain()` has no upstream
counterpart at all.

Nothing can write a negative into it. Both digs are floored — `> 0` in case 1, `> 1` in
cases 2 and 4 — so the ground runs from 0 upward, and **holes do not exist in the
original, even though it is written as though they might**: case 0's drop guard is
`abs(terrain[hash]) < MAX_TERRAIN`, an absolute value applied to a quantity that can only
be positive, and `MAX_TERRAIN` (10) names a ceiling.

That ceiling is not enforced either, from above. Case 0 refuses to raise ground at or
above 10, but `removeBug()` adds a dying bug's payload to its cell with no check at all
(:481), and cases 3 and 4 add to a cell already at its floor (:533, :543). The payload is
only ever 1 — set on a dig, cleared on a drop — so each of those deposits lifts one cell
by one level. Slow, unbounded, and the way ground gets **above** the number the rest of
the code treats as its maximum.

*Rendering.* The terrain view (`:302`) is
`terrain == 1 ? BkgColor : terrain == 0 ? 1 : (int)(terrain/10.0f * 127 + 127)` — flat
ground renders black and the level below it near-black, in the one view built to show
relief — and above ten levels the `unsigned char` return wraps mod 256 back to the **low**
end, so a hill renders as a hollow.

*Sensing.* `get_terrain_at` (`:330`) computes `(unsigned char)(terrain/10.0f * 255)`, which
leaves 0..255 for any ground above 10: undefined behaviour in C and a wrap in practice, so
an 11-high cell arrives as 24/255. `fb3e2d4` is what routes terrain into that conversion.

*The port's channel is a different encoding, deliberately.* Upstream's byte is a scaled
magnitude (`/MAX_TERRAIN * 255`), monotone over the 0..`MAX_TERRAIN` ground it could reach
and wrapping above it. The port's is the two's-complement byte itself (`elevationByte`): a
hole reads 129..255, flat ground 1, a hill 2..127 — injective over the whole ±127 range, so
every depth the storage can hold arrives as a distinct byte, but it wraps at flat instead of
saturating, so a hole arrives *above* every hill rather than below the ground. The
alternative, `senseByte(elevation, TERRAIN_RAMP_SCALE)` as the energy channel uses, would
have been monotone and would have held the channel in range by *saturating*: every hole at
or below −1 computes ≤ 0 and clamps to 0, making a one-deep hole and a ten-deep one the same
reading — blinding the bugs to depth in the one direction this section makes reachable.
Two's complement keeps the depth and costs the program the ordering: it must take the sign
bit (`AND` 128) or a difference, both of which the op set has. Upstream's input slots are
`unsigned char` (processor.h:63) and its branches test only zero and non-zero, so this is a
choice in a region upstream never reached, not a faithfulness question — no upstream program
can depend on either encoding for a negative elevation. Tested in `elevation is a signed
byte: a hole reaches the VM as a value above flat ground`, which pins 1 / 0 / 255 / 129 at
flat, zero, −1 and −127.


**The port.** One writer, one invariant: `setTerrain()` (`dish.ts`) is the only path into
the array and it clamps through `clampElevation()`, so elevation cannot leave ±127
whichever phase is writing — including the unguarded `removeBug()` deposit.

*Divergence, deliberate: the ground can be dug below flat.* Upstream's floors (`> 0`,
`> 1`) are precisely what make holes impossible, and the port does not reproduce them:
case 0's clearing dig runs to `TERRAIN_MIN` (`dish.ts`), and the drop branches fill any
cell below flat rather than only cells at 0. That departs from upstream's **code** to
follow its **intent** — `abs()` applied to a one-sided quantity, `MAX_TERRAIN` naming a
range, the drop conditions written as "at the floor" — all of which describe a height
field that has two directions. Reproducing the floors would faithfully reproduce the
reason holes are unreachable, which is the defect rather than the design. Listed here as
a divergence for that reason, not as a fix.

It is also what makes the port's *negative* readings reachable at all: upstream's terrain
channel has only the positive edge (§2), because upstream's ground only ever rises.

The view keeps upstream's *scale* while dropping its wrap: `terrainColor(e)` is
`(int)(e / TERRAIN_RAMP_SCALE * 127 + 127)`, saturated at the ends of the bug ramp instead
of wrapped mod 256. Holes at the red end, flat ground just past mid-ramp, hills at the
green end, monotonic in elevation so relief reads at a glance. The one thing this cannot
show is the ground under a bug, which is `ENERGY_COLOR` exactly as upstream had it.

*Two smaller things the same branch drops, and they are quirks rather than regressions.*
Upstream's terrain case returns `BKG_COLOR` for flat ground and palette index 1 for
elevation 0 — `terrain[hash] == 1 ? BkgColor : (terrain[hash] == 0 ? 1 : …)`. Both only
made sense while elevation ran 0..`MAX_TERRAIN` and flat was a special *value* rather than
a level: it painted the world's ordinary ground black and the level below it near-black,
in the one view built to show relief. A signed elevation has a neutral level, so the port
maps the whole stored range onto the ramp and flat ground lands mid-ramp at 139 (8026 cells
of 57600 in a seed-2024 roughness-20 world before it is stepped, 8053 once 200 steps of
digging and depositing have run — the flattest thing there is, rendered as what it is).
Tested in `the terrain view is unreadable where a bug stands (upstream quirk)`, which pins
139 for a flat cell, and `elevation renders monotonically across the ramp`, which pins the
ends.


*Why the scale is kept, having first been dropped.* The port initially mapped the type's
full range — `clampByteRamp(e + 127)`, one palette index per unit of elevation — on the
reasoning that ±127 is what the storage holds. That is 13x less contrast than the original
view, and it is not a theoretical loss: a seeded world's relief is about -11..+14, which
lands in palette indices 116..141 of 252, so the view built to show terrain rendered a
near-uniform yellow field. The defect being fixed was the *wrap*, never the scale:
`MAX_TERRAIN` was serving two purposes — a divisor in the sense and view formulas, and a
nominal ceiling that held on one deposit path out of four. On the
original's own numbers flat ground sits at 139 and terrain 10 at the top of the ramp; the
port reproduces that, and states the saturation at both ends (terrain −10 computes 0 and
is held at 1; terrain 10 computes 254 and is held at 252, the last two indices being
reserved) rather than wrapping past them.

The seeding that gives the world its relief is part of the same feature: `seedTerrain()`
lays down a random field and blurs it (two 3x3 passes). A per-cell random field is not
terrain — every step's climb cost would be an independent draw — so the blur is what
makes the gradient real. It is not upstream behaviour; upstream has no seeding at all,
because a world is saved and loaded rather than generated.

Tested in `elevation stays inside the signed byte under both sensory models` (seeding
roughness 200 with the blur off drives thousands of cells past both ends, which must
saturate rather than wrap — a wrapped store reports −128), `seeded ground is rolling, not
spiky` and `the terrain view maps elevation monotonically, holes at the red end` (which
also asserts the *legibility* property — one level of elevation moves the colour at least
twelve indices — the assertion that fails by a factor of twelve if the scale is dropped
again).

## 9. Fixed: view ramps saturate instead of wrapping

**Upstream.** The three scalar view formulas compute
`(int)((252 - 1) * (value - min) / (max - min)) + 1`, and their `unsigned char` return
wraps mod 256 when `value` falls outside `[min, max]` — reachable for energy above
`max_energy`, age beyond `max_age`, and DNA size above `max_data`. Unlike §2 this is
*defined* behaviour in C (an int converts modularly), so it is not UB — but a bug at
above-maximum energy renders at the **low** end of the ramp, which is the opposite of what
the ramp is for.

**The port.** `clampByteRamp(value)` (`dish.ts`) saturates to `1..MAX_BUG_COLOR (252)`,
which keeps the purple energy (255), magenta poison (254) and cyan (253) sentinels out of
reach while leaving every in-range value bit-identical to upstream's. Tested in
`the view ramps saturate at the ends of the ramp instead of wrapping`.

## 10. Diverged: parameters report what they did

**Upstream.** `Settings::apply()` builds a fresh `WorldParams` and hands it to
`set_world_params()`, which copies the struct (`petri_dish.cpp:120`) and does nothing else.
Which fields that changes is then decided by where each one happens to be read: a value the
step phase reads takes effect on the next tick, and a value consumed in the constructor — the
grid's dimensions, the poison count — silently does nothing at all, with nothing to say
which is which. The dialog offers both kinds side by side, and its width and height fields
are permanently disabled, which is the authors' own workaround for the half they could not
make live.

**The port.** `PetriDish.setParams()` (`dish.ts`) returns a report rather than leaving the
caller to guess: `applied` (read by the step phase or `balance()`, live on the next tick),
`deferred` (a `Processor`'s `stepsPerUpdate` and `stackSize`, which reach bugs born after the
change, because a Processor is built with them and keeps them), `ignored` (`width`, `height`
and `poison`, refused rather than half-applied so that `params.width` can never disagree with
the grid it describes), and `refused`.

Two choices beyond the report. It is **atomic**: a set that breaks a range the simulation's
own arithmetic divides by (`minData/maxData`, `minEnergy/maxEnergy`, `minEEnergy/maxEEnergy`)
is refused whole and named, because half a world applied is a state nobody can reason about
afterwards. And `worldParams` returns a **copy**, so a caller cannot quietly change the
world's rules behind setParams' back.

Tested in `setParams makes a live field live, in both directions`, `setParams defers per-bug
fields to the next generation`, `setParams ignores fields the constructor owns, without
half-applying them` and `setParams refuses an inverted range atomically`.

## 11. Not yet ported

World serialisation: upstream saves and loads worlds through `QDataStream`
(save/save-as/autosave). The port has no persistence. Note that upstream itself does
**not** serialise `viewMode`, so a loaded world always renders in Default.

## 12. Diverged: there is no terrain at all

**Decision (Scott Ellis, 2026-09-16).** The port has no terrain: no elevation grid, no
digging, no climb cost, no terrain view, no roughness control. The world is flat and
nothing in the simulation changes the ground. This is a deliberate divergence from
upstream, made for a reason that has nothing to do with fidelity — and it is recorded
in the form the decision needs: what was removed, what was kept, and the measurement
that justified it.

**Why.** The ground appears to sterilise the world. Upstream's terrain is not static
scenery — deaths deposit payload and digs write relief, so the world's own bugs
continually redraw the surface under themselves — and the move rule charges
`moveEnergy * (climb + 1)` per step. Measured over 24 seeds (2024, 1-23), each run
10,000 ticks and then a forced die-off followed by 60,000 more, with a separate arm of
60,000 ticks from genesis (`tools/escape-probe.mts`):

| | re-ignites after a die-off | reproduces from a fresh world |
|---|---|---|
| no terrain (this port) | **16 / 24** | **16 / 24** |
| terrain, roughness 20 | 0 / 24 | 0 / 24 |
| terrain, roughness 0 (seeded flat) | 0 / 24 | 3 / 24 |

The third row is the control that matters: with the terrain code present but seeded
*flat* — which is the world this port now has by construction — a die-off was still
terminal in 24 of 24, and a fresh world reproduced in 3 of 24. So the blocker is the
terrain feature rather than its amplitude, and the seeding RNG is not what moves the
result.

Three limits on that evidence, stated because the honest version of a decision record
includes what it does not cover:

- **It is not a complete explanation.** 8 of the 24 seeds never re-ignite even with the
  terrain gone (1, 3, 7, 8, 13, 20, 22, 23). The ground was *a* barrier, not the only
  one: removing it moves the odds from 0/24 to 16/24, and does not make the world safe.
- **The mechanism is a reading, not a measurement** — and the tool that could have
  settled it is deleted with the feature. `tools/repro-probe.mts` (git history) swept
  roughness and reported mean step cost alongside the population's energy
  distribution, which is precisely the difference between "the bugs cannot afford the
  trip" and "the bugs never reach the threshold": two mechanisms that look identical
  from outside and would want opposite responses. What is measured is the behaviour.
  The explanation I give for it — relief makes the trip expensive, and a reproducing
  world needs a roamer to reach an occupied cell — is an inference that fits the
  behaviour, not a measurement that establishes it.
- **It answers the die-off question, not the long-run one.** On the finer statistic of
  replacements per death after a die-off, flat ground improved the early run
  (0.46-0.57 against 0.31) and still decayed to ~0.3 later in the run. This change was
  made on the strength of the table above; the table above is all it claims.

**What was removed.** The terrain array and its accessors (`setTerrain`, `terrainAt`,
`seedTerrain`), the elevation clamp with `MAX_TERRAIN` and `TERRAIN_FLAT`, the terrain
writes in the dig and payload-drop branches, the bug's `payload` field (it existed only
to be spent on digs and to multiply the move cost), the climb term in the move rule — a
flat world's climb is always 0 — the deposit a death made into its own cell, and the
`VM_TERRAIN` view branch with its control. Two tools went with it, `terrain-probe.mts`
and `repro-probe.mts`, because they could not be written against anything else. The
terrain measurements in `web/README.md` also went; git history keeps them.

**What was kept, at the time.** The VM's input layout is upstream architecture — 27
slots in three nine-slot groups. The terrain group (slots 9-17) was left in place and
written every tick with the constant `TERRAIN_SENSE = 1`, on the argument that
collapsing the layout would renumber the sense channels §1 and §2 are about, in a
change that was supposed to be about the ground. **That argument expired with the
switch: the group was removed on 2026-09-17 along with the shipped-sense model, and
the layout is now 20 slots (§13).**

**The fingerprint changed, and had to.** `3030175021` (`0xb49ccd2d`) →
**`2368350942`** (`0x8d2a2ade`), seed 2024, SIGHTED, 200 steps. The fingerprint hashes
every view index plus the counters, so removing a view mode and changing what a bug
senses *must* move it — a changed fingerprint is a failure unless a recorded divergence
explains it, and this section is that explanation. The components move with it and are
pinned in `test/fingerprint.test.ts`: pop 81, time 200, maxGen 2, births 21, deaths 59,
bugEnergy 40106, energyEnergy 76019.

---

## 13. Diverged: one sensory model, and no altitude group

**Decided, not drifted.** §1 kept upstream's broken senses as a selectable mode so the
difference could be demonstrated rather than asserted, and §12 kept the nine-slot
altitude group as a constant because the 29-slot layout was treated as the genome's
contract. Both were reproduction aids, and both were removed on 2026-09-17 by the
owner's instruction. Three things follow, and they are the three worth recording.

**The switch was never fidelity.** Upstream had exactly one sensory space: the broken
one, fixed in `fb3e2d4`. `AS_SHIPPED` was the port's diagnostic, not a mode of the
original, and a diagnostic can be retired once its finding is written down. The finding
stands in §1 and in `web/README.md`, which keeps the measurements it produced and now
marks them historical — they cannot be re-run here, and a number that cannot be re-run
must say so where it is quoted.

**A constant channel is not a sensory channel.** The altitude group read `1` at every
cell, every tick, forever. It carried no information about the world; a program could
only branch on it, and a human reading the layout could mistake it for a measurement.
Nine slots of dead input are worse than nine fewer slots. So the layout is **20:
colour 0-8, energy 9-17, the bug's own energy as a little-endian pair at 18-19** —
upstream's order with the hole closed, not a renumbering that shuffles the survivors.
`INPUTS` in `src/sim/processor.ts` carries the reason.

**The cost, stated plainly.** Slot 9 is now grid energy where it used to be the constant
1, and the own-energy pair moved from 27/28 to 18/19. A faithful reading of upstream's
*actual* pre-fix behaviour is no longer available from this port — git history is the
only place it lives. Fidelity to intent is this port's charter (§ preamble), and the
intent never included an altitude reading on flat ground.

**The fingerprint changed, and had to.** `2368350942` (`0x8d2a2ade`) →
**`2372629348`** (`0x8d6b7364`), seed 2024, 200 steps. The hash covers every view index
and the counters, and this change alters what every program reads — so it could not
stay put. New components, pinned in `test/fingerprint.test.ts`: pop 77, time 200,
maxGen 3, births 49, deaths 74, bugEnergy 40030, energyEnergy 76067. Population at 200
ticks falls slightly (81 → 77) — noise in a chaotic world, not a signal, and not a
reason to prefer one layout over the other.
