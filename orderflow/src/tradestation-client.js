// Long-lived streaming connection to a TradeStation endpoint.
//
// Everything external is injectable (fetch, sleep, clock) so the reconnect and
// error-handling behaviour is testable without a network or real waits -- which
// matters here, because the failure modes we care about are exactly the ones
// that are painful to reproduce live.

import { createJsonStreamParser } from "./json-stream.js";
import { classifyFrame, connectionAction, FrameKind } from "./stream-events.js";
import { createReconnectGovernor } from "./reconnect-governor.js";

const STREAM_ACCEPT = "application/vnd.tradestation.streams.v2+json";

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function createStream(options) {
  const {
    url,
    label = "stream",
    tokenProvider,
    governor = createReconnectGovernor(),
    onEvent = () => {},
    onLog = () => {},
    onRaw = null,
    deps = {}
  } = options;

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;

  let stopped = false;
  let controller = null;
  let finished = null;

  function log(level, text) {
    onLog({ level, text: `${label}: ${text}` });
  }

  async function consume(res) {
    let action = "ended";
    const parser = createJsonStreamParser({
      onValue(frame) {
        const event = classifyFrame(frame);
        const next = connectionAction(event);

        if (event.kind === FrameKind.HEARTBEAT) {
          onLog({ level: "muted", text: "Heartbeat" });
        } else if (event.kind === FrameKind.STATUS) {
          log("info", `StreamStatus: ${event.status}`);
          if (event.goAway) action = "goaway";
        } else if (event.kind === FrameKind.ERROR) {
          log(
            "warn",
            `${event.error}${event.retryable ? "" : " (not retryable — stopping)"}`
          );
          action = next === "stop" ? "stop" : "goaway";
        } else {
          onEvent(event);
        }
      },
      onError(err) {
        log("warn", err.message);
      }
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (onRaw) onRaw(text, now());
      parser.write(text);
      if (action === "goaway" || action === "stop" || stopped) {
        try {
          await reader.cancel();
        } catch {
          // the stream is going away regardless
        }
        break;
      }
    }
    parser.end();
    return action;
  }

  async function loop() {
    while (!stopped) {
      const gate = governor.canConnect(now());
      if (!gate.ok) {
        log("warn", `holding off ${Math.round(gate.waitMs)}ms — ${gate.reason}`);
        await sleep(gate.waitMs);
        continue;
      }

      let token;
      try {
        token = await tokenProvider();
      } catch (err) {
        log("warn", `auth failed — ${err.message}`);
        await sleep(governor.noteFailure());
        continue;
      }

      controller = new AbortController();
      governor.noteConnect(now());
      let connected = false;

      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: STREAM_ACCEPT },
          signal: controller.signal
        });

        if (!res.ok) {
          const body = await safeText(res);
          // 429 means we already misjudged the quota; back off hard rather than
          // trying again on the next tick.
          log("warn", `HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""} — ${body.slice(0, 160)}`);
          governor.noteDisconnect();
          await sleep(governor.noteFailure());
          continue;
        }

        connected = true;
        governor.noteSuccess();
        log("info", "open");
        const action = await consume(res);
        governor.noteDisconnect();

        if (action === "stop") {
          log("warn", "stopping — this error will not resolve by retrying");
          stopped = true;
          break;
        }
        if (stopped) break;
        // A GoAway is routine, not a fault, so it must not escalate the ladder.
        log("info", action === "goaway" ? "reconnecting after GoAway" : "stream ended, reconnecting");
        await sleep(1000);
      } catch (err) {
        if (connected) governor.noteDisconnect();
        else governor.noteDisconnect();
        if (stopped) break;
        log("warn", `connection error — ${err.message}`);
        await sleep(governor.noteFailure());
      }
    }
    log("info", "closed");
  }

  return {
    start() {
      if (finished) return finished;
      finished = loop();
      return finished;
    },
    stop() {
      stopped = true;
      try {
        controller?.abort();
      } catch {
        // already gone
      }
      return finished || Promise.resolve();
    },
    get stopped() {
      return stopped;
    }
  };
}

export function depthStreamUrl(config, symbol, maxLevels = 20) {
  return `${config.api}/marketdata/stream/marketdepth/aggregates/${encodeURIComponent(symbol)}?maxlevels=${maxLevels}`;
}

export function quoteStreamUrl(config, symbol) {
  return `${config.api}/marketdata/stream/quotes/${encodeURIComponent(symbol)}`;
}

export function barHistoryUrl(config, symbol, { interval = 5, unit = "Minute", barsback = 60 } = {}) {
  return `${config.api}/marketdata/barcharts/${encodeURIComponent(symbol)}?interval=${interval}&unit=${encodeURIComponent(unit)}&barsback=${barsback}`;
}

// Without this the entry engine needs ~50 minutes of live streaming before it
// has enough bars to say anything, and every restart pays that cost again.
export async function fetchBarHistory(config, symbol, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const tokenProvider = deps.tokenProvider;
  const token = await tokenProvider();
  const res = await fetchImpl(barHistoryUrl(config, symbol, options), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!res.ok) {
    throw new Error(`bar history failed (${res.status}): ${(await safeText(res)).slice(0, 160)}`);
  }
  const payload = await res.json();
  const bars = payload?.Bars ?? payload?.bars ?? [];
  return Array.isArray(bars) ? bars : [];
}

export function barStreamUrl(config, symbol, interval = 5, unit = "Minute") {
  return `${config.api}/marketdata/stream/barcharts/${encodeURIComponent(symbol)}?interval=${interval}&unit=${encodeURIComponent(unit)}`;
}
