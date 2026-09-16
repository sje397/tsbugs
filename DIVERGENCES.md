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
and both edges are reachable in ordinary play:

- **Below zero** — bugs dig terrain negative (`terrain[hash] -= 1`, guarded only by
  `> 0` / `> 1`). `fb3e2d4` is what first routes terrain — a signed quantity — into
  this conversion; before it, the conversion read `energy`, which is never negative.
- **Above 255** — energy deposits are additive with no cap
  (`energy[hash] += e`), so a cell's energy can exceed `max_e_energy` (80).

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

## 8. Not yet ported

World serialisation: upstream saves and loads worlds through `QDataStream`
(save/save-as/autosave). The port has no persistence. Note that upstream itself does
**not** serialise `viewMode`, so a loaded world always renders in Default.

---

## Open, deliberately not decided

**View-colour values that leave the bug ramp.** The three scalar view formulas compute
`(int)((252 - 1) * (value - min) / (max - min)) + 1`, and their `unsigned char` return
wraps mod 256 when `value` falls outside `[min, max]` — reachable for energy above
`max_energy`, age beyond `max_age`, and DNA size above `max_data`. Unlike §2 this is
*defined* behaviour in C (an int converts modularly), so it is not UB — but a bug at
above-maximum energy would render at the **low** end of the ramp.

Recommendation: clamp to `1..MAX_BUG_COLOR (252)`, which keeps the purple energy and
magenta poison sentinels (253/254) and blue (255) out of reach. Not applied yet: this
belongs with the renderer, where it can be tested against the actual palette and
palette-index constants rather than guessed at. Flagged because it is the same class
as §2 and the same question — does the intent wrap or saturate.
