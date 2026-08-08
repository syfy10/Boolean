// Turns a book snapshot into a signed pressure score plus a confidence term.
//
// The naive reading of a ladder ("big offers stacked above = bearish") is
// exactly the inference layering is designed to manufacture. So resting size is
// discounted three ways before it counts:
//
//   distance    size far from the touch moves price less
//   persistence size that has rested is intent; size posted 200ms ago is a claim
//   credibility size at a level that keeps flickering in and out is discounted
//
// and the resulting score is gated by a confidence term that collapses when the
// book looks manufactured. A low-confidence signal is reported as NEUTRAL.

import { clamp } from "./util.js";

export const DEFAULT_SIGNAL_CONFIG = Object.freeze({
  levels: 10,
  distanceLambdaTicks: 4,
  persistenceFullMs: 3000,
  weights: { imbalance: 0.45, absorption: 0.35, aggression: 0.2 },
  minUpdates: 20,
  minElapsedMs: 3000,
  staleMs: 2000,
  followThroughTicks: 2,
  // Real futures books cancel far more than they trade even when nobody is
  // misbehaving, so the tolerance is deliberately loose. Calibrate against a
  // live session before trusting it.
  cancelTolerance: 15,
  cancelPenaltyRange: 45,
  cancelPenaltyFloor: 0.1,
  enterScore: 35,
  exitScore: 18,
  minConfidence: 0.45
});

export const SignalState = Object.freeze({
  BUY: "buy",
  SELL: "sell",
  NEUTRAL: "neutral"
});

// The three discounts applied to one level, exposed so the monitor UI can show
// exactly what the engine did rather than a recomputed approximation of it.
export function explainLevel(level, config = DEFAULT_SIGNAL_CONFIG) {
  const distance = Math.exp(-level.ticksFromTouch / config.distanceLambdaTicks);
  const persistence = Math.sqrt(clamp(level.restMs / config.persistenceFullMs, 0, 1));
  const credibility = 1 - level.flicker;
  return {
    distance,
    persistence,
    credibility,
    effective: level.size * distance * persistence * credibility
  };
}

function weighLevels(levels, config) {
  const { distanceLambdaTicks, levels: maxLevels } = config;
  let weighted = 0;
  let raw = 0;
  let flickerWeighted = 0;

  for (const level of levels.slice(0, maxLevels)) {
    const { distance, effective } = explainLevel(level, config);
    weighted += effective;
    raw += level.size;
    flickerWeighted += level.flicker * level.size * distance;
  }

  const distanceMass = levels
    .slice(0, maxLevels)
    .reduce((sum, l) => sum + l.size * Math.exp(-l.ticksFromTouch / distanceLambdaTicks), 0);

  return {
    weighted,
    raw,
    meanFlicker: distanceMass > 0 ? flickerWeighted / distanceMass : 0
  };
}

function ratio(bull, bear) {
  const total = bull + bear;
  return total > 0 ? (bull - bear) / total : 0;
}

export function computeSignal(snapshot, overrides = {}) {
  const config = { ...DEFAULT_SIGNAL_CONFIG, ...overrides, weights: { ...DEFAULT_SIGNAL_CONFIG.weights, ...(overrides.weights || {}) } };
  const bid = weighLevels(snapshot.bids, config);
  const ask = weighLevels(snapshot.asks, config);

  const imbalance = ratio(bid.weighted, ask.weighted);
  const naiveImbalance = ratio(bid.raw, ask.raw);
  const absorptionNet = clamp(snapshot.absorption.net, -1, 1);

  // Aggressive volume only counts as directional if it actually moved price.
  // Heavy selling into a bid that does not budge is the definition of
  // absorption, and letting the raw sell ratio read as bearish there would
  // cancel out the very signal we care about.
  const rawAggression = ratio(snapshot.volume.buy, snapshot.volume.sell);
  const followThrough = clamp(
    Math.abs(snapshot.midChangeTicks ?? 0) / config.followThroughTicks,
    0,
    1
  );
  const aggression = rawAggression * followThrough;

  const { weights } = config;
  const rawScore =
    weights.imbalance * imbalance + weights.absorption * absorptionNet + weights.aggression * aggression;
  const score = Math.round(clamp(rawScore, -1, 1) * 100);

  const rawCancelToTrade = snapshot.flow.cancelToTrade;
  const worstCancelToTrade = Number.isFinite(rawCancelToTrade) ? rawCancelToTrade : 999;

  const warmup = clamp(
    Math.min(snapshot.updates / config.minUpdates, snapshot.elapsedMs / config.minElapsedMs),
    0,
    1
  );
  const credibility = clamp(1 - Math.max(bid.meanFlicker, ask.meanFlicker), 0, 1);
  const cancelPenalty = clamp(
    1 - (worstCancelToTrade - config.cancelTolerance) / config.cancelPenaltyRange,
    config.cancelPenaltyFloor,
    1
  );
  const freshness = clamp(1 - snapshot.stalenessMs / config.staleMs, 0, 1);

  const components = [
    { code: "imbalance", value: imbalance, weight: weights.imbalance },
    { code: "absorption", value: absorptionNet, weight: weights.absorption },
    { code: "aggression", value: aggression, weight: weights.aggression }
  ];
  const active = components.filter((c) => Math.abs(c.value) > 0.05);
  const direction = Math.sign(rawScore);
  const agreement =
    active.length <= 1
      ? 0.6
      : active.filter((c) => Math.sign(c.value) === direction).length / active.length;

  const confidence = clamp(
    warmup * credibility * cancelPenalty * freshness * (0.5 + 0.5 * agreement),
    0,
    1
  );

  const reasons = buildReasons({
    components,
    naiveImbalance,
    imbalance,
    credibility,
    cancelPenalty,
    worstCancelToTrade,
    warmup,
    freshness,
    snapshot
  });

  return {
    timestamp: snapshot.timestamp,
    score,
    confidence: Number(confidence.toFixed(3)),
    naiveScore: Math.round(naiveImbalance * 100),
    spoofRisk: Number(clamp(1 - credibility * cancelPenalty, 0, 1).toFixed(3)),
    components: {
      imbalance: Number(imbalance.toFixed(3)),
      absorption: Number(absorptionNet.toFixed(3)),
      aggression: Number(aggression.toFixed(3))
    },
    quality: {
      warmup: Number(warmup.toFixed(3)),
      credibility: Number(credibility.toFixed(3)),
      cancelPenalty: Number(cancelPenalty.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      agreement: Number(agreement.toFixed(3)),
      followThrough: Number(followThrough.toFixed(3)),
      cancelToTrade: worstCancelToTrade
    },
    reasons,
    config
  };
}

function buildReasons(ctx) {
  const reasons = [];
  const push = (code, detail, value) => reasons.push({ code, detail, value: Number(value.toFixed(3)) });

  const { imbalance, naiveImbalance } = ctx;
  push(
    "imbalance",
    imbalance > 0 ? "Filtered book leans to the bid" : "Filtered book leans to the offer",
    imbalance
  );

  if (Math.abs(naiveImbalance - imbalance) > 0.25) {
    push(
      "filtered",
      `Raw depth reads ${(naiveImbalance * 100).toFixed(0)} but most of that size is fresh or flickering; discounted to ${(imbalance * 100).toFixed(0)}`,
      naiveImbalance - imbalance
    );
  }

  const absorptionValue = ctx.components.find((c) => c.code === "absorption").value;
  if (Math.abs(absorptionValue) > 0.05) {
    push(
      "absorption",
      absorptionValue > 0
        ? "Bid is refilling against aggressive selling"
        : "Offer is refilling against aggressive buying",
      absorptionValue
    );
  }

  const aggressionValue = ctx.components.find((c) => c.code === "aggression").value;
  if (Math.abs(aggressionValue) > 0.05) {
    push(
      "aggression",
      aggressionValue > 0 ? "Trades are lifting the offer" : "Trades are hitting the bid",
      aggressionValue
    );
  }

  if (ctx.credibility < 0.7) {
    push("flicker", "Resting size keeps appearing and vanishing at these levels", 1 - ctx.credibility);
  }
  if (ctx.cancelPenalty < 0.9) {
    const shown = Number.isFinite(ctx.worstCancelToTrade) ? ctx.worstCancelToTrade.toFixed(1) : "very high";
    push("cancel-rate", `Cancelled size is ${shown}x traded size on the heavier side`, 1 - ctx.cancelPenalty);
  }
  if (ctx.warmup < 1) push("warmup", "Still building book history", ctx.warmup);
  if (ctx.freshness < 1) push("stale", "Depth updates have gone quiet", 1 - ctx.freshness);

  return reasons;
}

// Hysteresis: enter on a strong reading, leave only once it decays well below
// the trigger, so a score hovering at the threshold does not strobe the UI.
export class SignalTracker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_SIGNAL_CONFIG, ...config };
    this.state = SignalState.NEUTRAL;
    this.enteredAt = null;
  }

  update(snapshot) {
    const signal = computeSignal(snapshot, this.config);
    const { enterScore, exitScore, minConfidence } = this.config;
    const confident = signal.confidence >= minConfidence;
    const previous = this.state;

    if (this.state === SignalState.NEUTRAL) {
      if (confident && signal.score >= enterScore) this.state = SignalState.BUY;
      else if (confident && signal.score <= -enterScore) this.state = SignalState.SELL;
    } else if (this.state === SignalState.BUY) {
      if (!confident || signal.score < exitScore) this.state = SignalState.NEUTRAL;
    } else if (this.state === SignalState.SELL) {
      if (!confident || signal.score > -exitScore) this.state = SignalState.NEUTRAL;
    }

    if (this.state !== previous) this.enteredAt = signal.timestamp;

    return {
      ...signal,
      state: this.state,
      changed: this.state !== previous,
      heldForMs: this.enteredAt == null ? 0 : signal.timestamp - this.enteredAt
    };
  }
}
