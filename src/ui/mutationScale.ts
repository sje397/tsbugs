/**
 * The mutation rate, as a slider position.
 *
 * A linear 0..1 slider was the first version, and it is unusable at the values
 * that matter. At 0..1 with 0.005 steps the smallest non-zero change is 0.005,
 * which is already 50 mutations' worth of births at a rate of 1 in 10,000 — so
 * the whole region where a mutation rate is interesting (1e-4 to 1e-2) occupied
 * 2% of the slider's travel and could not be reached except by hitting the two
 * leftmost pixels. The fix is a two-section scale: geometric below 0.1, linear
 * above it, because those are the two ways the number is read. Below, the
 * question is "one birth in how many"; above, it is "what fraction of births",
 * and equal fractions of a large number are the useful step there.
 *
 * WHY 0 IS ITS OWN POSITION, NOT A POINT ON THE CURVE
 *
 * A geometric scale cannot represent zero: there is no power of the ratio that
 * reaches it. Off is therefore position 0 alone, and every position above it is
 * strictly positive. That is also the distinction that matters in the simulation
 * — zero mutation is a world that can only drift, and it is worth being able to
 * land on exactly.
 *
 * THE SLIDER IS NOT AUTHORITATIVE
 *
 * It quantises. A rate that is not on its grid — 1e-9, or 0.1234 — has no exact
 * position, so `sliderPosition` returns the nearest one and the page keeps a
 * numeric box as the control that states a rate exactly. Reading a rate back
 * through the slider and applying the result would silently rewrite the value
 * (1e-9 becomes 1e-4, a hundred-thousandfold change), which is the failure this
 * split exists to prevent: the slider reports what it can, the box holds what is.
 */

/** The slider's range. Integer positions, so a keyboard arrow is one step. */
export const SLIDER_MAX = 1000;

/** The lowest non-zero rate the slider can produce. */
export const SLIDER_FLOOR = 1e-4;

/** Where the geometric section ends and the linear one starts. */
export const SLIDER_TOP = 0.1;

/** Positions 1..LOG_STEPS cover SLIDER_FLOOR..SLIDER_TOP geometrically. */
const LOG_STEPS = 500;

/** How much the geometric section rises per position: 1.4% at 500 steps over 3 decades. */
export const RATE_PER_STEP = Math.pow(SLIDER_TOP / SLIDER_FLOOR, 1 / (LOG_STEPS - 1));

/**
 * The rate a slider position stands for.
 *
 * Position 0 is off. 1..500 run from SLIDER_FLOOR to SLIDER_TOP by a constant
 * ratio; 501..1000 run from SLIDER_TOP to 1 by a constant difference. A position
 * outside 0..1000 is clamped rather than extrapolated: the ends are the ends, and
 * a slider cannot physically produce anything else.
 *
 * The result is rounded to four significant figures, because the positions are
 * 2.3% apart and the seventeenth digit of a rate reached by dragging is noise the
 * control never had. It is rounded HERE rather than at the display, so the number
 * the world is given, the number the box shows and the number the panel says are
 * one number: a rate printed to four figures while the world held seventeen would
 * be a panel disagreeing with itself. Four figures is nearly fifty times finer
 * than a step, so no position is lost to the rounding — asserted in the tests.
 */
export function sliderToRate(position: number): number {
  const p = Math.round(position);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= SLIDER_MAX) return 1;

  const rate = p <= LOG_STEPS
    ? SLIDER_FLOOR * Math.pow(SLIDER_TOP / SLIDER_FLOOR, (p - 1) / (LOG_STEPS - 1))
    : SLIDER_TOP + ((p - LOG_STEPS) / (SLIDER_MAX - LOG_STEPS)) * (1 - SLIDER_TOP);
  return Number(rate.toPrecision(4));
}

/**
 * The slider position nearest a rate, or null when the slider cannot reach it.
 *
 * Null is for the two values the scale cannot represent: anything above 1 (not a
 * probability) and anything strictly between 0 and SLIDER_FLOOR (below the floor
 * and above off). Both are real things a world can hold, and neither is a
 * rounding error to be rounded away — a rate of 1e-9 says "this world effectively
 * does not mutate", and reporting it as 1e-4 would be a different world.
 */
export function sliderPosition(rate: number): number | null {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  if (rate === 0) return 0;
  if (rate < SLIDER_FLOOR) return null;
  if (rate >= SLIDER_TOP) return Math.round(LOG_STEPS + ((rate - SLIDER_TOP) / (1 - SLIDER_TOP)) * (SLIDER_MAX - LOG_STEPS));

  const t = Math.log(rate / SLIDER_FLOOR) / Math.log(SLIDER_TOP / SLIDER_FLOOR);
  return Math.max(1, Math.min(LOG_STEPS, Math.round(1 + t * (LOG_STEPS - 1))));
}

/** Thousands separators, so "1 birth in 10000" and "in 10000" are not read as the same figure. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What a rate means in the units a reader can check it against.
 *
 * Below one birth in twenty the reading is a countable frequency ("1 birth in
 * 8,333 is mutated"), because that is the form the number is actually reasoned
 * about in. Above it, a percentage, because "1 birth in 1.6" is not a sentence
 * anyone parses. The branch is a comparison on the RATE rather than on its
 * reciprocal, so 0.05 is one side of the cut and not whichever side a rounding
 * error put it on that day. The rate itself always leads, so the summary never stands in
 * for the number the world holds.
 */
export function describeRate(rate: number): string {
  if (rate === 0) return 'no mutation';
  if (!Number.isFinite(rate)) return 'not a rate';

  if (rate <= 0.05) return `1 birth in ${grouped(Math.round(1 / rate))} is mutated`;

  const percent = rate * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}% of births are mutated`;
}

/**
 * The rate as the page states it: the number, then what it means.
 *
 * The number is printed exactly as it stands, not to a tidy fixed width. Every
 * place this appears is beside a control or a saved world holding that very value,
 * and a line reading "0.0001234" next to a box reading "0.00012345" is the panel
 * disagreeing with the thing it describes. Rates the controls produce are already
 * as short as they need to be — the slider rounds to four figures and the box
 * applies what was typed — so the width is settled at the source, not here.
 */
export function summariseRate(rate: number): string {
  if (!Number.isFinite(rate)) return 'not a rate';
  return `${rate} — ${describeRate(rate)}`;
}
