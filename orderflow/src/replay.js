// Drives events through book state + signal engine on a virtual clock.
//
// Phase 2 points this at recorded live sessions; today it runs the synthetic
// scenarios. Either way nothing here touches the network or the wall clock, so
// results are reproducible.

import { OrderBookState } from "./book-state.js";
import { SignalTracker } from "./signal-engine.js";
import { normalizeDepthFrame } from "./depth-normalize.js";
import { createJsonStreamParser } from "./json-stream.js";
import { classifyFrame, FrameKind } from "./stream-events.js";

export function replay(scenario, options = {}) {
  const book = new OrderBookState({ tickSize: scenario.tickSize, ...(options.bookConfig || {}) });
  const tracker = new SignalTracker(options.signalConfig || {});
  const samples = [];

  for (const event of scenario.events) {
    if (event.type === "trade") {
      book.applyTrade({ ...event.payload, timestamp: event.t });
      continue;
    }
    if (event.type !== "depth") continue;
    book.applyDepth(normalizeDepthFrame(event.payload, { timestamp: event.t }));
    const snapshot = book.snapshot(event.t);
    samples.push({ t: event.t, snapshot, signal: tracker.update(snapshot) });
  }

  return { name: scenario.name, expect: scenario.expect, samples, book, tracker };
}

// Everything after the warmup period, which is what we actually judge.
export function tail(result, fraction = 0.5) {
  const start = Math.floor(result.samples.length * (1 - fraction));
  return result.samples.slice(start);
}

export function summarize(result, fraction = 0.5) {
  const window = tail(result, fraction);
  if (!window.length) return null;
  const counts = { buy: 0, sell: 0, neutral: 0 };
  let score = 0;
  let naive = 0;
  let confidence = 0;
  let spoofRisk = 0;

  for (const sample of window) {
    counts[sample.signal.state]++;
    score += sample.signal.score;
    naive += sample.signal.naiveScore;
    confidence += sample.signal.confidence;
    spoofRisk += sample.signal.spoofRisk;
  }

  const n = window.length;
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return {
    name: result.name,
    expect: result.expect,
    samples: n,
    dominantState: dominant,
    stateCounts: counts,
    meanScore: Math.round(score / n),
    meanNaiveScore: Math.round(naive / n),
    meanConfidence: Number((confidence / n).toFixed(3)),
    meanSpoofRisk: Number((spoofRisk / n).toFixed(3))
  };
}

// Replay a captured raw stream body (exactly what the HTTP response yielded)
// back through the parser, so Phase 2 recordings need no preprocessing.
export function replayRawStream(text, options = {}) {
  const book = new OrderBookState(options.bookConfig || {});
  const tracker = new SignalTracker(options.signalConfig || {});
  const samples = [];
  let clock = options.startTime ?? 0;
  const step = options.stepMs ?? 100;

  const parser = createJsonStreamParser({
    onValue(frame) {
      const event = classifyFrame(frame);
      if (event.kind !== FrameKind.DEPTH) return;
      clock += step;
      book.applyDepth(normalizeDepthFrame(frame, { timestamp: clock }));
      const snapshot = book.snapshot(clock);
      samples.push({ t: clock, snapshot, signal: tracker.update(snapshot) });
    },
    onError: options.onError || (() => {})
  });

  parser.write(text);
  parser.end();
  return { name: options.name || "raw-stream", samples, book, tracker };
}
