// A record of what the local strategies actually did.
//
// The signal engine reads well and had no way of knowing whether it worked:
// signals were drawn on screen and forgotten. This log keeps the resolved
// outcome of every fired signal — filled at the next bar's open, graded in R
// against its own stop — so "which strategy is best" can be answered from this
// user's own data instead of from a guess.
//
// SAFETY: nothing here places, stages, or sizes an order. It is a record of
// hypothetical outcomes for signals that were never automatically traded.

import fs from "node:fs";
import path from "node:path";

const FILE = "signal-log.json";
export const MAX_RECORDS = 500;
const OUTCOMES = new Set(["target", "stop", "timeout"]);

const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
};

export function emptyLog() {
  return { version: 1, records: [] };
}

export function logPath(dir) {
  return path.join(dir, FILE);
}

export function loadSignalLog(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(logPath(dir), "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.records)) return emptyLog();
    return { version: 1, records: raw.records.filter((r) => r && typeof r === "object").slice(-MAX_RECORDS) };
  } catch {
    return emptyLog();
  }
}

export function saveSignalLog(dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath(dir), JSON.stringify({ version: 1, records: log.records.slice(-MAX_RECORDS) }, null, 2));
}

// Only the fields this log is willing to vouch for. Anything unrecognised is
// dropped rather than stored, so a future reader cannot mistake a stray field
// for a measurement.
export function normalizeOutcome(raw = {}) {
  const outcome = String(raw.outcome || "").trim().toLowerCase();
  if (!OUTCOMES.has(outcome)) return null;
  const r = Number(raw.r);
  if (!Number.isFinite(r)) return null;
  const symbol = String(raw.symbol || "").trim().toUpperCase().slice(0, 24);
  const strategy = String(raw.strategy || "").trim().slice(0, 24);
  if (!symbol || !strategy) return null;
  const number = (value) => (Number.isFinite(Number(value)) ? round(Number(value), 6) : null);
  return {
    id: String(raw.id || "").slice(0, 120),
    symbol,
    strategy,
    side: raw.side === "short" ? "short" : "long",
    regime: String(raw.regime || "unknown").trim().slice(0, 16),
    efficiency: number(raw.efficiency),
    timeframeMinutes: Math.max(1, Math.round(Number(raw.timeframeMinutes) || 5)),
    signalPrice: number(raw.signalPrice),
    fill: number(raw.fill),
    stop: number(raw.stop),
    target: number(raw.target),
    slippage: number(raw.slippage),
    outcome,
    r: round(r),
    mfe: round(Math.max(0, Number(raw.mfe) || 0)),
    mae: round(Math.max(0, Number(raw.mae) || 0)),
    bars: Math.max(0, Math.round(Number(raw.bars) || 0)),
    at: Math.max(0, Number(raw.at) || 0),
    resolvedAt: Math.max(0, Number(raw.resolvedAt) || Date.now())
  };
}

// Ignores a repeat of an id already on file, so a browser that replays its
// runtime after a reload cannot inflate the sample.
export function recordSignalOutcomes(dir, rawOutcomes = []) {
  const log = loadSignalLog(dir);
  const seen = new Set(log.records.map((record) => record.id).filter(Boolean));
  let added = 0;
  for (const raw of Array.isArray(rawOutcomes) ? rawOutcomes : []) {
    const record = normalizeOutcome(raw);
    if (!record) continue;
    if (record.id && seen.has(record.id)) continue;
    if (record.id) seen.add(record.id);
    log.records.push(record);
    added += 1;
  }
  if (added) saveSignalLog(dir, log);
  return { added, stats: summarizeSignals(log.records) };
}

function group(records, keyOf) {
  const out = {};
  for (const record of records) {
    const key = keyOf(record);
    if (!key) continue;
    const bucket = out[key] || (out[key] = { count: 0, wins: 0, stops: 0, timeouts: 0, sumR: 0, sumMfe: 0, sumMae: 0 });
    bucket.count += 1;
    bucket.sumR += record.r;
    bucket.sumMfe += record.mfe;
    bucket.sumMae += record.mae;
    if (record.outcome === "target") bucket.wins += 1;
    else if (record.outcome === "stop") bucket.stops += 1;
    else bucket.timeouts += 1;
  }
  for (const bucket of Object.values(out)) {
    bucket.hitRate = round(bucket.wins / bucket.count, 4);
    // Expectancy in R is the number that matters: average R per signal taken.
    // A strategy can win less than half its signals and still be worth running.
    bucket.expectancyR = round(bucket.sumR / bucket.count);
    bucket.avgMfe = round(bucket.sumMfe / bucket.count);
    bucket.avgMae = round(bucket.sumMae / bucket.count);
    delete bucket.sumR;
    delete bucket.sumMfe;
    delete bucket.sumMae;
  }
  return out;
}

export function summarizeSignals(records = []) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && Number.isFinite(Number(record.r)));
  return {
    total: list.length,
    byStrategy: group(list, (record) => record.strategy),
    byRegime: group(list, (record) => record.regime),
    // Whether the regime gate is earning its place: the same strategy's
    // expectancy inside versus outside the regime it is supposed to want.
    bySlice: group(list, (record) => `${record.strategy}/${record.regime}`),
    lastResolvedAt: list.reduce((latest, record) => Math.max(latest, Number(record.resolvedAt) || 0), 0)
  };
}

export function signalStats(dir) {
  return summarizeSignals(loadSignalLog(dir).records);
}
