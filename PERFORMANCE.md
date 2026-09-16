# Performance, and what a GPU would and would not buy

Two questions were asked: can this run on a web page, and what could move to a
GPU. The first is answered by `web/` — a running page. This file answers the
second with measurements of the real interpreter, not of a model of it. An
earlier answer to this question came from a standalone benchmark that *modelled*
the VM; it produced a 9.47x figure that cannot support any recommendation, and it
is superseded by everything below.

## How these numbers were obtained

| Measurement | Where | Samples |
|---|---|---|
| Tick cost, full-grid pass | `npm run bench` (Node) | 3 runs |
| Tick cost, full-grid pass, blit | the page, via `window.__tsbugs.bench()` | 3 runs |
| VM share of a tick | `npm run vm-share` — `stepsPerUpdate` sweep | 3 seeds x 6 values |
| Fingerprint (correctness) | `npm test`, and the same call in the page | see `web/README.md` |

One machine: M4 Max, 128 GB. All figures are single-threaded JavaScript —
Node 22 and Chromium on the same box, no SIMD, no WASM, no JIT tricks beyond what
the engines do on their own.

Everything in this file was re-measured on 2026-09-16, after terrain was removed
(`DIVERGENCES.md` §12). The figures it carried before that describe a build whose
world half still included terrain — the sensing, the digging and the climb cost — and
they are not comparable to these: the world half got cheaper, so the VM share rose
and every tick-rate figure moved. Where a number below differs from one quoted in an
earlier revision, this is why.

## Where a tick actually goes

`stepsPerUpdate` is the only knob that changes VM work without changing the
world's shape, and every Processor reads it at construction — including children
and balance-spawned bugs. Sweeping it and dividing by population gives cost per
bug per tick as a function of VM steps per bug:

```
steps/bug  seed   us/tick  pop    us/tick/bug
        0  2024    36.84  141.7       0.2599
        8  2024    56.39   95.4       0.5911
       16  2024    66.05   91.5       0.7217
       32  2024    82.19   90.6       0.9071
       64  2024   117.31   90.7       1.2931
      128  2024   195.10   99.2       1.9664
```

Between adjacent high points the *marginal* cost of a VM step is stable:

| interval | us per VM step per bug |
|---|---|
| 16 -> 32 | 0.01159 |
| 32 -> 64 | 0.01206 |
| 64 -> 128 | 0.01052 |

**Do not read the fitted intercept of 0.440 as fixed overhead.** At
`stepsPerUpdate = 0` a bug never executes, so it never moves, senses, eats or
reproduces — the non-VM work itself changes shape, and the fit is flattered by
that (r^2 0.97 mostly reflects the linear trend across the range, not a clean two-
term decomposition). The defensible reading is the marginal slope, and it says:

- **one VM step per bug costs ~11-12 ns** — the marginal slope barely moved when
  terrain was removed, which is the expected result: it is the world half that
  changed, not the interpreter
- at the shipped `stepsPerUpdate = 64`, the VM is **~0.79 us of the ~1.23 us** a
  bug costs per tick — **64%** (`npm run vm-share` reports the split directly)
- the remaining **~36%** is the world: the occupied-cell loops (eating, seeing,
  energy transfer), movement and death, `balance()`, and the per-cell view updates

So the workload is a scalar, per-bug, branch-heavy interpreter plus per-cell
bookkeeping. Neither half is a wide uniform pass over the grid.

## The shape of the work

| | value |
|---|---|
| World | 240 x 240 = 57,600 cells |
| Population | 78-103 in this configuration; `balance()` bounds it to ~100-250, hard ceiling 2000 |
| Occupancy | ~90/57,600 = **0.16%** |
| Tick | 0.141-0.144 ms (Node and browser, overlapping ranges) |
| Per bug per tick | 1.23 us |
| Full-grid pass | 1.53-1.57 ms (Node), 1.1-2.1 ms (browser) — **~11 ticks** — at 24-27 ns/cell |
| Per bug memory | DNA 4,096-8,192 B **x2** (the `Dna` holds one copy; `Processor` takes another via `rom.slice()`, a deliberate divergence from the original's shared `ram = rom`) + 64 B stack = **8-16 KB** |
| Per world memory | grid arrays ~560 KB (Int32 energy, Int32 bugTotal, 2 x Uint8 for the view and bug colours) + bugs ~0.8-1.6 MB = **~1.4-2.2 MB** |

A tick touches ~99 cells out of 57,600. That is the single most important fact
here: the simulation is **sparse and latency-bound**, not throughput-bound, and
the grid is only paid for in full when something forces a full pass (a view-mode
change, or a renderer that recomputes every cell instead of updating the cells
that changed).


Two costs are easy to conflate here, and conflating them is how a doc goes wrong:
the **full-grid pass** is `updateAllPixels()`, which recomputes every cell's view
byte (Node, `npm run bench`), and the **draw** is the page's `draw()` — palette
expansion, `putImageData`, then the scaled `drawImage`. They are different work in
different processes: ~1.5 ms against ~0.22-0.38 ms. Only the second happens per frame.

The Node and browser samples overlap: 6,945-7,086 ticks/s in Node against
6,957-7,070/s in the browser (three runs each, Chrome driven headless through
Playwright on this box), so the two engines cost the same for this work. Earlier
revisions of this paragraph read a ~20% gap and then an overlap, from samples taken on
earlier builds and in different machine states. One asymmetry is left unexplained
rather than smoothed over: the browser's full-grid pass is steady-state 1.1-1.2 ms
against Node's 1.53-1.57 ms, which is more than engine noise should account for and is
recorded, not attributed.

## Verdict

### The page: yes, already done, and there is no performance pressure to relieve

At the default 4 ticks/frame the simulation costs ~0.57 ms of a 16.7 ms frame
(4 x 0.142 ms/tick; the same budget would hold ~117 ticks). The draw costs
0.218-0.382 ms over three runs, so about 1.5-2.7 ticks, and a frame's four ticks plus
a draw is ~0.84 ms. An earlier two-sample reading of 0.042 and 0.203 ms was superseded
by a three-run 0.244 ms, and that in turn by these figures: the spread in the early
samples was scheduling, but the cost is real work and is reproducible on the
single-file build — "we could not measure it" is a different claim from "it costs a
fraction of a millisecond". The page is ~20x inside its frame budget at the settings
it ships with.

Nothing about this needs a GPU. WebGPU on the page is worth considering only as a
*scaling* decision — larger worlds, or many full-field views per frame — not as a
way to make this page faster, because this page is not slow.

### One world on a GPU: no

The dominant cost is ~99 independent scalar interpreters, each with its own
instruction pointer, stack, RAM and a data-dependent branch per opcode. That is
the worst case for a GPU: divergence makes wide lanes idle, and 99 lanes is a
rounding error against a GPU's 10^4-10^5 lane capacity. Per-lane state is also
randomly accessed (DNA and RAM indexed by computed addresses), so it is
uncoalesced. Adding a GPU to one 240 x 240 world would add dispatch and readback
latency to buy throughput that is not needed.

### Batch evolution: the only GPU-shaped case, and the gain is unmeasured

The parallelism this workload *does* have is across independent worlds. K worlds
run concurrently = K x ~99 lanes, and the memory is cheap: at ~2 MB per world,
1,000 worlds is ~2 GB and 10,000 is ~20 GB, both comfortable in 128 GB unified
memory. At K = 64 there are ~6,300 lanes, which is inside the range where a GPU
can be competitive; at K = 10 it is not.

**I am not quoting a speedup, because I have not measured one.** Everything above
this line is measured; this paragraph is not. What a GPU port would be worth is a
question for a spike, and the spike has a precise shape:

- port the occupied-cell loops and the VM step for one world; run K of them side
  by side in one WebGPU dispatch
- measure end-to-end throughput including dispatch and readback, against
  **6,945-7,086 ticks/s in Node / 6,957-7,070 in the browser** for one world
- the port is worth building iff it beats K x that, at a K we actually want

The honest prediction, labelled as a prediction: this would need K in the tens to
hundreds to break even, and would only pay off for parameter sweeps and
evolutionary search — not for the interactive artefact.

### The renderer: uniform, and therefore GPU-shaped, but it pays only at scale

A full-grid pass is uniform per-cell work with no divergence, which is the best
case for a GPU — and it is 24-26 ns/cell in plain JS. It just is not on the
critical path: the incremental renderer touches ~99 cells a tick, and a full pass
costs ~9 ticks, so the renderer is only paid in full when a view mode changes.
That means a WebGPU renderer is worth it at world sizes well beyond the current
one (a 2400 x 2400 world would be ~140 ms per full pass in JS) and not before.

## What would change these answers

- **Population.** Everything here is at ~99 bugs. If `balance()`'s thresholds were
  raised so the population ran at tens of thousands, the lane arithmetic inverts
  and the GPU case for one world becomes real. The ceiling is currently 2000.
- **World size.** At 2400 x 2400 the *grid* becomes the dominant cost and the
  renderer becomes GPU-worthy for its own sake.
- **The goal.** For one interactive world this is answered and the answer is no.
  For "evolve 1,000 worlds and pick the best", the answer is maybe, and it is one
  spike away from being a measurement.

## A GPU port must not break the fingerprint

`fingerprint()` (seed 2024, SIGHTED, 200 steps -> **2368350942**) is
the acceptance test for any reimplementation, on any hardware. A GPU kernel that
is faster and produces a different simulation has not been written yet; it has
been substituted for one. The number moved once, deliberately, when terrain was
removed (`DIVERGENCES.md` §12) — a change to the world that a faithful port must
reproduce, not an instance of drift. Any *unintended* move is still a failure, and
the test that distinguishes the two is whether a recorded divergence explains it.
