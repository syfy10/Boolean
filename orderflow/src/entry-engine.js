// Read-only entry candidate engine.
//
// Price structure decides where an entry could make sense. Order flow only
// confirms or vetoes that setup. This module never creates or submits orders.

import { clamp } from "./util.js";

export const DEFAULT_ENTRY_CONFIG = Object.freeze({
  emaPeriod: 9,
  minBars: 10,
  minConfidence: 0.55,
  maxSpoofRisk: 0.35,
  minFlowScore: 35,
  // CME equity index futures open at 18:00 ET. Without a reset, VWAP silently
  // becomes a rolling multi-hour average that never matches what a trader sees.
  sessionResetHourET: 18,
  // Depth stops arriving long before a stream formally errors. Scoring a frozen
  // book is worse than admitting the feed is stale.
  minFreshness: 0.5
});

const sessionKeyCache = new Map();

// Which trading session a bar belongs to. Returns null when the timestamp is
// not a real date, in which case every bar groups together and VWAP degrades to
// the old rolling behaviour rather than throwing.
export function sessionKeyOf(timestamp, resetHourET = 18) {
  if (!timestamp) return null;
  const cacheKey = `${timestamp}|${resetHourET}`;
  if (sessionKeyCache.has(cacheKey)) return sessionKeyCache.get(cacheKey);

  // Date parsing is dangerously lenient: new Date("replay-42") yields the year
  // 2042, which would scatter bars across invented sessions. Only accept
  // something that actually looks like an ISO timestamp.
  const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  const date = ISO_LIKE.test(String(timestamp)) ? new Date(timestamp) : new Date(NaN);
  let key = null;
  if (!Number.isNaN(date.getTime())) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value])
    );
    const hour = Number(parts.hour) % 24;
    if (hour >= resetHourET) {
      const next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
      key = next.toISOString().slice(0, 10);
    } else {
      key = `${parts.year}-${parts.month}-${parts.day}`;
    }
  }

  if (sessionKeyCache.size > 5000) sessionKeyCache.clear();
  sessionKeyCache.set(cacheKey, key);
  return key;
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function normalizeBar(frame) {
  if (!frame || typeof frame !== "object") return null;
  const bar = {
    timestamp: frame.TimeStamp || frame.Timestamp || frame.timeStamp || frame.timestamp || null,
    open: number(frame.Open ?? frame.open),
    high: number(frame.High ?? frame.high),
    low: number(frame.Low ?? frame.low),
    close: number(frame.Close ?? frame.close),
    volume: number(frame.TotalVolume ?? frame.Volume ?? frame.totalVolume ?? frame.volume) || 0
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}

export function ema(values, period = 9) {
  if (!values.length) return null;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((value, next) => next * alpha + value * (1 - alpha), values[0]);
}

export function vwap(bars) {
  let volume = 0;
  let value = 0;
  for (const bar of bars) {
    if (!(bar.volume > 0)) continue;
    volume += bar.volume;
    value += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
  }
  return volume > 0 ? value / volume : null;
}

export function evaluateEntryCandidate(bars, signal, overrides = {}) {
  const config = { ...DEFAULT_ENTRY_CONFIG, ...overrides };
  const usable = bars.filter(Boolean);
  const latest = usable.at(-1) || null;
  const previous = usable.at(-2) || null;
  const ema9 = ema(usable.map((bar) => bar.close), config.emaPeriod);
  const currentSession = sessionKeyOf(latest?.timestamp, config.sessionResetHourET);
  const sessionBars = usable.filter(
    (bar) => sessionKeyOf(bar.timestamp, config.sessionResetHourET) === currentSession
  );
  const sessionVwap = vwap(sessionBars);
  const metrics = {
    price: latest?.close ?? null,
    ema9: ema9 == null ? null : Number(ema9.toFixed(4)),
    vwap: sessionVwap == null ? null : Number(sessionVwap.toFixed(4)),
    priorHigh: previous?.high ?? null,
    priorLow: previous?.low ?? null,
    bars: usable.length,
    sessionBars: sessionBars.length,
    session: currentSession
  };

  const reasons = [];
  if (usable.length < config.minBars || !latest || !previous) reasons.push(`Need ${config.minBars} completed 5-minute bars`);
  const confidence = Number(signal?.confidence) || 0;
  const spoofRisk = Number(signal?.spoofRisk) || 0;
  const score = Number(signal?.score) || 0;
  if (confidence < config.minConfidence) reasons.push("Order-flow confidence is below the entry floor");
  if (spoofRisk > config.maxSpoofRisk) reasons.push("Spoof risk is too high");

  // freshness is 1 while depth is arriving and decays to 0 once it stops.
  const freshness = signal?.quality?.freshness == null ? 1 : Number(signal.quality.freshness);
  const fresh = freshness >= config.minFreshness;
  if (!fresh) reasons.push("Depth updates have gone stale — not scoring a frozen book");

  const priceReady = usable.length >= config.minBars && latest && previous && ema9 != null && sessionVwap != null;
  const buyStructure = priceReady && latest.close > previous.high && latest.close > ema9 && latest.close > sessionVwap;
  const sellStructure = priceReady && latest.close < previous.low && latest.close < ema9 && latest.close < sessionVwap;
  const buyFlow = signal?.state === "buy" && score >= config.minFlowScore;
  const sellFlow = signal?.state === "sell" && score <= -config.minFlowScore;
  const quality = confidence >= config.minConfidence && spoofRisk <= config.maxSpoofRisk && fresh;

  let side = "wait";
  if (quality && buyStructure && buyFlow) side = "buy";
  else if (quality && sellStructure && sellFlow) side = "sell";
  else {
    if (priceReady && !buyStructure && !sellStructure) reasons.push("No confirmed break of the prior 5-minute range");
    if ((buyStructure || sellStructure) && !(buyFlow || sellFlow)) reasons.push("Price setup is not confirmed by order flow");
    // Structure and flow pointing opposite ways is the failed-breakout case, and
    // the one a reader most needs named. Without this it fell through to the
    // confirmation wording below and read as agreement.
    if (buyStructure && sellFlow) {
      reasons.push("Price broke above the prior 5-minute high while order flow is pressing the offer");
    }
    if (sellStructure && buyFlow) {
      reasons.push("Price broke below the prior 5-minute low while order flow is pressing the bid");
    }
  }

  const alignment = [
    latest && ema9 != null ? (latest.close >= ema9 ? 1 : -1) : 0,
    latest && sessionVwap != null ? (latest.close >= sessionVwap ? 1 : -1) : 0,
    clamp(score / 100, -1, 1)
  ];

  return {
    type: "entry-candidate",
    version: 1,
    side,
    actionable: side !== "wait",
    readOnly: true,
    timestamp: latest?.timestamp || signal?.timestamp || null,
    metrics,
    quality: { confidence, spoofRisk, flowScore: score, alignment: Number((alignment.reduce((a, b) => a + b, 0) / 3).toFixed(3)) },
    checks: { buyStructure, sellStructure, buyFlow, sellFlow, quality },
    // A wait must never fall back to confirmation wording, whatever combination
    // of checks produced it.
    reasons: reasons.length
      ? reasons
      : [
          side === "wait"
            ? "Conditions have not aligned"
            : `${side.toUpperCase()} setup confirmed by price structure and order flow`
        ]
  };
}

export class EntryTracker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENTRY_CONFIG, ...config };
    this.bars = [];
    this.rejected = 0;
    this.undated = 0;
  }

  // A bar with no timestamp cannot be told apart from an update to the bar
  // before it. Guessing appends the same forming bar over and over and quietly
  // corrupts priorHigh/priorLow, so these are rejected and counted instead --
  // a loud failure if the real feed names its timestamp field differently.
  updateBar(frame) {
    const bar = normalizeBar(frame);
    if (!bar) {
      this.rejected++;
      return null;
    }
    if (!bar.timestamp) {
      this.undated++;
      return null;
    }
    const index = this.bars.findIndex((item) => item.timestamp === bar.timestamp);
    if (index >= 0) this.bars[index] = bar;
    else this.bars.push(bar);
    this.bars = this.bars.slice(-120);
    return bar;
  }

  evaluate(signal) {
    return evaluateEntryCandidate(this.bars, signal, this.config);
  }
}
