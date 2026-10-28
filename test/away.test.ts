/**
 * The return-from-hidden arithmetic.
 *
 * The interesting cases are all at the edges rather than in the middle: a middle
 * value is `away * rate` and nothing can go wrong with it. What can go wrong is a
 * rate that was never measured, a run that was paused, and a clamp that quietly
 * turns an offer into nothing -- so those are what is pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_MAX_TICKS, AWAY_MIN_MS, describeAway, planCatchUp } from '../src/ui/away.js';

test('a run that is going, measured, and away long enough is owed its elapsed ticks', () => {
  // 5 s at the sampled rate of a two-dot world (1,920 ticks/s).
  assert.deepEqual(planCatchUp({ awayMs: 5000, ticksPerSecond: 1920, running: true }), {
    wanted: 9600,
    skipped: null,
  });
});

test('a paused run owes nothing, and says it was paused rather than short', () => {
  const plan = planCatchUp({ awayMs: 600_000, ticksPerSecond: 1920, running: false });
  assert.deepEqual(plan, { wanted: 0, skipped: 'paused' });
});

test('a glance is not away: under the threshold nothing is owed', () => {
  assert.deepEqual(planCatchUp({ awayMs: AWAY_MIN_MS - 1, ticksPerSecond: 1920, running: true }), {
    wanted: 0,
    skipped: 'glance',
  });
  // And the threshold itself is included, because a boundary that excludes itself
  // makes the constant read as one less than it is.
  assert.equal(planCatchUp({ awayMs: AWAY_MIN_MS, ticksPerSecond: 1, running: true }).wanted, 1);
});

test('an unmeasured rate owes nothing: a number that is not a number is not a slow run', () => {
  for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.5, -1920]) {
    assert.deepEqual(
      planCatchUp({ awayMs: 60_000, ticksPerSecond: rate, running: true }),
      { wanted: 0, skipped: 'unmeasured' },
      `rate ${rate} should not invent ticks`,
    );
  }
  for (const away of [Number.NaN, Number.POSITIVE_INFINITY, -60_000]) {
    assert.deepEqual(
      planCatchUp({ awayMs: away, ticksPerSecond: 1920, running: true }),
      { wanted: 0, skipped: 'unmeasured' },
      `away ${away} should not invent ticks`,
    );
  }
});

test('the count is floored, so it never claims a tick that has not elapsed', () => {
  // 1,005 ms at 1,920/s is 1,929.6 ticks: the absence supports 1,929.
  assert.equal(planCatchUp({ awayMs: 1005, ticksPerSecond: 1920, running: true }).wanted, 1929);
});

test('an absurd absence is clamped instead of overflowing a tick count', () => {
  // A week away at a fast rate is far past the clamp. The clamp is not a policy --
  // the caller's compute budget is -- but a value that is not a finite tick count
  // would break the loop that spends it.
  const plan = planCatchUp({ awayMs: 7 * 24 * 3600 * 1000, ticksPerSecond: 5000, running: true });
  assert.equal(plan.wanted, AWAY_MAX_TICKS);
  assert.equal(plan.skipped, null);
  assert.ok(Number.isSafeInteger(plan.wanted));
});

test('every skip reports zero owed, so a caller cannot spend a tick it was told it was not offered', () => {
  const inputs = [
    { awayMs: 60_000, ticksPerSecond: 1920, running: false },
    { awayMs: 10, ticksPerSecond: 1920, running: true },
    { awayMs: 60_000, ticksPerSecond: Number.NaN, running: true },
    { awayMs: 60_000, ticksPerSecond: 0, running: true },
    { awayMs: Number.NaN, ticksPerSecond: 1920, running: true },
  ];
  for (const input of inputs) {
    const plan = planCatchUp(input);
    assert.notEqual(plan.skipped, null, `${JSON.stringify(input)} should have been skipped`);
    assert.equal(plan.wanted, 0, `${JSON.stringify(input)} was skipped but offered ticks`);
  }
});

test('the away duration reads in the unit a person would use', () => {
  assert.equal(describeAway(999), '1s');
  assert.equal(describeAway(45_000), '45s');
  // A whole minute keeps its zero seconds: "1m" alone reads as "about a minute",
  // and this number is quoted next to an exact tick count.
  assert.equal(describeAway(60_000), '1m 0s');
  assert.equal(describeAway(252_000), '4m 12s');
  assert.equal(describeAway(3_600_000), '1h 0m');
  assert.equal(describeAway(3_720_000), '1h 2m');
});
