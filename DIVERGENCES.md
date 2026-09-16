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

**The port.** Defaults to `SenseModel.SIGHTED`, which is `fb3e2d4` semantics — the
graded, correctly routed reading. `SenseModel.AS_SHIPPED` reproduces the pre-fix
behaviour, and `test/dish.test.ts` runs the model comparison over both so the
difference is pinned rather than described. `AS_SHIPPED` exists to reproduce the
original's actual behaviour, not as a supported mode.

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
