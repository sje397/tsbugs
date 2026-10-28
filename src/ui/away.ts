/**
 * What to do about the time a hidden tab was not running.
 *
 * A page the browser considers hidden is not given animation frames. The stage is
 * driven by `requestAnimationFrame`, so no frames means no ticks, and the world
 * comes back exactly where it was left. That is not a fault in this page and no
 * setting on it can turn it off: it is the same rule that stops every animation
 * on every hidden tab, and the browser is right to apply it. A world nobody is
 * looking at should not hold a core awake.
 *
 * So the question is not whether to keep running. It is what the return should
 * look like, and there are two honest answers:
 *
 *   - the world is where it was left, which costs nothing and is what happens now;
 *   - the world is advanced on return, by as much of the absence as can be bought
 *     back within a budget that does not make the page feel broken.
 *
 * This decides the second. What it does NOT do is pretend the two are the same:
 * the ticks a run gets through per second are real CPU work, so ten minutes away
 * on a fast world is minutes of it, and no budget a person will tolerate on
 * switch-back comes close. The caller therefore reports what it covered as well
 * as what it was owed, and this function's job is to say what was owed.
 *
 * The rate is passed in rather than assumed, because it is not a constant: a
 * two-dot world at speed 32 is thousands of ticks a second and a full dish is
 * tens, and a number baked in here would be wrong by two orders of magnitude on
 * one of them. The page already measures it for the stats panel.
 */

/**
 * Below this, the absence is a glance rather than away.
 *
 * Copying a line from another window takes about a second, and catching that up
 * would spend CPU to put the world back where it already was.
 */
export const AWAY_MIN_MS = 1000;

/**
 * The most a single return may be owed, as a backstop rather than a policy.
 *
 * A run left hidden overnight is worth more ticks than the simulation has states,
 * and the value is only ever used to compute a shortfall. This clamp exists so a
 * nonsense rate or a clock that jumped cannot produce a number that overflows
 * when it is rounded into a tick count; the real limit on a catch-up is the
 * compute budget the caller spends, not this.
 */
export const AWAY_MAX_TICKS = 5_000_000;

/** Why a return does not advance the world. */
export type AwaySkip = 'paused' | 'glance' | 'unmeasured';

export interface CatchUpPlan {
  /** Ticks the absence was worth, clamped. Zero exactly when `skipped` is not null. */
  wanted: number;
  /** Why nothing will be done about it, or null when `wanted` is a real offer. */
  skipped: AwaySkip | null;
}

export interface AwayInput {
  /** Wall-clock milliseconds the page was hidden. */
  awayMs: number;
  /** Ticks per second, as last measured while the page was visible. */
  ticksPerSecond: number;
  /** Whether the run was going at all. A paused run owes nothing. */
  running: boolean;
}

export function planCatchUp({ awayMs, ticksPerSecond, running }: AwayInput): CatchUpPlan {
  // A paused run owes nothing, and says so rather than reporting a glance: the
  // reader who paused, switched away and came back has one reason to be surprised
  // by nothing happening, and it is not the clock.
  if (!running) return { wanted: 0, skipped: 'paused' };

  // Both inputs come from measurement, and a measurement that is not a number is
  // not a slow run. Two failure modes are folded together here because they are
  // the same event -- the clock or the rate cannot be trusted -- and separating
  // them would invite a reader to treat one as normal.
  //
  // `NaN` is the one that bites: it survives every comparison below (`NaN < 1000`
  // is false), so it would reach the floor and produce `NaN` ticks, which as a
  // loop bound is false on the first test -- a catch-up that does nothing while
  // reporting that it ran. A negative away is a clock that went backwards, and
  // reading it as "a glance" would be a silent misdescription of that.
  if (!Number.isFinite(awayMs) || awayMs < 0 || !Number.isFinite(ticksPerSecond) || ticksPerSecond < 0) {
    return { wanted: 0, skipped: 'unmeasured' };
  }

  if (awayMs < AWAY_MIN_MS) return { wanted: 0, skipped: 'glance' };

  // Rounded down to a whole tick per second: a sub-1 rate is a run that is not
  // measurably moving, and `rate * seconds` on it would invent ticks.
  if (ticksPerSecond < 1) return { wanted: 0, skipped: 'unmeasured' };

  // Floored rather than rounded: the number is what the absence actually supports,
  // so it can never claim a tick that has not elapsed. A world run at 1,920 ticks
  // per second for 1,005 ms is owed 1,929, not 1,930.
  const wanted = Math.floor((awayMs / 1000) * ticksPerSecond);
  if (wanted < 1) return { wanted: 0, skipped: 'unmeasured' };

  return { wanted: Math.min(wanted, AWAY_MAX_TICKS), skipped: null };
}

/**
 * How long the page was away, in the words the banner uses.
 *
 * Minutes and hours rather than a total in seconds, because the number is read to
 * answer "how long was I gone" and 3,720 seconds makes the reader do the division.
 * Seconds stay exact below a minute: that is the range where the catch-up is
 * usually complete, and where a rounded "1 minute" would misdescribe it.
 */
export function describeAway(awayMs: number): string {
  const seconds = Math.round(awayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
