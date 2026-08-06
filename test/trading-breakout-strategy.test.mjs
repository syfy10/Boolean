import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTradingStrategy } from "../src/server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8").replace(/\r/g, "");

function loadBreakoutEngine() {
  const start = ui.indexOf("  function normalizeBreakoutConfig");
  const end = ui.indexOf("\n\n  function buildTradingBrokerOptions", start);
  assert.ok(start >= 0 && end > start, "breakout strategy engine not found");
  const block = ui.slice(start, end)
    .replace("  let breakoutConfig={...BREAKOUT_DEFAULTS};", "  let breakoutConfig={};")
    .replace("  let breakoutRuntime=null;", "  let breakoutRuntime=null;");
  return new Function("normalizeSymbolInput", "localStorage", `${block}\nreturn {emptyBreakoutRuntime,stepBreakoutStrategy,normalizeBreakoutConfig,strategyCandidatesForBars};`)(
    (value) => String(value || "").trim().toUpperCase(),
    { getItem: () => null, setItem: () => {} }
  );
}

test("three-strategy settings are bounded and remain signal-only", () => {
  assert.deepEqual(normalizeTradingStrategy({
    enabled: true,
    key: "anything",
    timeframeMinutes: 2,
    lookbackBars: 999,
    riskReward: 99,
    maxSignalsPerDay: 0
  }), {
    enabled: true,
    key: "multi",
    mode: "all",
    timeframeMinutes: 5,
    lookbackBars: 100,
    fastBars: 9,
    slowBars: 21,
    meanBars: 20,
    meanSigma: 2,
    riskReward: 5,
    maxSignalsPerDay: 4,
    cooldownBars: 2,
    atrBars: 14,
    atrStopMultiple: 1,
    regimeFilter: true,
    trendMinEfficiency: 0.35,
    rangeMaxEfficiency: 0.25,
    breakoutBufferAtr: 0.25,
    outcomeHorizonBars: 20
  });
});

test("the ATR stop, regime gate, and outcome horizon are bounded too", () => {
  const wild = normalizeTradingStrategy({
    atrBars: 999, atrStopMultiple: 99, trendMinEfficiency: 5, rangeMaxEfficiency: -3, outcomeHorizonBars: 1
  });
  assert.equal(wild.atrBars, 50);
  assert.equal(wild.atrStopMultiple, 3);
  assert.equal(wild.trendMinEfficiency, 1);
  assert.equal(wild.rangeMaxEfficiency, 0);
  assert.equal(wild.outcomeHorizonBars, 5);
  // Zero is a real choice — it restores the candle-extreme stop — so it must
  // survive normalization rather than falling back to the default.
  assert.equal(normalizeTradingStrategy({ atrStopMultiple: 0 }).atrStopMultiple, 0);
  assert.equal(normalizeTradingStrategy({ regimeFilter: false }).regimeFilter, false);
});

test("20 completed five-minute bars produce one breakout setup with stop and target", () => {
  const { emptyBreakoutRuntime, stepBreakoutStrategy } = loadBreakoutEngine();
  const config = { enabled: true, mode: "breakout", timeframeMinutes: 5, lookbackBars: 20, riskReward: 2, maxSignalsPerDay: 4 };
  const span = 5 * 60_000;
  const base = Date.UTC(2026, 7, 3, 14, 0);
  let runtime = emptyBreakoutRuntime();
  let result;

  for (let index = 0; index < 20; index += 1) {
    result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 99 }, config, base + index * span);
    runtime = result.runtime;
    result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 100 }, config, base + index * span + 1000);
    runtime = result.runtime;
  }
  result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 101.5 }, config, base + 20 * span);
  runtime = result.runtime;
  assert.equal(result.ready, true);
  assert.equal(result.signal, null);

  result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 102 }, config, base + 20 * span + 1000);
  runtime = result.runtime;
  result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 102 }, config, base + 21 * span);

  assert.equal(result.signal.side, "long");
  assert.equal(result.signal.entry, 102);
  // The signal candle's own low is 101.5, half a point from the entry. Bars
  // this size have a true range near 1, so the ATR floor pushes the stop well
  // below that low and the 2R target follows it out. Without the floor a stop
  // this tight is noise, not a decision.
  assert.ok(result.signal.stop < 101.5, `expected the ATR floor to widen the stop, got ${result.signal.stop}`);
  assert.equal(result.signal.risk, result.signal.entry - result.signal.stop);
  assert.equal(result.signal.target, result.signal.entry + 2 * result.signal.risk);
  assert.equal(Math.round(result.signal.stop * 100) / 100, 100.93);
  assert.equal(result.runtime.signalsToday, 1);
  // A flat base breaking out is the setup breakout wants, so the gate lets it
  // through: the close at 102 clears the 100 range high by far more than the
  // quarter-ATR buffer.
  assert.equal(result.metrics.breakout.high, 100);
  assert.ok(result.metrics.breakout.buffer > 0);
  assert.deepEqual(result.metrics.regimeBlocked, []);
});

test("atrStopMultiple 0 restores the candle-extreme stop", () => {
  const { emptyBreakoutRuntime, stepBreakoutStrategy } = loadBreakoutEngine();
  const config = { enabled: true, mode: "breakout", timeframeMinutes: 5, lookbackBars: 20, riskReward: 2, maxSignalsPerDay: 4, atrStopMultiple: 0 };
  const span = 5 * 60_000;
  const base = Date.UTC(2026, 7, 3, 14, 0);
  let runtime = emptyBreakoutRuntime();
  let result;
  for (let index = 0; index < 20; index += 1) {
    runtime = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 99 }, config, base + index * span).runtime;
    runtime = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 100 }, config, base + index * span + 1000).runtime;
  }
  runtime = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 101.5 }, config, base + 20 * span).runtime;
  runtime = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 102 }, config, base + 20 * span + 1000).runtime;
  result = stepBreakoutStrategy(runtime, { symbol: "/MNQU26", price: 102 }, config, base + 21 * span);
  assert.equal(result.signal.stop, 101.5);
  assert.equal(result.signal.target, 103);
});

test("EMA crossover and range re-entry provide the two additional candidates", () => {
  const { strategyCandidatesForBars } = loadBreakoutEngine();
  const bar = (close) => ({ bucket: close * 1000, open: close, high: close + 0.1, low: close - 0.1, close });
  const falling = Array.from({ length: 30 }, (_, index) => bar(110 - index * 0.3));
  const ema = strategyCandidatesForBars([...falling, bar(200)], { mode: "ema", fastBars: 9, slowBars: 21 });
  assert.deepEqual(ema.candidates.filter(item => item.strategy === "ema").map(item => item.side), ["long"]);

  const range = [...Array.from({ length: 19 }, () => bar(100)), bar(90), bar(96)];
  const mean = strategyCandidatesForBars(range, { mode: "meanReversion", meanBars: 20, meanSigma: 2 });
  assert.deepEqual(mean.candidates.filter(item => item.strategy === "meanReversion").map(item => item.side), ["long"]);
  assert.equal(mean.metrics.meanReversion.flatEnough, true);
});

test("symbol changes and missed candles reset strategy history", () => {
  const { emptyBreakoutRuntime, stepBreakoutStrategy } = loadBreakoutEngine();
  const config = { mode: "breakout", timeframeMinutes: 5, lookbackBars: 20, riskReward: 2, maxSignalsPerDay: 4 };
  const span = 5 * 60_000;
  const base = Date.UTC(2026, 7, 3, 14, 0);
  let result = stepBreakoutStrategy(emptyBreakoutRuntime(), { symbol: "AAPL", price: 200 }, config, base);
  result = stepBreakoutStrategy(result.runtime, { symbol: "AAPL", price: 201 }, config, base + span);
  assert.equal(result.runtime.bars.length, 1);

  result = stepBreakoutStrategy(result.runtime, { symbol: "TSLA", price: 300 }, config, base + span + 1000);
  assert.equal(result.runtime.symbol, "TSLA");
  assert.equal(result.runtime.bars.length, 0);

  result = stepBreakoutStrategy(result.runtime, { symbol: "TSLA", price: 301 }, config, base + 4 * span);
  assert.equal(result.gapReset, true);
  assert.equal(result.runtime.bars.length, 0);
});

test("the compact control persists settings and never submits an order", () => {
  for (const id of ["tbStrategy", "tbStrategyRow", "tbStrategyState", "tbStrategyLevels", "tbStrategyNote"]) {
    assert.match(ui, new RegExp(`id="${id}"`));
  }
  for (const value of ["off", "breakout", "ema", "meanReversion", "all"]) {
    assert.match(ui, new RegExp(`<option value="${value}">`));
  }
  assert.match(ui, /JSON\.stringify\(\{strategy:\{\.\.\.breakoutConfig,enabled:enabling,mode:enabling\?mode:breakoutConfig\.mode\}\}\)/);
  assert.match(ui, /first valid Breakout, EMA trend, or Mean reversion signal wins/);
  assert.match(ui, /opposite simultaneous signals are rejected/);
  const start = ui.indexOf("function stepBreakoutStrategy");
  const end = ui.indexOf("function buildTradingBrokerOptions", start);
  const engine = ui.slice(start, end);
  assert.doesNotMatch(engine, /\bfetch\s*\(|hostPost\s*\(|\.click\s*\(|\.submit\s*\(/);
});

test("the daily loss cap is editable, bounded, persistent, and blocks arming", () => {
  assert.match(ui, /\.composer,\.composer-tools,\.trading-bar\{ pointer-events:auto; \}/);
  assert.match(ui, /id="tbLossCapInput" type="number" min="0" max="100000000"/);
  assert.match(ui, /\$\("tbLossCapInput"\)\?\.addEventListener\("change",setDailyLossCap\)/);
  assert.doesNotMatch(ui, /Maximum realized loss for one trading day in USD[\s\S]*?window\.prompt/);
  assert.match(ui, /JSON\.stringify\(\{dailyLossCapUsd:cap\}\)/);
  assert.match(ui, /lossCapReached[\s\S]*?armButton\.disabled=lossCapReached/);
  assert.match(ui, /status\.textContent="Daily loss cap reached"/);
  assert.match(server, /dailyLossCapUsd" in body\) g\.dailyLossCapUsd = Math\.min\(100_000_000,/);
});
