import test from "node:test";
import assert from "node:assert/strict";

import { suggest, percentile, emptyTotals, analyzeCapture, SANITY } from "../orderflow/src/calibrate.js";
import { synthesizeCapture } from "../orderflow/src/synth-capture.js";
import { SCENARIOS } from "../orderflow/src/scenarios.js";

function totalsWith({ cancel, rest, flicker, frames = 5000, prints = 500 }) {
  const totals = emptyTotals();
  totals.depthFrames = frames;
  totals.trades = prints;
  totals.cancelToTrade = cancel;
  totals.restMs = rest;
  totals.flicker = flicker;
  return totals;
}

const repeat = (value, n) => Array.from({ length: n }, () => value);

test("percentiles land on the expected samples", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 6);
  assert.equal(percentile(sorted, 99), 10);
  assert.equal(percentile([], 50), null);
});

test("a plausible session produces usable thresholds", () => {
  const result = suggest(
    totalsWith({
      cancel: [...repeat(8, 90), ...repeat(20, 10)],
      rest: repeat(2500, 100),
      flicker: repeat(0.05, 100)
    })
  );
  assert.equal(result.trusted, true);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.values.cancelTolerance >= 8 && result.values.cancelTolerance <= 60);
  assert.equal(result.values.persistenceFullMs, 2500);
});

// The failure that motivated the rewrite: calibrating on a manipulated session
// would otherwise raise the tolerance until the manipulation looked normal.
test("a manipulated session is refused rather than treated as the baseline", () => {
  const result = suggest(
    totalsWith({
      cancel: repeat(440, 100),
      rest: repeat(1000, 100),
      flicker: repeat(0.55, 100)
    })
  );
  assert.equal(result.trusted, false);
  assert.equal(result.values.cancelTolerance > 60, true, "the raw suggestion would have been dangerous");
  assert.match(result.blockers.join(" "), /look manufactured/);
  assert.match(result.blockers.join(" "), /outside the plausible band/);
});

test("a session with almost no cancellations is refused too", () => {
  const result = suggest(
    totalsWith({
      cancel: repeat(0, 100),
      rest: repeat(3000, 100),
      flicker: repeat(0, 100)
    })
  );
  assert.equal(result.trusted, false);
  assert.match(result.blockers.join(" "), /outside the plausible band/);
});

test("too little data is refused on sample size alone", () => {
  const result = suggest(
    totalsWith({
      cancel: repeat(8, 50),
      rest: repeat(2500, 50),
      flicker: repeat(0.05, 50),
      frames: 100,
      prints: 5
    })
  );
  assert.equal(result.trusted, false);
  assert.match(result.blockers.join(" "), /depth frames/);
  assert.match(result.blockers.join(" "), /prints/);
});

test("persistence is clamped into a usable range", () => {
  const long = suggest(
    totalsWith({ cancel: repeat(8, 100), rest: repeat(90_000, 100), flicker: repeat(0.05, 100) })
  );
  assert.equal(long.values.persistenceFullMs, SANITY.persistenceMs.max);

  const short = suggest(
    totalsWith({ cancel: repeat(8, 100), rest: repeat(10, 100), flicker: repeat(0.05, 100) })
  );
  assert.equal(short.values.persistenceFullMs, SANITY.persistenceMs.min);
});

test("a synthetic capture round-trips through the analyzer", () => {
  const records = [];
  const stats = synthesizeCapture(SCENARIOS.balanced(), (kind, chunk, t) => records.push({ kind, chunk, t }));
  const totals = analyzeCapture(records, emptyTotals());

  assert.equal(totals.depthFrames, stats.frames);
  assert.equal(totals.emptyDepthFrames, 0, "the normalizer must understand its own capture format");
  assert.ok(totals.trades > 0, "prints must survive the capture round-trip");
  assert.ok(totals.depthFieldNames.has("Price"));
  assert.ok(totals.depthFieldNames.has("TotalSize"));
});

test("frames split across capture records are still parsed", () => {
  const records = [];
  synthesizeCapture(SCENARIOS.balanced(), (kind, chunk, t) => records.push({ kind, chunk, t }));
  // synth-capture deliberately splits every 7th depth frame in two.
  const depthRecords = records.filter((r) => r.kind === "depth").length;
  const totals = analyzeCapture(records, emptyTotals());
  assert.ok(depthRecords > totals.depthFrames, "the fixture should contain split frames");
  assert.equal(totals.emptyDepthFrames, 0);
});

test("pooling several captures accumulates rather than resetting", () => {
  const records = [];
  synthesizeCapture(SCENARIOS.balanced(), (kind, chunk, t) => records.push({ kind, chunk, t }));
  const totals = emptyTotals();
  analyzeCapture(records, totals);
  const afterOne = totals.depthFrames;
  analyzeCapture(records, totals);
  assert.equal(totals.depthFrames, afterOne * 2);
});
