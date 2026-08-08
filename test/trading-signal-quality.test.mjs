import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordSignalOutcomes, summarizeSignals, normalizeOutcome, loadSignalLog, MAX_RECORDS } from "../src/signal-log.js";
import { advanceOpenSignals, atrForBars, buildBreakoutBarsFromHistory, efficiencyRatioForCloses, emptyBreakoutRuntime, historySpacingMinutes, stepBreakoutStrategy, strategyCandidatesForBars, strategySeedRequest } from "../src/ui/breakout-strategy.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const markets = fs.readFileSync(path.join(root, "src", "markets.js"), "utf8").replace(/\r/g, "");


const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "boolean-signals-"));

// ── seed grain ─────────────────────────────────────────────────────────
// The bug this suite exists for: range=5y resolves to weekly bars in
// markets.js, and bucketing those into five-minute slots produced a "20-bar
// breakout range" that was really twenty weeks wide.

test("the seed asks for the grain the strategy actually runs on", () => {
    assert.deepEqual(strategySeedRequest({ timeframeMinutes: 1 }), { range: "5d", interval: "1m" });
  assert.deepEqual(strategySeedRequest({ timeframeMinutes: 5 }), { range: "1mo", interval: "5m" });
  assert.deepEqual(strategySeedRequest({ timeframeMinutes: 15 }), { range: "1mo", interval: "15m" });
  // And the request has to survive markets.js, which only honours an interval
  // override it recognises.
  for (const interval of ["1m", "5m", "15m"]) {
    assert.match(markets, new RegExp(`"${interval}"`), `markets.js does not accept the ${interval} interval`);
  }
  assert.match(ui, /range=\$\{want\.range\}&interval=\$\{want\.interval\}/);
});

test("history coarser than the timeframe is refused, not bucketed", () => {
    const series = (count, stepMinutes) => Array.from({ length: count }, (_, index) => ({
    time: Date.now() - (count - index) * stepMinutes * 60_000,
    open: 100, high: 101, low: 99, close: 100
  }));

  const weekly = series(60, 7 * 24 * 60);
  assert.equal(historySpacingMinutes(weekly), 7 * 24 * 60);
  assert.deepEqual(buildBreakoutBarsFromHistory(weekly, { timeframeMinutes: 5 }), [],
    "weekly bars must not become five-minute candles");

  // Daily is coarser too, and was equally wrong.
  assert.deepEqual(buildBreakoutBarsFromHistory(series(60, 24 * 60), { timeframeMinutes: 5 }), []);
});

test("matching or finer history is accepted and aggregated", () => {
    const fiveMinute = Array.from({ length: 40 }, (_, index) => ({
    time: Date.now() - (40 - index) * 5 * 60_000, open: 100, high: 101, low: 99, close: 100
  }));
  assert.equal(buildBreakoutBarsFromHistory(fiveMinute, { timeframeMinutes: 5 }).length, 40);

  // One-minute points folded into five-minute candles keep the extremes.
  const oneMinute = Array.from({ length: 50 }, (_, index) => ({
    time: Date.UTC(2026, 7, 3, 14, 0) + index * 60_000,
    open: 100, high: 100 + index, low: 100 - index, close: 100
  }));
  const folded = buildBreakoutBarsFromHistory(oneMinute, { timeframeMinutes: 5 });
  assert.equal(folded.length, 10);
  assert.equal(folded[0].high, 104);
  assert.equal(folded[0].low, 96);
});

// ── ATR and regime ─────────────────────────────────────────────────────

test("ATR measures true range, including gaps between bars", () => {
    const flat = Array.from({ length: 20 }, () => ({ open: 100, high: 101, low: 99, close: 100 }));
  assert.equal(atrForBars(flat, 14), 2);
  assert.equal(atrForBars(flat.slice(0, 3), 14), null, "not enough bars must report null, not a wrong number");

  // A bar that gaps away from the previous close has a true range larger than
  // its own high-low, which is the whole point of using true range.
  const gapped = [...flat.slice(0, 19), { open: 120, high: 121, low: 119, close: 120 }];
  assert.ok(atrForBars(gapped, 14) > 2);
});

test("the efficiency ratio separates a trend from chop", () => {
    const straight = Array.from({ length: 25 }, (_, index) => 100 + index);
  assert.equal(efficiencyRatioForCloses(straight, 20), 1);

  const chop = Array.from({ length: 25 }, (_, index) => (index % 2 ? 101 : 100));
  assert.ok(efficiencyRatioForCloses(chop, 20) < 0.1);
  assert.equal(efficiencyRatioForCloses(Array.from({ length: 25 }, () => 100), 20), null,
    "a dead-flat series has no path to measure");
});

// Breakout is a regime-change model, so it is filtered on the size of the
// break rather than on the prior regime — an efficiency ratio cannot tell a
// quiet base (the setup breakout wants) from chop (the setup that kills it).
test("a poke past the range edge is not a breakout; a real break is", () => {
    const bar = (close, spread = 0.4) => ({ bucket: close * 1000, open: close, high: close + spread, low: close - spread, close });
  const base = Array.from({ length: 25 }, (_, index) => bar(index % 2 ? 100.2 : 100));

  // The range high is 100.6 with an ATR near 0.8, so a close at 100.7 clears
  // the edge but not the buffer. That is the false break the gate exists for.
  const poke = strategyCandidatesForBars([...base, bar(100.7)], { mode: "breakout", lookbackBars: 20 });
  assert.deepEqual(poke.candidates.filter((item) => item.strategy === "breakout"), []);
  assert.ok(poke.metrics.regimeBlocked.includes("breakout"));
  assert.ok(poke.metrics.breakout.buffer > 0);

  // A close a full range beyond the edge is a break, and passes.
  const real = strategyCandidatesForBars([...base, bar(102)], { mode: "breakout", lookbackBars: 20 });
  assert.deepEqual(real.candidates.filter((item) => item.strategy === "breakout").map((item) => item.side), ["long"]);

  // Turning the gate off restores the old edge-only behaviour exactly.
  const ungated = strategyCandidatesForBars([...base, bar(100.7)], { mode: "breakout", lookbackBars: 20, regimeFilter: false });
  assert.deepEqual(ungated.candidates.filter((item) => item.strategy === "breakout").map((item) => item.side), ["long"]);
  assert.equal(ungated.metrics.breakout.buffer, 0);
});

test("the regime gate holds back the model that does not fit the tape", () => {
    const bar = (close) => ({ bucket: close * 1000, open: close, high: close + 0.1, low: close - 0.1, close });

  // A clean falling tape that snaps up: the EMA crosses, and the bars before
  // it were a trend, so the cross is allowed.
  const falling = Array.from({ length: 30 }, (_, index) => bar(110 - index * 0.3));
  const trend = strategyCandidatesForBars([...falling, bar(200)], { mode: "ema", fastBars: 9, slowBars: 21 });
  assert.equal(trend.metrics.regime, "trend");
  assert.deepEqual(trend.candidates.filter((item) => item.strategy === "ema").map((item) => item.side), ["long"]);
  assert.deepEqual(trend.metrics.regimeBlocked, []);

  // The same cross out of chop is the whipsaw case, and is held back.
  // Ends on the down-tick so the fast EMA sits under the slow one going in —
  // otherwise there is no cross to hold back.
  const chop = Array.from({ length: 30 }, (_, index) => bar(index % 2 ? 100 : 100.4));
  const whipsaw = strategyCandidatesForBars([...chop, bar(200)], { mode: "ema", fastBars: 9, slowBars: 21 });
  assert.equal(whipsaw.metrics.regime, "range");
  assert.deepEqual(whipsaw.candidates.filter((item) => item.strategy === "ema"), []);
  assert.ok(whipsaw.metrics.regimeBlocked.includes("ema"));

  // Mean reversion is the mirror: welcome in the still tape it was built for.
  const range = [...Array.from({ length: 19 }, () => bar(100)), bar(90), bar(96)];
  const reverting = strategyCandidatesForBars(range, { mode: "meanReversion", meanBars: 20, meanSigma: 2 });
  assert.deepEqual(reverting.candidates.filter((item) => item.strategy === "meanReversion").map((item) => item.side), ["long"]);
});

// ── signal outcomes ────────────────────────────────────────────────────

test("a signal fills at the next bar's open, not its own close", () => {
    const cfg = { outcomeHorizonBars: 20 };
  const runtime = { openSignals: [{ id: "a", symbol: "X", strategy: "breakout", side: "long",
    signalPrice: 100, stop: 98, target: 104, fill: null, at: 1 }] };
  const resolved = [];

  // The bar after the signal gaps up: the real fill is 101, not the 100 close
  // the signal was calculated at.
  advanceOpenSignals(runtime, { bucket: 2, open: 101, high: 102, low: 100.5, close: 101.5 }, cfg, resolved);
  assert.equal(resolved.length, 0);
  const open = runtime.openSignals[0];
  assert.equal(open.fill, 101);
  assert.equal(open.risk, 3, "risk is measured from the fill, not the signal price");

  advanceOpenSignals(runtime, { bucket: 3, open: 101.5, high: 104.5, low: 101, close: 104 }, cfg, resolved);
  assert.equal(resolved.length, 1);
  const record = resolved[0];
  assert.equal(record.outcome, "target");
  assert.equal(record.fill, 101);
  assert.equal(record.slippage, 1, "the gap between signal price and fill is recorded, not hidden");
  assert.equal(record.r, 1);
});

test("a bar that spans both stop and target counts as a stop", () => {
    const runtime = { openSignals: [{ id: "b", symbol: "X", strategy: "ema", side: "long",
    signalPrice: 100, stop: 98, target: 104, fill: 100, risk: 2, mfe: 0, mae: 0, barsSeen: 0, at: 1 }] };
  const resolved = [];
  advanceOpenSignals(runtime, { bucket: 2, open: 100, high: 105, low: 97, close: 101 }, { outcomeHorizonBars: 20 }, resolved);
  assert.equal(resolved[0].outcome, "stop");
  assert.equal(resolved[0].r, -1);
});

test("an unresolved signal times out at the horizon and reports its excursions", () => {
    const cfg = { outcomeHorizonBars: 3 };
  const runtime = { openSignals: [{ id: "c", symbol: "X", strategy: "meanReversion", side: "short",
    signalPrice: 100, stop: 102, target: 96, fill: 100, risk: 2, mfe: 0, mae: 0, barsSeen: 0, at: 1 }] };
  const resolved = [];
  for (const bar of [{ high: 101, low: 99 }, { high: 100.5, low: 98 }, { high: 100, low: 99.5 }]) {
    advanceOpenSignals(runtime, { bucket: 2, open: 100, close: 99.5, ...bar }, cfg, resolved);
  }
  assert.equal(resolved.length, 1);
  const record = resolved[0];
  assert.equal(record.outcome, "timeout");
  assert.equal(record.bars, 3);
  // Short: favourable is downward. Best was 98 (1R), worst was 101 (0.5R).
  assert.equal(record.mfe, 1);
  assert.equal(record.mae, 0.5);
  assert.equal(runtime.openSignals.length, 0);
});

// ── the log ────────────────────────────────────────────────────────────

test("the log stores only vouched-for fields and rejects malformed outcomes", () => {
  assert.equal(normalizeOutcome({ outcome: "target", r: 1 }), null, "a record with no symbol is not a measurement");
  assert.equal(normalizeOutcome({ symbol: "X", strategy: "ema", outcome: "maybe", r: 1 }), null);
  assert.equal(normalizeOutcome({ symbol: "X", strategy: "ema", outcome: "target", r: "abc" }), null);
  const record = normalizeOutcome({ symbol: "enph", strategy: "breakout", outcome: "target", r: 2, sneaky: "value" });
  assert.equal(record.symbol, "ENPH");
  assert.equal(record.side, "long");
  assert.equal("sneaky" in record, false);
});

test("outcomes accumulate into hit rate and expectancy, and ids never double-count", () => {
  const dir = tempDir();
  const outcome = (id, strategy, result, r, regime = "trend") => ({
    id, symbol: "ENPH", strategy, outcome: result, r, regime, mfe: Math.max(0, r), mae: 0.4, bars: 5
  });

  const first = recordSignalOutcomes(dir, [
    outcome("1", "breakout", "target", 2),
    outcome("2", "breakout", "stop", -1),
    outcome("3", "breakout", "stop", -1)
  ]);
  assert.equal(first.added, 3);
  const breakout = first.stats.byStrategy.breakout;
  assert.equal(breakout.count, 3);
  assert.equal(breakout.hitRate, 0.3333);
  // One 2R win against two 1R losses is break-even, which is exactly the kind
  // of thing a hit rate alone would misreport as a losing strategy.
  assert.equal(breakout.expectancyR, 0);

  // Replaying the same runtime after a reload must not inflate the sample.
  const again = recordSignalOutcomes(dir, [outcome("1", "breakout", "target", 2)]);
  assert.equal(again.added, 0);
  assert.equal(again.stats.byStrategy.breakout.count, 3);

  const mixed = recordSignalOutcomes(dir, [outcome("4", "meanReversion", "target", 1, "range")]);
  assert.equal(mixed.stats.total, 4);
  assert.equal(mixed.stats.byRegime.range.count, 1);
  // The slice is what will eventually answer whether the regime gate helps.
  assert.equal(mixed.stats.bySlice["meanReversion/range"].count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the log is bounded and survives a corrupt file", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "signal-log.json"), "{not json");
  assert.deepEqual(loadSignalLog(dir).records, []);

  const many = Array.from({ length: MAX_RECORDS + 40 }, (_, index) => ({
    id: `x${index}`, symbol: "X", strategy: "ema", outcome: "stop", r: -1
  }));
  recordSignalOutcomes(dir, many);
  assert.equal(loadSignalLog(dir).records.length, MAX_RECORDS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("summarizing nothing reports nothing rather than a fake zero", () => {
  const stats = summarizeSignals([]);
  assert.equal(stats.total, 0);
  assert.deepEqual(stats.byStrategy, {});
});

test("the signal log never places or sizes an order", () => {
  const source = fs.readFileSync(path.join(root, "src", "signal-log.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|visibleBrowser|evaluateTradeGuard|recordTradePlacement/);
});
