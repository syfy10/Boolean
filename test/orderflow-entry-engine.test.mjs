import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { EntryTracker, evaluateEntryCandidate, normalizeBar, sessionKeyOf } from "../orderflow/src/entry-engine.js";
import { barStreamUrl, fetchBarHistory } from "../orderflow/src/tradestation-client.js";

const bar = (close, index, volume = 100) => ({
  timestamp: `t${index}`,
  open: close - 0.1,
  high: close + 0.2,
  low: close - 0.2,
  close,
  volume
});

test("normalizes TradeStation five-minute bars", () => {
  assert.deepEqual(normalizeBar({ TimeStamp: "now", Open: "10", High: "11", Low: "9", Close: "10.5", TotalVolume: "120" }), {
    timestamp: "now", open: 10, high: 11, low: 9, close: 10.5, volume: 120
  });
});

test("a bullish price break needs matching credible order flow", () => {
  const bars = Array.from({ length: 9 }, (_, index) => bar(100 + index * 0.25, index));
  bars.push({ ...bar(103, 9), high: 103.1, close: 103 });
  const entry = evaluateEntryCandidate(bars, { state: "buy", score: 58, confidence: 0.82, spoofRisk: 0.08 });
  assert.equal(entry.side, "buy");
  assert.equal(entry.actionable, true);
  assert.equal(entry.readOnly, true);
  assert.equal(entry.checks.buyStructure, true);
});

test("a bearish price break needs matching credible order flow", () => {
  const bars = Array.from({ length: 9 }, (_, index) => bar(110 - index * 0.25, index));
  bars.push({ ...bar(106.5, 9), low: 106.4, close: 106.5 });
  const entry = evaluateEntryCandidate(bars, { state: "sell", score: -61, confidence: 0.79, spoofRisk: 0.12 });
  assert.equal(entry.side, "sell");
  assert.equal(entry.checks.sellStructure, true);
});

test("spoof risk vetoes an otherwise aligned entry", () => {
  const bars = Array.from({ length: 9 }, (_, index) => bar(100 + index * 0.25, index));
  bars.push({ ...bar(103, 9), high: 103.1, close: 103 });
  const entry = evaluateEntryCandidate(bars, { state: "buy", score: 70, confidence: 0.9, spoofRisk: 0.8 });
  assert.equal(entry.side, "wait");
  assert.match(entry.reasons.join(" "), /Spoof risk/);
});

test("the tracker replaces updates for the same streaming bar", () => {
  const tracker = new EntryTracker();
  tracker.updateBar({ TimeStamp: "same", Open: 10, High: 11, Low: 9, Close: 10, TotalVolume: 10 });
  tracker.updateBar({ TimeStamp: "same", Open: 10, High: 12, Low: 9, Close: 11, TotalVolume: 20 });
  assert.equal(tracker.bars.length, 1);
  assert.equal(tracker.bars[0].high, 12);
});

test("a break against opposing order flow is named, not reported as confirmation", () => {
  const bars = Array.from({ length: 12 }, (_, index) => bar(100, index));
  bars.push({ ...bar(101, 12), high: 101, close: 101 });
  const entry = evaluateEntryCandidate(bars, { state: "sell", score: -60, confidence: 0.9, spoofRisk: 0.1 });

  assert.equal(entry.side, "wait");
  assert.equal(entry.checks.buyStructure, true);
  assert.equal(entry.checks.sellFlow, true);
  assert.match(entry.reasons.join(" "), /broke above .* while order flow is pressing the offer/);
  assert.doesNotMatch(entry.reasons.join(" "), /setup confirmed by price structure/);
});

test("a downside break against buying flow is named too", () => {
  const bars = Array.from({ length: 12 }, (_, index) => bar(100, index));
  bars.push({ ...bar(98, 12), low: 98, close: 98 });
  const entry = evaluateEntryCandidate(bars, { state: "buy", score: 60, confidence: 0.9, spoofRisk: 0.1 });

  assert.equal(entry.side, "wait");
  assert.match(entry.reasons.join(" "), /broke below .* while order flow is pressing the bid/);
  assert.doesNotMatch(entry.reasons.join(" "), /setup confirmed by price structure/);
});

test("no wait candidate ever claims a confirmed setup", () => {
  const flows = [
    { state: "sell", score: -60, confidence: 0.9, spoofRisk: 0.1 },
    { state: "buy", score: 60, confidence: 0.9, spoofRisk: 0.1 },
    { state: "neutral", score: 0, confidence: 0.9, spoofRisk: 0.1 },
    { state: "buy", score: 60, confidence: 0.2, spoofRisk: 0.1 },
    { state: "buy", score: 60, confidence: 0.9, spoofRisk: 0.9 }
  ];
  const shapes = [
    Array.from({ length: 13 }, (_, index) => bar(100, index)),
    [...Array.from({ length: 12 }, (_, index) => bar(100, index)), { ...bar(101, 12), high: 101, close: 101 }],
    [...Array.from({ length: 12 }, (_, index) => bar(100, index)), { ...bar(98, 12), low: 98, close: 98 }],
    Array.from({ length: 3 }, (_, index) => bar(100, index))
  ];

  for (const bars of shapes) {
    for (const flow of flows) {
      const entry = evaluateEntryCandidate(bars, flow);
      if (entry.side !== "wait") continue;
      assert.doesNotMatch(
        entry.reasons.join(" "),
        /setup confirmed by price structure/,
        `wait candidate claimed confirmation: ${JSON.stringify(entry.reasons)}`
      );
    }
  }
});

test("the engine server binds to loopback only", () => {
  const source = fs.readFileSync(new URL("../orderflow/src/monitor-server.js", import.meta.url), "utf8");
  assert.match(source, /server\.listen\(port,\s*HOST/);
  assert.match(source, /const HOST = "127\.0\.0\.1"/);
  assert.doesNotMatch(source, /server\.listen\(port,\s*\(\)/, "binding without a host exposes the POST endpoints to the network");
});

test("VWAP resets at the futures session boundary", () => {
  // 17:55 ET is the tail of one session; 18:05 ET opens the next.
  const before = sessionKeyOf("2026-08-07T21:55:00Z");
  const after = sessionKeyOf("2026-08-07T22:05:00Z");
  assert.notEqual(before, after, "18:00 ET must start a new session");
  assert.equal(sessionKeyOf("2026-08-07T22:05:00Z"), sessionKeyOf("2026-08-08T13:00:00Z"));
});

test("a prior session's bars do not contribute to session VWAP", () => {
  const old = Array.from({ length: 10 }, (_, i) => ({
    timestamp: `2026-08-06T14:${String(i).padStart(2, "0")}:00Z`,
    open: 200, high: 200, low: 200, close: 200, volume: 1000
  }));
  const today = Array.from({ length: 10 }, (_, i) => ({
    timestamp: `2026-08-07T14:${String(i).padStart(2, "0")}:00Z`,
    open: 100, high: 100, low: 100, close: 100, volume: 1000
  }));

  const entry = evaluateEntryCandidate([...old, ...today], { state: "neutral", confidence: 0.9, spoofRisk: 0.1 });
  assert.equal(entry.metrics.vwap, 100, "yesterday's 200-handle bars must not drag VWAP");
  assert.equal(entry.metrics.sessionBars, 10);
  assert.equal(entry.metrics.bars, 20);
});

test("unparseable bar timestamps degrade to one session rather than throwing", () => {
  assert.equal(sessionKeyOf("replay-42"), null);
  const bars = Array.from({ length: 12 }, (_, i) => bar(100, i));
  const entry = evaluateEntryCandidate(bars, { state: "neutral", confidence: 0.9, spoofRisk: 0.1 });
  assert.equal(entry.metrics.sessionBars, 12);
  assert.ok(Number.isFinite(entry.metrics.vwap));
});

test("stale depth vetoes an otherwise perfect setup", () => {
  const bars = Array.from({ length: 12 }, (_, index) => bar(100, index));
  bars.push({ ...bar(101, 12), high: 101, close: 101 });
  const flow = { state: "buy", score: 60, confidence: 0.9, spoofRisk: 0.05 };

  const live = evaluateEntryCandidate(bars, { ...flow, quality: { freshness: 1 } });
  assert.equal(live.side, "buy");

  const frozen = evaluateEntryCandidate(bars, { ...flow, quality: { freshness: 0 } });
  assert.equal(frozen.side, "wait");
  assert.equal(frozen.checks.quality, false);
  assert.match(frozen.reasons.join(" "), /stale/);
});

test("bars without a timestamp are rejected, not silently appended", () => {
  const tracker = new EntryTracker();
  tracker.updateBar({ Open: 10, High: 11, Low: 9, Close: 10, TotalVolume: 5 });
  tracker.updateBar({ Open: 10, High: 12, Low: 9, Close: 11, TotalVolume: 6 });
  assert.equal(tracker.bars.length, 0, "guessing would corrupt priorHigh/priorLow");
  assert.equal(tracker.undated, 2);
});

test("malformed bars are counted separately from undated ones", () => {
  const tracker = new EntryTracker();
  tracker.updateBar({ TimeStamp: "t1", Open: "x", High: null, Low: 9, Close: 10 });
  assert.equal(tracker.rejected, 1);
  assert.equal(tracker.undated, 0);
});

test("bar history is requested with barsback so the engine is not blind on start", async () => {
  let seen = null;
  const bars = [{ TimeStamp: "2026-08-07T14:00:00Z", Open: 1, High: 2, Low: 0.5, Close: 1.5, TotalVolume: 10 }];
  const history = await fetchBarHistory(
    { api: "https://sim-api.tradestation.com/v3" },
    "ESU26",
    { barsback: 60 },
    {
      tokenProvider: async () => "tok",
      fetchImpl: async (url, init) => {
        seen = { url, auth: init.headers.Authorization };
        return { ok: true, status: 200, json: async () => ({ Bars: bars }) };
      }
    }
  );
  assert.match(seen.url, /barcharts\/ESU26\?interval=5&unit=Minute&barsback=60/);
  assert.equal(seen.auth, "Bearer tok");
  assert.deepEqual(history, bars);
});

test("a failed history fetch reports the status rather than returning nothing", async () => {
  await assert.rejects(
    () =>
      fetchBarHistory({ api: "https://x/v3" }, "ES", {}, {
        tokenProvider: async () => "tok",
        fetchImpl: async () => ({ ok: false, status: 403, text: async () => "Forbidden" })
      }),
    /bar history failed \(403\).*Forbidden/
  );
});

test("TradeStation barchart stream uses five-minute bars", () => {
  assert.equal(barStreamUrl({ api: "https://sim-api.tradestation.com/v3" }, "ESU26"), "https://sim-api.tradestation.com/v3/marketdata/stream/barcharts/ESU26?interval=5&unit=Minute");
});
