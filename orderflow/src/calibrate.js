#!/usr/bin/env node
// Turns captured sessions into measured thresholds.
//
//   node orderflow/src/calibrate.js <capture.ndjson> [more.ndjson ...]
//
// The defaults in signal-engine.js were tuned against synthetic data and are
// explicitly guesses. This reports what the instrument actually does.
//
// It will refuse to suggest values it does not trust. That matters more than it
// sounds: a naive "p90 of whatever I captured is normal" would, on a session
// that happened to be manipulated, raise the cancel tolerance until the
// manipulation looked normal -- disarming the exact filter it is meant to
// support. On a very quiet session it would do the opposite and penalise
// everything. Neither failure announces itself.

import { pathToFileURL } from "node:url";

import { readCapture } from "./capture.js";
import { createJsonStreamParser } from "./json-stream.js";
import { classifyFrame, FrameKind } from "./stream-events.js";
import { normalizeDepthFrame, createTradeExtractor } from "./depth-normalize.js";
import { OrderBookState } from "./book-state.js";

// Plausible ranges for a liquid futures book. A calibration landing outside
// these is evidence about the capture, not about the instrument.
export const SANITY = Object.freeze({
  cancelToTrade: { min: 1.5, max: 60 },
  persistenceMs: { min: 500, max: 10_000 },
  minDepthFrames: 500,
  minPrints: 50,
  maxManipulatedShare: 0.2,
  flickerThreshold: 0.4
});

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

export function emptyTotals() {
  return {
    depthFieldNames: new Set(),
    frameKeys: new Set(),
    depthFrames: 0,
    emptyDepthFrames: 0,
    quoteFrames: 0,
    trades: 0,
    cancelToTrade: [],
    restMs: [],
    flicker: [],
    spreadTicks: [],
    levelCounts: []
  };
}

// Each capture gets a fresh book. Pooling observations is fine; pooling book
// state across sessions would invent levels that never coexisted.
export function analyzeCapture(records, totals) {
  const book = new OrderBookState();
  const extractTrade = createTradeExtractor();
  let clock = 0;

  const onDepth = (frame) => {
    const event = classifyFrame(frame);
    if (event.kind !== FrameKind.DEPTH) return;

    for (const key of Object.keys(frame)) totals.frameKeys.add(key);
    const first = (frame.Bids || frame.bids || frame.Asks || frame.asks || [])[0];
    if (first) for (const key of Object.keys(first)) totals.depthFieldNames.add(key);

    const normalized = normalizeDepthFrame(frame, { timestamp: clock });
    totals.depthFrames++;
    if (!normalized.bids.length && !normalized.asks.length) {
      totals.emptyDepthFrames++;
      return;
    }

    book.applyDepth(normalized);
    const snapshot = book.snapshot(clock);
    if (Number.isFinite(snapshot.flow.cancelToTrade)) totals.cancelToTrade.push(snapshot.flow.cancelToTrade);
    if (snapshot.spreadTicks != null) totals.spreadTicks.push(snapshot.spreadTicks);
    totals.levelCounts.push(snapshot.bids.length + snapshot.asks.length);
    for (const level of snapshot.bids.concat(snapshot.asks)) {
      totals.restMs.push(level.restMs);
      totals.flicker.push(level.flicker);
    }
  };

  const onQuote = (frame) => {
    const event = classifyFrame(frame);
    if (event.kind !== FrameKind.QUOTE) return;
    totals.quoteFrames++;
    const trade = extractTrade(event.frame, clock);
    if (trade) {
      totals.trades++;
      book.applyTrade(trade);
    }
  };

  const parsers = {
    depth: createJsonStreamParser({ onValue: onDepth, onError: () => {} }),
    quotes: createJsonStreamParser({ onValue: onQuote, onError: () => {} })
  };

  for (const record of records) {
    clock = record.t;
    const parser = parsers[record.kind];
    if (parser) parser.write(record.chunk);
  }
  for (const parser of Object.values(parsers)) parser.end();

  return totals;
}

export function suggest(totals) {
  const sortedCancel = totals.cancelToTrade.slice().sort((a, b) => a - b);
  const sortedRest = totals.restMs.slice().sort((a, b) => a - b);
  const p50 = percentile(sortedCancel, 50);
  const p90 = percentile(sortedCancel, 90);
  const p99 = percentile(sortedCancel, 99);
  const restP50 = percentile(sortedRest, 50);

  const manipulatedShare = totals.flicker.length
    ? totals.flicker.filter((f) => f > SANITY.flickerThreshold).length / totals.flicker.length
    : 0;

  const blockers = [];
  if (totals.depthFrames < SANITY.minDepthFrames) {
    blockers.push(`only ${totals.depthFrames} depth frames (need ${SANITY.minDepthFrames}+)`);
  }
  if (totals.trades < SANITY.minPrints) {
    blockers.push(`only ${totals.trades} prints (need ${SANITY.minPrints}+) — cancel:trade is unreliable`);
  }
  if (manipulatedShare > SANITY.maxManipulatedShare) {
    blockers.push(
      `${(manipulatedShare * 100).toFixed(0)}% of level observations look manufactured — ` +
        "calibrating on this would treat the manipulation as the baseline"
    );
  }
  if (p90 != null && (p90 < SANITY.cancelToTrade.min || p90 > SANITY.cancelToTrade.max)) {
    blockers.push(
      `cancel:trade p90 of ${p90.toFixed(1)}x is outside the plausible band ` +
        `(${SANITY.cancelToTrade.min}–${SANITY.cancelToTrade.max}x) for a liquid futures book`
    );
  }

  const values =
    p90 == null || restP50 == null
      ? null
      : {
          cancelTolerance: Math.ceil(p90),
          cancelPenaltyRange: Math.max(5, Math.ceil(p99 - p90)),
          persistenceFullMs: Math.min(
            SANITY.persistenceMs.max,
            Math.max(SANITY.persistenceMs.min, Math.round(restP50))
          )
        };

  return { p50, p90, p99, restP50, manipulatedShare, blockers, trusted: blockers.length === 0, values };
}

function report(label, values, unit = "") {
  if (!values.length) {
    console.log(`  ${label.padEnd(22)} no samples`);
    return;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const fmt = (v) => (v == null ? "-" : (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(2))) + unit);
  console.log(
    `  ${label.padEnd(22)} p50 ${String(fmt(percentile(sorted, 50))).padStart(9)}` +
      `   p90 ${String(fmt(percentile(sorted, 90))).padStart(9)}` +
      `   p99 ${String(fmt(percentile(sorted, 99))).padStart(9)}`
  );
}

function main() {
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: node orderflow/src/calibrate.js <capture.ndjson> [more.ndjson ...]");
  console.error("\nPass several captures from different sessions. One session is a sample, not a baseline.");
  process.exit(1);
}

const totals = emptyTotals();
for (const file of files) {
  const records = readCapture(file);
  analyzeCapture(records, totals);
  console.log(`read ${file} (${records.length} records)`);
}

console.log(
  `\n${files.length} capture${files.length > 1 ? "s" : ""}  depth frames ${totals.depthFrames}  ` +
    `quote frames ${totals.quoteFrames}  prints ${totals.trades}`
);

if (totals.emptyDepthFrames) {
  console.log(
    `\n  WARNING  ${totals.emptyDepthFrames}/${totals.depthFrames} depth frames normalized to an empty book.` +
      "\n           The field names below do not match depth-normalize.js — fix that first,\n" +
      "           because every number under it is meaningless until you do."
  );
}

console.log(`\nobserved depth level fields: ${[...totals.depthFieldNames].join(", ") || "(none)"}`);
console.log(`observed frame keys:         ${[...totals.frameKeys].join(", ") || "(none)"}`);

console.log("\ndistributions");
report("cancel : trade", totals.cancelToTrade, "x");
report("level rest time", totals.restMs, "ms");
report("level flicker", totals.flicker);
report("spread", totals.spreadTicks, " ticks");
report("levels per frame", totals.levelCounts);

const result = suggest(totals);
console.log(
  `\nmanufactured-looking level observations: ${(result.manipulatedShare * 100).toFixed(1)}%`
);

if (!result.trusted) {
  console.log("\nNO SUGGESTION — this capture is not a usable baseline:");
  for (const blocker of result.blockers) console.log(`  - ${blocker}`);
  console.log(
    "\n  Capture more regular-session data, from more than one day, and pass every\n" +
      "  file to this command at once. Applying thresholds derived from a single\n" +
      "  unrepresentative session is worse than keeping the current defaults."
  );
} else {
  console.log("\nsuggested signal-engine config");
  console.log(`  cancelTolerance:    ${result.values.cancelTolerance}   (p90 of observed behaviour)`);
  console.log(`  cancelPenaltyRange: ${result.values.cancelPenaltyRange}   (p90→p99 spread)`);
  console.log(`  persistenceFullMs:  ${result.values.persistenceFullMs}   (median level lifetime, clamped to sane range)`);
  console.log(
    `\n  Based on ${files.length} capture${files.length > 1 ? "s" : ""}. Re-run as you collect more;` +
      "\n  these should stabilise before you rely on them."
  );
}
console.log("");
}

// Importing this module (for tests, or to reuse suggest()) must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
