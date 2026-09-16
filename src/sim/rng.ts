/**
 * Randomness.
 *
 * The original calls the global C `qrand()` from many places. A seeding call
 * does exist — `qsrand(midnight.secsTo(QTime::currentTime()))`, from the wall
 * clock — but it sits in `UpdateThread::run()` (main_window.h:52-53), and every
 * start()/wait() on that thread is commented out (main_window.cpp:59, 116, 129,
 * 137, 138). `run()` therefore never executes and the seed is never applied, so
 * upstream draws from Qt's default seed — which on its own would be perfectly
 * reproducible. It is not, because QtConcurrent::blockingMap runs the per-cell
 * work in parallel while every thread shares that one global generator, so the
 * *order* in which draws are consumed is genuinely racy. Upstream has no
 * reproducible trajectory at all; what it defines is an *ensemble*.
 *
 * This port therefore cannot be bit-identical to any upstream run, and claiming
 * otherwise would be false. What it does is sample the same ensemble, with the
 * same draws in the same structural order, from one seeded stream — the
 * strongest fidelity claim available, and the only one that makes results
 * reproducible.
 *
 * The `% n` forms are kept rather than replaced with an unbiased range helper,
 * because upstream's modulo bias is part of its behaviour.
 *
 * NOTE ON PARALLELISM: a single stream is correct only while execution stays in
 * one thread. Per-bug streams derived from (seed, bug identity) are the
 * prerequisite for deterministic parallel execution — with a shared stream, the
 * result depends on interleaving. That change alters the correlation structure
 * between bugs, so it is a deliberate step to take when parallelism lands, not
 * a silent refactor to slip in now.
 */

/** C's RAND_MAX on every platform this ever ran on. */
export const RAND_MAX = 2147483647;

/**
 * mulberry32 degenerates on a zero state, so fold zero onto a constant.
 * Every other seed passes through unchanged, which keeps seeds like 1, 42 and
 * 12345 meaning what they look like.
 */
function normaliseSeed(seed: number): number {
  return (seed >>> 0) || 0x9e3779b9;
}

/**
 * The draw interface the simulation depends on.
 *
 * Parameterising on this rather than on Rng lets a test drive every branch
 * deterministically with a scripted source, instead of hoping a seeded sequence
 * happens to land in the branch under test.
 */
export interface RandomSource {
  /** An integer in [0, RAND_MAX]. */
  next(): number;
  /** `qrand() % n`. */
  int(n: number): number;
  /** `qrand() / (float)RAND_MAX`. */
  float(): number;
}

/** A deterministic stand-in for qrand(). */
export class Rng implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = normaliseSeed(seed);
  }

  /** Re-seed in place, so a simulation can be restarted from the same seed. */
  reseed(seed: number): void {
    this.state = normaliseSeed(seed);
  }

  /**
   * qrand() equivalent: an integer in [0, RAND_MAX].
   *
   * mulberry32 produces 32 bits; shifting off one bit gives 31, which is
   * exactly RAND_MAX's range, so `% n` behaves as it does upstream.
   */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) >>> 1;
  }

  /** `qrand() % n`, with upstream's modulo bias intact. */
  int(n: number): number {
    return this.next() % n;
  }

  /** `qrand() / (float)RAND_MAX` — a float in [0, 1]. */
  float(): number {
    return this.next() / RAND_MAX;
  }
}
