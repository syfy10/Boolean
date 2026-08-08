// Records what the engine said, and what price actually did next.
//
// This is the only thing that can eventually answer "does this signal predict
// anything". It has to be running during the first live session, because a
// session that produced no record cannot be re-run.
//
// Observations are taken on a fixed cadence regardless of state, including
// NEUTRAL. That is deliberate: without neutral samples there is no control
// group, and a signal that fires only in trends will look predictive purely
// because the market drifts.

export const DEFAULT_OUTCOME_CONFIG = Object.freeze({
  horizonsMs: [5_000, 30_000, 60_000, 300_000],
  cadenceMs: 5_000,
  tickSize: 0.25
});

function directionOf(state) {
  if (state === "buy") return 1;
  if (state === "sell") return -1;
  return 0;
}

export class OutcomeTracker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_OUTCOME_CONFIG, ...config };
    this.horizons = [...this.config.horizonsMs].sort((a, b) => a - b);
    this.pending = [];
    this.resolved = [];
    this.lastRecordAt = null;
    this.nextId = 1;
  }

  // Returns the new observation, or null if it is too soon since the last one.
  record({ signal, entry = null, price, timestamp, force = false }) {
    if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return null;
    if (!force && this.lastRecordAt != null && timestamp - this.lastRecordAt < this.config.cadenceMs) {
      return null;
    }
    this.lastRecordAt = timestamp;

    const observation = {
      id: this.nextId++,
      t: timestamp,
      price,
      state: signal?.state ?? "neutral",
      direction: directionOf(signal?.state),
      score: signal?.score ?? 0,
      confidence: signal?.confidence ?? 0,
      spoofRisk: signal?.spoofRisk ?? 0,
      entrySide: entry?.side ?? null,
      entryActionable: Boolean(entry?.actionable),
      favourableTicks: 0,
      adverseTicks: 0,
      horizons: {},
      resolved: false
    };
    this.pending.push(observation);
    return observation;
  }

  // Feed every mid-price update in. Fills horizons as they elapse and tracks
  // maximum favourable and adverse excursion in between.
  observe(price, timestamp, onResolved) {
    if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return [];
    const { tickSize } = this.config;
    const finished = [];

    for (const observation of this.pending) {
      const moveTicks = (price - observation.price) / tickSize;
      // For a neutral observation there is no favoured side, so excursion is
      // tracked as absolute movement instead of signed against a direction.
      const favourable = observation.direction === 0 ? Math.abs(moveTicks) : moveTicks * observation.direction;
      observation.favourableTicks = Math.max(observation.favourableTicks, favourable);
      observation.adverseTicks = Math.min(observation.adverseTicks, favourable);

      for (const horizon of this.horizons) {
        if (observation.horizons[horizon] != null) continue;
        if (timestamp - observation.t < horizon) continue;
        observation.horizons[horizon] = {
          price,
          moveTicks: Number(moveTicks.toFixed(3)),
          favourableTicks: Number(favourable.toFixed(3))
        };
      }

      if (this.horizons.every((h) => observation.horizons[h] != null)) {
        observation.resolved = true;
        observation.favourableTicks = Number(observation.favourableTicks.toFixed(3));
        observation.adverseTicks = Number(observation.adverseTicks.toFixed(3));
        finished.push(observation);
      }
    }

    if (finished.length) {
      const done = new Set(finished);
      this.pending = this.pending.filter((o) => !done.has(o));
      this.resolved.push(...finished);
      if (onResolved) for (const observation of finished) onResolved(observation);
    }
    return finished;
  }

  summarize() {
    const byState = {};
    for (const observation of this.resolved) {
      const bucket = (byState[observation.state] ||= {
        state: observation.state,
        samples: 0,
        horizons: {},
        meanFavourableTicks: 0,
        meanAdverseTicks: 0
      });
      bucket.samples++;
      bucket.meanFavourableTicks += observation.favourableTicks;
      bucket.meanAdverseTicks += observation.adverseTicks;
      for (const horizon of this.horizons) {
        const slot = (bucket.horizons[horizon] ||= { samples: 0, sumTicks: 0, wins: 0 });
        const value = observation.horizons[horizon];
        if (!value) continue;
        slot.samples++;
        slot.sumTicks += value.favourableTicks;
        if (value.favourableTicks > 0) slot.wins++;
      }
    }

    for (const bucket of Object.values(byState)) {
      bucket.meanFavourableTicks = Number((bucket.meanFavourableTicks / bucket.samples).toFixed(3));
      bucket.meanAdverseTicks = Number((bucket.meanAdverseTicks / bucket.samples).toFixed(3));
      for (const slot of Object.values(bucket.horizons)) {
        slot.meanTicks = slot.samples ? Number((slot.sumTicks / slot.samples).toFixed(3)) : null;
        slot.hitRate = slot.samples ? Number((slot.wins / slot.samples).toFixed(3)) : null;
        delete slot.sumTicks;
      }
    }

    return {
      resolved: this.resolved.length,
      pending: this.pending.length,
      horizonsMs: this.horizons,
      byState,
      // Until there are directional samples AND neutral samples to compare
      // against, no claim about predictiveness is supportable.
      comparable: Boolean(byState.neutral?.samples) && Boolean(byState.buy?.samples || byState.sell?.samples)
    };
  }
}
