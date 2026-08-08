// Live source: the same interface the replay source presents to the monitor,
// backed by two real TradeStation streams.
//
// Depth drives the book. Quotes drive the tape, because market depth alone
// cannot tell you whether size left the book because it traded or because it
// was cancelled -- and that distinction is the whole spoof filter.

import { OrderBookState } from "./book-state.js";
import { SignalTracker } from "./signal-engine.js";
import { EntryTracker } from "./entry-engine.js";
import { normalizeDepthFrame, createTradeExtractor } from "./depth-normalize.js";
import { createReconnectGovernor } from "./reconnect-governor.js";
import { barStreamUrl, createStream, depthStreamUrl, fetchBarHistory, quoteStreamUrl } from "./tradestation-client.js";
import { FrameKind } from "./stream-events.js";

export function createLiveSource(options) {
  const {
    config,
    symbol,
    tokenProvider,
    onState = () => {},
    onLog = () => {},
    onRaw = null,
    maxLevels = 20,
    bookConfig = {},
    signalConfig = {},
    deps = {}
  } = options;

  const book = new OrderBookState({ tickSize: bookConfig.tickSize ?? 0.25, ...bookConfig });
  const tracker = new SignalTracker(signalConfig);
  const entryTracker = new EntryTracker();
  const extractTrade = createTradeExtractor();
  const now = deps.now || Date.now;

  let depthFrames = 0;
  let tradeCount = 0;
  let warnedNoTrades = false;

  const depth = createStream({
    url: depthStreamUrl(config, symbol, maxLevels),
    label: "depth",
    tokenProvider,
    // Depth is the quota-constrained endpoint: 30 requests/minute, 10 concurrent.
    governor: createReconnectGovernor({ maxPerWindow: 30, maxConcurrent: 10 }),
    onLog,
    onRaw: onRaw ? (text, t) => onRaw("depth", text, t) : null,
    deps,
    onEvent(event) {
      if (event.kind !== FrameKind.DEPTH) return;
      const t = now();
      book.applyDepth(normalizeDepthFrame(event.frame, { timestamp: t, symbol }));
      depthFrames++;

      if (depthFrames === 200 && tradeCount === 0 && !warnedNoTrades) {
        warnedNoTrades = true;
        onLog({
          level: "warn",
          text: "200 depth frames with no prints — cancel:trade will read as infinite and confidence will stay pinned low. Check the quote stream and the symbol."
        });
      }

      const snapshot = book.snapshot(t);
      const signal = tracker.update(snapshot);
      if (signal.changed) {
        onLog({
          level: signal.state === "neutral" ? "info" : "signal",
          text: `signal → ${signal.state.toUpperCase()} (score ${signal.score}, confidence ${signal.confidence})`
        });
      }
      onState({ snapshot, signal, entry: entryTracker.evaluate(signal), symbol });
    }
  });

  const quotes = createStream({
    url: quoteStreamUrl(config, symbol),
    label: "quotes",
    tokenProvider,
    governor: createReconnectGovernor({ maxPerWindow: 60, maxConcurrent: 10 }),
    onLog,
    onRaw: onRaw ? (text, t) => onRaw("quotes", text, t) : null,
    deps,
    onEvent(event) {
      if (event.kind !== FrameKind.QUOTE) return;
      const trade = extractTrade(event.frame, now());
      if (!trade) return;
      tradeCount++;
      book.applyTrade(trade);
    }
  });

  const bars = createStream({
    url: barStreamUrl(config, symbol, 5, "Minute"),
    label: "5m bars",
    tokenProvider,
    governor: createReconnectGovernor({ maxPerWindow: 500, maxConcurrent: 10 }),
    onLog,
    onRaw: onRaw ? (text, t) => onRaw("bars", text, t) : null,
    deps,
    onEvent(event) {
      if (event.kind === FrameKind.BAR) entryTracker.updateBar(event.frame);
    }
  });

  return {
    symbol,
    book,
    tracker,
    async start() {
      onLog({ level: "info", text: `connecting to ${symbol} on ${config.api}` });

      // Warm the entry engine from history before streaming, so it is not blind
      // for the first ~50 minutes. A failure here is not fatal: the engine still
      // fills from the stream, just slowly.
      try {
        const history = await fetchBarHistory(config, symbol, { barsback: 60 }, { ...deps, tokenProvider });
        for (const frame of history) entryTracker.updateBar(frame);
        onLog({ level: "info", text: `bar history: ${entryTracker.bars.length} of ${history.length} bars usable` });
        if (history.length && !entryTracker.bars.length) {
          onLog({
            level: "warn",
            text: `every history bar was rejected (${entryTracker.undated} undated, ${entryTracker.rejected} malformed) — the bar field names do not match normalizeBar`
          });
        }
      } catch (err) {
        onLog({ level: "warn", text: `bar history unavailable — ${err.message}` });
      }

      return Promise.all([depth.start(), quotes.start(), bars.start()]);
    },
    stop() {
      return Promise.all([depth.stop(), quotes.stop(), bars.stop()]);
    },
    get stats() {
      return { depthFrames, tradeCount };
    }
  };
}
