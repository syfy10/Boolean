import test from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "../orderflow/src/scenarios.js";
import { replay, summarize } from "../orderflow/src/replay.js";
import { SignalState } from "../orderflow/src/signal-engine.js";

function run(name) {
  return summarize(replay(SCENARIOS[name]()));
}

test("a quiet two-sided book produces no signal", () => {
  const result = run("balanced");
  assert.equal(result.dominantState, SignalState.NEUTRAL);
  assert.ok(Math.abs(result.meanScore) < 20, `score should sit near zero (${result.meanScore})`);
  assert.ok(result.meanSpoofRisk < 0.2, `nothing here is manufactured (${result.meanSpoofRisk})`);
});

test("a persistent offer that absorbs buyers produces a confident sell signal", () => {
  const result = run("genuineSellWall");
  assert.equal(result.dominantState, SignalState.SELL);
  assert.ok(result.meanScore <= -35, `expected clear sell pressure (${result.meanScore})`);
  assert.ok(result.meanConfidence >= 0.6, `real resting size should be trusted (${result.meanConfidence})`);
  assert.ok(result.meanSpoofRisk < 0.2, `a wall that never moves is not a spoof (${result.meanSpoofRisk})`);
});

test("a bid that refills against heavy selling produces a buy signal", () => {
  const result = run("bidAbsorption");
  assert.equal(result.dominantState, SignalState.BUY);
  assert.ok(result.meanScore >= 35, `expected clear buy pressure (${result.meanScore})`);
  assert.ok(result.meanConfidence >= 0.6);
});

// The whole point of the exercise: the pattern Sarao ran must not be read as
// genuine supply, even though the raw ladder screams that it is.
test("dynamic layering is refused rather than traded", () => {
  const result = run("dynamicLayering");
  assert.ok(
    result.meanNaiveScore <= -40,
    `raw depth should look strongly bearish, or the scenario is not testing anything (${result.meanNaiveScore})`
  );
  assert.equal(result.dominantState, SignalState.NEUTRAL);
  assert.ok(Math.abs(result.meanScore) < 25, `filtered score should collapse toward zero (${result.meanScore})`);
  assert.ok(result.meanConfidence < 0.25, `confidence must not survive this book (${result.meanConfidence})`);
  assert.ok(result.meanSpoofRisk > 0.7, `spoof risk should be loud (${result.meanSpoofRisk})`);
});

test("layering and a genuine wall are told apart despite looking alike raw", () => {
  const spoof = run("dynamicLayering");
  const real = run("genuineSellWall");

  // Both present large offers above the market.
  assert.ok(spoof.meanNaiveScore < -40 && real.meanNaiveScore < -40);
  // Only one of them is acted on.
  assert.equal(real.dominantState, SignalState.SELL);
  assert.equal(spoof.dominantState, SignalState.NEUTRAL);
  assert.ok(real.meanConfidence - spoof.meanConfidence > 0.5);
});

test("a signal explains itself", () => {
  const result = replay(SCENARIOS.genuineSellWall());
  const last = result.samples[result.samples.length - 1].signal;
  const codes = last.reasons.map((r) => r.code);
  assert.ok(codes.includes("imbalance"));
  assert.ok(codes.includes("absorption"));
  for (const reason of last.reasons) {
    assert.equal(typeof reason.detail, "string");
    assert.ok(reason.detail.length > 0);
  }
});

test("hysteresis stops the state strobing around the threshold", () => {
  const result = replay(SCENARIOS.genuineSellWall());
  const flips = result.samples.filter((s) => s.signal.changed).length;
  assert.ok(flips <= 2, `a steady book should not flip repeatedly (${flips})`);
});

test("aggressive volume that fails to move price is not treated as direction", () => {
  const result = replay(SCENARIOS.bidAbsorption());
  const last = result.samples[result.samples.length - 1].signal;
  // Every trade in this scenario is a seller hitting the bid, yet price holds.
  assert.ok(last.quality.followThrough < 0.2);
  assert.ok(
    Math.abs(last.components.aggression) < 0.2,
    `one-sided selling into a wall of bids should not read as bearish (${last.components.aggression})`
  );
  assert.ok(last.components.absorption > 0.2);
});
