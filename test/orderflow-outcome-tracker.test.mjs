import test from "node:test";
import assert from "node:assert/strict";

import { OutcomeTracker } from "../orderflow/src/outcome-tracker.js";

const buy = { state: "buy", score: 60, confidence: 0.9, spoofRisk: 0.1 };
const sell = { state: "sell", score: -60, confidence: 0.9, spoofRisk: 0.1 };
const neutral = { state: "neutral", score: 0, confidence: 0.9, spoofRisk: 0.1 };

function tracker(overrides = {}) {
  return new OutcomeTracker({ horizonsMs: [1000, 2000], cadenceMs: 1000, tickSize: 0.25, ...overrides });
}

test("an observation resolves once every horizon has elapsed", () => {
  const t = tracker();
  t.record({ signal: buy, price: 100, timestamp: 0 });

  t.observe(100.25, 500);
  assert.equal(t.resolved.length, 0, "not resolved before the first horizon");

  t.observe(100.5, 1000);
  assert.equal(t.resolved.length, 0, "still one horizon short");

  const finished = t.observe(100.75, 2000);
  assert.equal(finished.length, 1);
  assert.equal(t.pending.length, 0);
  assert.equal(finished[0].horizons[1000].moveTicks, 2);
  assert.equal(finished[0].horizons[2000].moveTicks, 3);
});

test("favourable and adverse excursion are signed against the called direction", () => {
  const t = tracker();
  t.record({ signal: sell, price: 100, timestamp: 0 });
  t.observe(99.5, 200); // price fell: good for a sell
  t.observe(100.5, 400); // price rose: bad for a sell
  const [done] = t.observe(100, 2000);

  assert.equal(done.favourableTicks, 2, "a 0.50 fall is +2 ticks for a sell");
  assert.equal(done.adverseTicks, -2, "a 0.50 rise is -2 ticks for a sell");
});

test("a buy and a sell on the same path get opposite signs", () => {
  const up = tracker();
  up.record({ signal: buy, price: 100, timestamp: 0 });
  const [longResult] = up.observe(101, 2000);

  const down = tracker();
  down.record({ signal: sell, price: 100, timestamp: 0 });
  const [shortResult] = down.observe(101, 2000);

  assert.equal(longResult.horizons[2000].favourableTicks, 4);
  assert.equal(shortResult.horizons[2000].favourableTicks, -4);
});

test("neutral observations measure absolute movement, not a direction", () => {
  const t = tracker();
  t.record({ signal: neutral, price: 100, timestamp: 0 });
  t.observe(99, 500);
  const [done] = t.observe(100, 2000);
  assert.equal(done.direction, 0);
  assert.equal(done.favourableTicks, 4, "a 1.00 move is 4 ticks whichever way it went");
});

test("the cadence throttles recording", () => {
  const t = tracker({ cadenceMs: 1000 });
  assert.ok(t.record({ signal: buy, price: 100, timestamp: 0 }));
  assert.equal(t.record({ signal: buy, price: 100, timestamp: 500 }), null, "too soon");
  assert.ok(t.record({ signal: buy, price: 100, timestamp: 1000 }));
  assert.ok(t.record({ signal: buy, price: 100, timestamp: 1200, force: true }), "force bypasses the throttle");
});

test("nonsense prices and timestamps are rejected rather than recorded", () => {
  const t = tracker();
  assert.equal(t.record({ signal: buy, price: null, timestamp: 0 }), null);
  assert.equal(t.record({ signal: buy, price: 100, timestamp: NaN }), null);
  assert.equal(t.pending.length, 0);
});

// Without neutral samples there is nothing to compare a directional call
// against, and any hit rate is meaningless on its own.
test("a summary is not comparable until there is a control group", () => {
  const t = tracker();
  t.record({ signal: buy, price: 100, timestamp: 0 });
  t.observe(101, 2000);
  assert.equal(t.summarize().comparable, false, "directional samples alone prove nothing");

  t.record({ signal: neutral, price: 101, timestamp: 3000 });
  t.observe(101, 5000);
  assert.equal(t.summarize().comparable, true);
});

test("the summary reports hit rate and mean move per state and horizon", () => {
  const t = tracker();
  t.record({ signal: buy, price: 100, timestamp: 0 });
  t.observe(101, 2000); // +4 ticks, a win
  t.record({ signal: buy, price: 101, timestamp: 3000 });
  t.observe(100.5, 5000); // -2 ticks, a loss

  const summary = t.summarize();
  assert.equal(summary.resolved, 2);
  assert.equal(summary.byState.buy.samples, 2);
  assert.equal(summary.byState.buy.horizons[2000].hitRate, 0.5);
  assert.equal(summary.byState.buy.horizons[2000].meanTicks, 1);
});

test("several observations resolve independently and in order", () => {
  const t = tracker();
  t.record({ signal: buy, price: 100, timestamp: 0 });
  t.record({ signal: sell, price: 100, timestamp: 1000 });
  assert.equal(t.pending.length, 2);

  t.observe(100, 2000);
  assert.equal(t.resolved.length, 1, "the first observation resolves first");
  t.observe(100, 3000);
  assert.equal(t.resolved.length, 2);
  assert.equal(t.pending.length, 0);
});
