#!/usr/bin/env node
// Serves the order-flow monitor and streams engine state to it over SSE.
//
//   node orderflow/src/monitor-server.js [scenario] [--port 8790] [--speed 1]
//
// The UI never computes anything: every number it draws, including the per-level
// discounts, is what the engine actually used. A source feeds frames in; today
// that is the replay harness, in Phase 2 it becomes the live depth stream, and
// the UI does not need to know which.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { OrderBookState } from "./book-state.js";
import { SignalTracker, explainLevel } from "./signal-engine.js";
import { EntryTracker } from "./entry-engine.js";
import { normalizeDepthFrame } from "./depth-normalize.js";
import { SCENARIOS } from "./scenarios.js";
import { loadConfig, assertUsable } from "./tradestation-config.js";
import { createTokenStore, createTokenProvider } from "./tradestation-auth.js";
import { createLiveSource } from "./live-source.js";
import { createCaptureWriter, captureFilePath } from "./capture.js";
import { OutcomeTracker } from "./outcome-tracker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..", "ui");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const scenarioName = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "dynamicLayering";
const port = Number(arg("port", 8790));
const speed = Number(arg("speed", 1));
const liveSymbol = arg("live", null);
const wantCapture = process.argv.includes("--capture");

const clients = new Set();

function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(payload);
}

function trimLevels(levels, config) {
  return levels.slice(0, 10).map((level) => {
    const weights = explainLevel(level, config);
    return {
      price: level.price,
      size: level.size,
      ticks: level.ticksFromTouch,
      restMs: level.restMs,
      flicker: Number(level.flicker.toFixed(3)),
      vanishCount: level.vanishCount,
      distance: Number(weights.distance.toFixed(3)),
      persistence: Number(weights.persistence.toFixed(3)),
      credibility: Number(weights.credibility.toFixed(3)),
      effective: Number(weights.effective.toFixed(1))
    };
  });
}

// Replay source: walks a scenario on a real-time clock so the UI animates the
// way a live feed would. Lifecycle events are real, not decorative -- they are
// the same ones the live stream client will emit in Phase 2.
function createReplaySource(name, { onState, onLog }) {
  const scenario = SCENARIOS[name]();
  const config = { tickSize: scenario.tickSize };
  let book = new OrderBookState(config);
  let tracker = new SignalTracker();
  let entryTracker = new EntryTracker();
  let index = 0;
  let timer = null;
  let lastHeartbeat = 0;
  // The scenario restarts from t=0 each loop. Anything measuring elapsed time
  // across loops -- outcome horizons in particular -- needs a clock that only
  // moves forward, so each restart adds the scenario's duration as an offset.
  let loopOffset = 0;
  let scenarioDuration = 0;

  const steps = [];
  for (const event of scenario.events) {
    const last = steps[steps.length - 1];
    if (last && last.t === event.t) last.events.push(event);
    else steps.push({ t: event.t, events: [event] });
  }

  scenarioDuration = (steps[steps.length - 1]?.t ?? 0) + 100;

  function restart() {
    book = new OrderBookState(config);
    tracker = new SignalTracker();
    entryTracker = new EntryTracker();
    if (index > 0) loopOffset += scenarioDuration;
    index = 0;
    lastHeartbeat = loopOffset;
    onLog({ level: "info", text: `stream open — ${scenario.name} (replay)` });
    onLog({ level: "info", text: "StreamStatus: EndSnapshot" });
  }

  function tick() {
    if (index >= steps.length) {
      onLog({ level: "warn", text: "StreamStatus: GoAway — restarting replay" });
      restart();
    }

    const step = steps[index++];
    const clock = step.t + loopOffset;
    let depthApplied = false;

    for (const event of step.events) {
      if (event.type === "trade") {
        book.applyTrade({ ...event.payload, timestamp: event.t + loopOffset });
      } else if (event.type === "depth") {
        book.applyDepth(normalizeDepthFrame(event.payload, { timestamp: event.t + loopOffset }));
        depthApplied = true;
      }
    }

    if (clock - lastHeartbeat >= 5000) {
      lastHeartbeat = clock;
      onLog({ level: "muted", text: "Heartbeat" });
    }

    if (depthApplied) {
      const snapshot = book.snapshot(clock);
      const signal = tracker.update(snapshot);
      if (index % 5 === 0 && snapshot.bestBid != null && snapshot.bestAsk != null) {
        const midpoint = (snapshot.bestBid + snapshot.bestAsk) / 2;
        entryTracker.updateBar({ TimeStamp: `replay-${index}`, Open: midpoint, High: midpoint, Low: midpoint, Close: midpoint, TotalVolume: snapshot.volume.buy + snapshot.volume.sell || 1 });
      }
      const entry = entryTracker.evaluate(signal);
      if (signal.changed) {
        onLog({
          level: signal.state === "neutral" ? "info" : "signal",
          text: `signal → ${signal.state.toUpperCase()} (score ${signal.score}, confidence ${signal.confidence})`
        });
      }
      onState({ snapshot, signal, entry, scenario });
    }

    const next = steps[index];
    const delay = next ? Math.max(10, (next.t - step.t) / speed) : 400;
    timer = setTimeout(tick, delay);
  }

  restart();
  timer = setTimeout(tick, 100);
  return { stop: () => clearTimeout(timer), scenario };
}

let latest = null;

// Outcomes are recorded in every mode, including replay, so the pipeline that
// has to work during the first live session is exercised long before it.
const outcomes = new OutcomeTracker();
const outcomeDir = path.join(here, "..", "outcomes");
let outcomeStream = null;

function persistOutcome(observation) {
  if (!outcomeStream) {
    fs.mkdirSync(outcomeDir, { recursive: true });
    const label = (liveSymbol || scenarioName).replace(/[^\w]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    outcomeStream = fs.createWriteStream(path.join(outcomeDir, `${label}-${stamp}.ndjson`), { flags: "a" });
  }
  outcomeStream.write(`${JSON.stringify(observation)}\n`);
}

function publish({ snapshot, signal, entry, mode, title, subtitle }) {
  if (snapshot.mid != null) {
    outcomes.observe(snapshot.mid, snapshot.timestamp, persistOutcome);
    outcomes.record({ signal, entry, price: snapshot.mid, timestamp: snapshot.timestamp });
  }
  latest = buildPayload({ snapshot, signal, entry, mode, title, subtitle });
  broadcast(latest);
}

function buildPayload({ snapshot, signal, entry, mode, title, subtitle }) {
  return {
      protocol: { name: "light-engine", version: 1 },
      type: "state",
      t: snapshot.timestamp,
      mode,
      scenario: { name: title, description: subtitle, expect: null },
      signal: {
        state: signal.state,
        score: signal.score,
        naiveScore: signal.naiveScore,
        confidence: signal.confidence,
        spoofRisk: signal.spoofRisk,
        components: signal.components,
        quality: signal.quality,
        reasons: signal.reasons,
        weights: signal.config.weights,
        thresholds: {
          enter: signal.config.enterScore,
          exit: signal.config.exitScore,
          minConfidence: signal.config.minConfidence
        }
      },
      entry: entry || null,
      outcomes: { resolved: outcomes.resolved.length, pending: outcomes.pending.length },
      book: {
        bestBid: snapshot.bestBid,
        bestAsk: snapshot.bestAsk,
        spreadTicks: snapshot.spreadTicks,
        midChangeTicks: Number((snapshot.midChangeTicks || 0).toFixed(2)),
        bids: trimLevels(snapshot.bids, signal.config),
        asks: trimLevels(snapshot.asks, signal.config)
      },
      flow: {
        bidAdded: snapshot.flow.bid.added,
        bidCancelled: snapshot.flow.bid.cancelled,
        askAdded: snapshot.flow.ask.added,
        askCancelled: snapshot.flow.ask.cancelled,
        cancelToTrade: Number.isFinite(snapshot.flow.cancelToTrade)
          ? Number(snapshot.flow.cancelToTrade.toFixed(1))
          : null,
        buyVolume: snapshot.volume.buy,
        sellVolume: snapshot.volume.sell
      }
  };
}

function log(entry) {
  broadcast({ type: "log", t: Date.now(), ...entry });
}

let source;
let capture = null;
let calibration = null;

function captureSummary() {
  return capture ? { active: true, path: capture.path, ...capture.stats } : { active: false };
}

function listCaptures() {
  const dir = path.join(here, "..", "captures");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      const stat = fs.statSync(file);
      return { name: entry.name, path: file, bytes: stat.size, updatedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function runCalibration(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(here, "calibrate.js"), file], { cwd: path.join(here, "..", ".."), timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

if (liveSymbol) {
  const config = assertUsable(loadConfig());
  const store = createTokenStore();
  const tokenProvider = createTokenProvider(config, store);

  if (wantCapture) {
    capture = createCaptureWriter(captureFilePath(liveSymbol));
    console.log(`capturing raw frames to ${capture.path}`);
  }

  source = createLiveSource({
    config,
    symbol: liveSymbol,
    tokenProvider,
    onLog: log,
    onRaw: (kind, text, t) => capture?.write(kind, text, t),
    onState({ snapshot, signal, entry, symbol }) {
      publish({
        snapshot,
        signal,
        entry,
        mode: config.live ? "live" : "sim",
        title: symbol,
        subtitle: config.api
      });
    }
  });
  source.start();
} else {
  source = createReplaySource(scenarioName, {
    onLog: log,
    onState({ snapshot, signal, entry, scenario }) {
      publish({
        snapshot,
        signal,
        entry,
        mode: "replay",
        title: scenario.name,
        subtitle: scenario.description
      });
    }
  });
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === "/api/status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      protocol: { name: "light-engine", version: 1 },
      engine: "orderflow",
      mode: liveSymbol ? "live" : "replay",
      symbol: liveSymbol || scenarioName,
      readOnly: true,
      calibrated: Boolean(calibration),
      calibration,
      capture: captureSummary(),
      captures: listCaptures().length
    });
    return;
  }

  if (url.pathname === "/api/outcomes" && req.method === "GET") {
    return sendJson(res, 200, outcomes.summarize());
  }

  if (url.pathname === "/api/captures" && req.method === "GET") {
    sendJson(res, 200, { ok: true, captures: listCaptures() });
    return;
  }

  if (url.pathname === "/api/capture/start" && req.method === "POST") {
    if (!liveSymbol) return sendJson(res, 409, { error: "Capture requires a live TradeStation symbol." });
    if (!capture) capture = createCaptureWriter(captureFilePath(liveSymbol));
    sendJson(res, 200, { ok: true, capture: captureSummary() });
    return;
  }

  if (url.pathname === "/api/capture/stop" && req.method === "POST") {
    if (!capture) return sendJson(res, 200, { ok: true, capture: { active: false } });
    const finished = capture;
    capture = null;
    finished.close().then(() => sendJson(res, 200, { ok: true, capture: { active: false, path: finished.path, ...finished.stats } }));
    return;
  }

  if (url.pathname === "/api/calibrate" && req.method === "POST") {
    const requested = url.searchParams.get("file");
    const captures = listCaptures();
    const selected = requested ? captures.find((item) => item.name === requested) : captures[0];
    if (!selected) return sendJson(res, 404, { error: "No capture is available to calibrate." });
    runCalibration(selected.path)
      .then((output) => {
        calibration = { file: selected.name, completedAt: Date.now() };
        sendJson(res, 200, { ok: true, file: selected.name, calibrated: true, calibration, output });
      })
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    clients.add(res);
    if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const target = path.join(uiDir, file);
  if (!target.startsWith(uiDir) || !fs.existsSync(target)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "text/plain" });
  fs.createReadStream(target).pipe(res);
});

// Loopback only. The engine exposes POST endpoints that write capture files and
// spawn calibration processes, plus a live market-state stream; binding the
// default 0.0.0.0 would offer all of that to anyone on the same network.
const HOST = "127.0.0.1";

server.listen(port, HOST, () => {
  const what = liveSymbol ? `live ${liveSymbol}` : `${source.scenario.name}, replay at ${speed}x`;
  console.log(`order-flow monitor: http://${HOST}:${port}  (${what})`);
});

process.on("SIGINT", async () => {
  await source.stop();
  if (capture) {
    await capture.close();
    console.log(`\ncapture written: ${capture.path} (${capture.stats.chunks} chunks, ${capture.stats.bytes} bytes)`);
  }
  server.close();
  process.exit(0);
});
