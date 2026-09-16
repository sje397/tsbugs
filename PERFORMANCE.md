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

## Where a tick actually goes

`stepsPerUpdate` is the only knob that changes VM work without changing the
world's shape, and every Processor reads it at construction — including children
and balance-spawned bugs. Sweeping it and dividing by population gives cost per
bug per tick as a function of VM steps per bug:

```
steps/bug  seed   us/tick  pop    us/tick/bug
        0  2024    42.14  141.7       0.2973
       16  2024    74.13   88.6       0.8366
       32  2024    93.42   90.6       1.0309
       64  2024   136.83   94.1       1.4546
      128  2024   214.88   96.0       2.2384
```

Between adjacent high points the *marginal* cost of a VM step is stable:

| interval | us per VM step per bug |
|---|---|
| 16 -> 32 | 0.01214 |
| 32 -> 64 | 0.01324 |
| 64 -> 128 | 0.01225 |

**Do not read the fitted intercept of 0.524 as fixed overhead.** At
`stepsPerUpdate = 0` a bug never executes, so it never moves, senses, eats or
reproduces — the non-VM work itself changes shape, and the fit is flattered by
that (r^2 0.96 mostly reflects the linear trend across the range, not a clean two-
term decomposition). The defensible reading is the marginal slope, and it says:

- **one VM step per bug costs ~12-13 ns**
- at the shipped `stepsPerUpdate = 64`, the VM is **~0.80 us of the ~1.45 us** a
  bug costs per tick — **roughly 55-60%**
- the remaining **~40-45%** is the world: the occupied-cell loops (eating,
  seeing, terrain and energy transfer), movement and death, `balance()`, and the
  per-cell view updates

So the workload is a scalar, per-bug, branch-heavy interpreter plus per-cell
bookkeeping. Neither half is a wide uniform pass over the grid.

## The shape of the work

| | value |
|---|---|
| World | 240 x 240 = 57,600 cells |
| Population | 90-123 in this configuration; `balance()` bounds it to ~100-250, hard ceiling 2000 |
| Occupancy | ~99/57,600 = **0.17%** |
| Tick | 0.140 ms (Node) to 0.175 ms (browser); 0.140-0.175 ms overall |
| Per bug per tick | 1.4-1.6 us |
| Full-grid pass | 1.36-1.52 ms — **~9 ticks** — at 24-26 ns/cell |
| Per bug memory | DNA 4,096-8,192 B **x2** (the `Dna` holds one copy; `Processor` takes another via `rom.slice()`, a deliberate divergence from the original's shared `ram = rom`) + 64 B stack = **8-16 KB** |
| Per world memory | grid arrays ~675 KB (Int32 energy, Int32 bugTotal, Int8 terrain, 3 x Uint8) + bugs ~0.8-1.6 MB = **~1.5-2.3 MB** |

A tick touches ~99 cells out of 57,600. That is the single most important fact
here: the simulation is **sparse and latency-bound**, not throughput-bound, and
the grid is only paid for in full when something forces a full pass (a view-mode
change, or a renderer that recomputes every cell instead of updating the cells
that changed).


Two costs are easy to conflate here, and conflating them is how a doc goes wrong:
the **full-grid pass** is `updateAllPixels()`, which recomputes every cell's view
byte (Node, `npm run bench`), and the **draw** is the page's `draw()` — palette
expansion, `putImageData`, then the scaled `drawImage`. They are different work in
different processes: ~1.4 ms against ~0.24 ms. Only the second happens per frame.

The Node and browser samples no longer overlap: this run reads 7,164 ticks/s in
Node against 5,709-5,907/s in the browser, so Node is ~20% faster on the same box.
The earlier "overlap" reading came from samples taken on an earlier build; one run
each is not enough to say whether the gap is the build or the environment, so it
is recorded rather than explained.

## Verdict

### The page: yes, already done, and there is no performance pressure to relieve

At the default 4 ticks/frame the simulation costs ~0.69 ms of a 16.7 ms frame
(4 x 0.172 ms/tick; the same budget would hold ~97 ticks). The blit costs
0.244 ms — 0.242, 0.245, 0.246 over three runs, so about 1.4 ticks, and a tick
plus a draw is 0.93 ms of the frame. An earlier two-sample reading of 0.042 and
0.203 ms is superseded: the spread there was scheduling, but the cost is real
work and is reproducible on the single-file build — and "we could not measure it"
is a different claim from "it costs a quarter of a millisecond". The page is ~18x
inside its frame budget at the settings it ships with.

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
  **6,037-6,261 ticks/s in Node / 5,709-6,420 in the browser** for one world
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

`fingerprint()` (seed 2024, roughness 20, SIGHTED, 200 steps -> **3030175021**) is
the acceptance test for any reimplementation, on any hardware. A GPU kernel that
is faster and produces a different simulation has not been written yet; it has
been substituted for one.
