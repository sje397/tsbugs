/**
 * Does a saved world come back as the same world?
 *
 * The world can now be written to a file and read back (`src/ui/worldStore.ts`), so
 * the property that matters is not "a restore does not throw" but "a restored world
 * ticks into the world it was saved from". Anything not carried in the snapshot is
 * invisible until the two worlds diverge — and they diverge silently, because both
 * keep running and both look healthy.
 *
 * THREE WAYS TO GET THIS WRONG, each run here:
 *
 *   1. LOSSY SAVE. Take snapshot S0, run N ticks to reach A. Restore S0, run the
 *      same N ticks, reach B. A and B must be identical. A missing field shows up
 *      as a divergence at or after the tick that first reads it.
 *
 *   2. ALIASED SNAPSHOT. Restore the SAME snapshot object twice and tick the two
 *      worlds. If a restore adopted an array from the snapshot instead of copying
 *      it, the second world would share memory with the first and with the
 *      snapshot, and the two would contaminate each other. `Bug.restore` says it
 *      copies "because restoring the same snapshot twice would hand the second
 *      restore a genome the first had already changed" — this is that claim.
 *
 *   3. UNCARRIED RANDOM STREAM. Every bug's VM draws from the world's generator, so
 *      the stream position is part of the world. If it were not saved, both worlds
 *      would run, both would look plausible, and every RAND instruction would
 *      differ. Checked separately from (1) because a run with no RAND in it would
 *      hide this entirely: it is measured on a world whose programs DO use RAND.
 *
 *   node dist/tools/roundtrip-probe.mjs
 */

import { PetriDish, type WorldSnapshot } from '../src/sim/dish.js';
import { DEFAULT_PARAMS, type WorldParams } from '../src/sim/params.js';
import { Rng } from '../src/sim/rng.js';
import { Instruction } from '../src/sim/processor.js';

const TICKS = 300;

/**
 * The shipped configuration, unscaled. A lossy save only shows up when something
 * actually changes, and small hand-tuned worlds die out: the first version of this
 * probe used 60x60 with a quarter of the energy and measured 300 ticks containing
 * zero births, which would have passed against a world that did nothing at all.
 */
function worldParams(): WorldParams {
  return { ...DEFAULT_PARAMS };
}

/**
 * Everything in a snapshot, as a string. Typed arrays are included in full: a
 * digest over a hash would be cheaper and would hide which cell differed, and the
 * point of a divergence report is to name the first thing that moved.
 */
function digest(snapshot: WorldSnapshot): string {
  const parts: string[] = [];
  parts.push(`version ${snapshot.version}`);
  parts.push(`params ${Object.entries(snapshot.params).sort().map(([k, v]) => `${k}=${v}`).join(',')}`);
  parts.push(`counters ${Object.entries(snapshot.counters).sort().map(([k, v]) => `${k}=${v}`).join(',')}`);
  parts.push(`view ${snapshot.view.mode}/${snapshot.view.showByte}`);
  parts.push(`energy ${snapshot.energy.join(',')}`);
  parts.push(`bugTotal ${snapshot.bugTotal.join(',')}`);
  parts.push(`poison ${snapshot.poison.join(',')}`);
  for (const cell of snapshot.cells) {
    for (const bug of cell.bugs) {
      const p = bug.processor;
      parts.push(
        [
          `cell ${cell.hash}`,
          `genome ${Array.from(bug.genome).join('.')}`,
          `mut ${bug.mutationRate}`,
          `dir ${bug.dir} color ${bug.color} split ${bug.split} age ${bug.age}`,
          `children ${bug.children} gen ${bug.generation} energy ${bug.energy} marked ${bug.marked}`,
          `ram ${Array.from(p.ram).join('.')}`,
          `stack ${Array.from(p.stack).join('.')}`,
          `inp ${Array.from(p.inp).join('.')}`,
          `out ${Array.from(p.out).join('.')}`,
          `ip ${p.ip} sp ${p.sp} bp ${p.bp} acc ${p.accumulator}`,
        ].join(' '),
      );
    }
  }
  return parts.join('\n');
}

/** The first line that differs, so a failure names something. */
function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      const show = (s: string | undefined): string => {
        if (s === undefined) return '(absent)';
        return s.length > 160 ? `${s.slice(0, 160)}... (${s.length} chars)` : s;
      };
      return `line ${i + 1}:\n    A: ${show(left[i])}\n    B: ${show(right[i])}`;
    }
  }
  return 'no difference found, which contradicts the comparison that called this';
}

let failures = 0;

function fail(what: string, detail: string): void {
  console.log(`${what}: FAIL\n  ${detail}`);
  failures++;
}

function pass(what: string): void {
  console.log(`${what}: ok`);
}

// ------------------------------------------------------- 1. lossy save

{
  const forward = new PetriDish(worldParams(), new Rng(90210));
  for (let i = 0; i < 40; i++) forward.step(); // let a population exist

  const saved = forward.snapshot();
  const savedDigest = digest(saved);

  for (let i = 0; i < TICKS; i++) forward.step();
  const reached = forward.snapshot();

  // The snapshot must survive being digested and restored without having been
  // mutated by the digest — and then be restorable twice (case 2 uses this too).
  if (digest(saved) !== savedDigest) {
    fail('1. lossy save', 'the snapshot changed while it was being read, so it is a live view of the world');
  } else {
    const restored = PetriDish.restore(saved);
    for (let i = 0; i < TICKS; i++) restored.step();
    const replay = restored.snapshot();

    if (digest(replay) !== digest(reached)) {
      fail('1. lossy save', `the replayed world diverged from the original after ${TICKS} ticks:\n  ${firstDifference(digest(reached), digest(replay))}`);
    } else {
      pass(`1. lossy save (${TICKS} ticks replayed exactly; ${reached.counters.population} bugs in ${reached.cells.length} occupied cells, ${reached.counters.births} births and ${reached.counters.deaths} deaths over the run)`);
    }
  }
}

// ------------------------------------------------------- 2. aliased snapshot

{
  const base = new PetriDish(worldParams(), new Rng(4711));
  for (let i = 0; i < 40; i++) base.step();
  const shared = base.snapshot();
  const sharedDigest = digest(shared);

  const one = PetriDish.restore(shared);
  const two = PetriDish.restore(shared);

  // Ticking one must not move the other, nor the snapshot.
  for (let i = 0; i < 60; i++) one.step();
  const restedDigest = digest(two.snapshot());

  if (digest(shared) !== sharedDigest) {
    fail('2. aliased snapshot', 'restoring a snapshot changed the snapshot, so a restore adopts rather than copies');
  } else if (restedDigest !== sharedDigest) {
    fail('2. aliased snapshot', "ticking one world changed a second world restored from the same snapshot, so they share memory");
  } else {
    pass('2. aliased snapshot (two restores of one snapshot stay independent)');
  }
}

// ------------------------------------------------------- 3. random stream

{
  // A world of programs that all execute RAND, so the stream position is read on
  // every tick. Without this the save could drop the stream position and nothing
  // above would notice.
  const params = worldParams();
  const handmade = new PetriDish({ ...params, totalEnergy: 0, minBugEnergy: 0 }, new Rng(5150));
  const snapshot = handmade.snapshot();
  const genome = new Uint8Array(16);
  genome[0] = Instruction.RAND;
  genome[1] = Instruction.RAND;
  genome[2] = Instruction.OUT;

  const { Bug } = await import('../src/sim/bug.js');
  const seedBug = Bug.createRandom({ ...params, maxData: 17, minData: 16 }, new Rng(999)).snapshotState();
  seedBug.genome = genome;
  seedBug.processor = { ...seedBug.processor, ram: genome.slice() };
  seedBug.energy = 400;

  const crafted: WorldSnapshot = {
    ...snapshot,
    params,
    energy: new Int32Array(params.width * params.height),
    poison: new Uint8Array(params.width * params.height),
    bugTotal: new Int32Array(params.width * params.height),
    cells: [{ hash: 5 * params.height + 5, bugs: [seedBug] }],
    counters: { ...snapshot.counters, population: 1, bugEnergy: 400 },
  };

  const a = PetriDish.restore(crafted);
  for (let i = 0; i < 25; i++) a.step();
  const b = PetriDish.restore(crafted);
  for (let i = 0; i < 25; i++) b.step();

  const da = digest(a.snapshot());
  const db = digest(b.snapshot());
  if (da !== db) {
    fail('3. random stream', `two restores of one snapshot with RAND-running programs diverged:\n  ${firstDifference(da, db)}`);
  } else {
    // The control: the same program under two different starting stream positions
    // MUST differ, or the comparison above is comparing two worlds that never use
    // the generator.
    const shifted: WorldSnapshot = { ...crafted, counters: { ...crafted.counters, stream: crafted.counters.stream + 12_345 } };
    const c = PetriDish.restore(shifted);
    for (let i = 0; i < 25; i++) c.step();
    if (digest(c.snapshot()) === da) {
      fail('3. random stream', 'CONTROL DEAD: shifting the stream position by 12345 changed nothing, so these programs are not drawing from it and the check proves nothing');
    } else {
      pass('3. random stream (position is carried, and it is load-bearing)');
    }
  }
}

console.log(failures === 0 ? 'clean' : `${failures} failures`);
if (failures > 0) process.exitCode = 1;
