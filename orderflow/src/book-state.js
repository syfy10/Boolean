// Reconstructs a live ladder from aggregated depth frames and, crucially,
// remembers how each level BEHAVED over time.
//
// TradeStation depth is aggregated (MBP), not per-order (MBO), so we cannot see
// individual adds and cancels or queue position. What we can do is diff
// successive frames: a level that shrinks right after a print at its price was
// traded, and a level that shrinks or vanishes without a print was cancelled.
// That distinction is the whole basis of the spoof filtering downstream.

export const DEFAULT_BOOK_CONFIG = Object.freeze({
  tickSize: 0.25,
  windowMs: 5000,
  graveyardMs: 30000,
  tradeMatchMs: 1500,
  churnAlpha: 0.15,
  nearTouchTicks: 2,
  absorptionMinVolume: 20,
  flickerVanishFull: 3,
  flickerChurnFull: 0.6
});

function pruneWindow(events, cutoff) {
  let i = 0;
  while (i < events.length && events[i].t < cutoff) i++;
  if (i > 0) events.splice(0, i);
  return events;
}

function sumWindow(events, predicate) {
  let total = 0;
  for (const e of events) {
    if (!predicate || predicate(e)) total += e.size;
  }
  return total;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

class BookSide {
  constructor(kind, config) {
    this.kind = kind; // "bid" | "ask"
    this.config = config;
    this.levels = new Map(); // price -> record
    this.graveyard = new Map(); // price -> record, for counting reappearances
    this.added = [];
    this.cancelled = [];
    this.traded = [];
  }

  prune(cutoff, graveyardCutoff) {
    pruneWindow(this.added, cutoff);
    pruneWindow(this.cancelled, cutoff);
    pruneWindow(this.traded, cutoff);
    for (const [price, rec] of this.graveyard) {
      if (rec.diedAt < graveyardCutoff) this.graveyard.delete(price);
    }
  }

  ensure(price, t) {
    let rec = this.levels.get(price);
    if (rec) return rec;
    const ghost = this.graveyard.get(price);
    rec = {
      price,
      size: 0,
      orderCount: 0,
      firstSeenAt: t,
      lastChangeAt: t,
      lastSeenAt: t,
      peakSize: 0,
      added: 0,
      removed: 0,
      churn: ghost ? ghost.churn : 0,
      // A level that keeps disappearing and coming back is the signature of
      // layering: the quote is re-posted rather than left to be executed.
      vanishCount: ghost ? ghost.vanishCount + 1 : 0,
      lifetimes: ghost ? ghost.lifetimes.slice(-8) : []
    };
    if (ghost) this.graveyard.delete(price);
    this.levels.set(price, rec);
    return rec;
  }

  bury(rec, t) {
    rec.diedAt = t;
    rec.lifetimes.push(t - rec.firstSeenAt);
    this.graveyard.set(rec.price, rec);
    this.levels.delete(rec.price);
  }
}

export class OrderBookState {
  constructor(config = {}) {
    this.config = { ...DEFAULT_BOOK_CONFIG, ...config };
    this.bid = new BookSide("bid", this.config);
    this.ask = new BookSide("ask", this.config);
    this.pendingTrades = [];
    this.aggression = []; // {t, size, side}
    this.midHistory = []; // {t, mid} — lets us ask whether aggression moved price
    this.updates = 0;
    this.lastUpdateAt = null;
    this.firstUpdateAt = null;
  }

  get bestBid() {
    return this.#touch(this.bid, (a, b) => b - a);
  }

  get bestAsk() {
    return this.#touch(this.ask, (a, b) => a - b);
  }

  #touch(side, compare) {
    let best = null;
    for (const rec of side.levels.values()) {
      if (rec.size <= 0) continue;
      if (best == null || compare(rec.price, best) < 0) best = rec.price;
    }
    return best;
  }

  // A size decrease that follows a print at the same price is a fill, not a
  // cancel. Prints are consumed so one trade cannot excuse two decrements.
  #consumeTrade(price, t, maxSize) {
    const { tradeMatchMs } = this.config;
    let consumed = 0;
    for (const trade of this.pendingTrades) {
      if (consumed >= maxSize) break;
      if (trade.price !== price) continue;
      if (t - trade.t > tradeMatchMs) continue;
      const take = Math.min(trade.remaining, maxSize - consumed);
      trade.remaining -= take;
      consumed += take;
    }
    this.pendingTrades = this.pendingTrades.filter(
      (trade) => trade.remaining > 0 && t - trade.t <= tradeMatchMs
    );
    return consumed;
  }

  applyTrade(trade) {
    if (!trade || !trade.size) return;
    const t = trade.timestamp ?? Date.now();
    let aggressor = trade.aggressor;
    if (!aggressor) {
      const bid = this.bestBid;
      const ask = this.bestAsk;
      if (ask != null && trade.price >= ask) aggressor = "buy";
      else if (bid != null && trade.price <= bid) aggressor = "sell";
      else aggressor = "unknown";
    }
    this.pendingTrades.push({ t, price: trade.price, remaining: trade.size });
    this.aggression.push({ t, size: trade.size, side: aggressor });
    const side = aggressor === "buy" ? this.ask : this.bid;
    side.traded.push({ t, size: trade.size, ticks: 0 });
    this.#prune(t);
  }

  applyDepth(frame) {
    const t = frame.timestamp ?? Date.now();
    const incomingBestBid = frame.bids[0]?.price ?? this.bestBid;
    const incomingBestAsk = frame.asks[0]?.price ?? this.bestAsk;
    this.#applySide(this.bid, frame.bids, t, incomingBestBid);
    this.#applySide(this.ask, frame.asks, t, incomingBestAsk);
    this.updates++;
    if (this.firstUpdateAt == null) this.firstUpdateAt = t;
    this.lastUpdateAt = t;
    const bid = this.bestBid;
    const ask = this.bestAsk;
    if (bid != null && ask != null) this.midHistory.push({ t, mid: (bid + ask) / 2 });
    this.#prune(t);
  }

  #applySide(side, levels, t, touch) {
    const { tickSize, churnAlpha } = this.config;
    const seen = new Set();

    for (const level of levels) {
      const rec = side.ensure(level.price, t);
      const isBirth = rec.size === 0 && rec.firstSeenAt === t;
      const delta = level.size - rec.size;
      const ticks = touch == null ? 0 : Math.round(Math.abs(level.price - touch) / tickSize);

      if (delta > 0) {
        rec.added += delta;
        side.added.push({ t, size: delta, ticks });
      } else if (delta < 0) {
        const shrunk = -delta;
        const filled = this.#consumeTrade(level.price, t, shrunk);
        const cancelled = shrunk - filled;
        rec.removed += shrunk;
        if (cancelled > 0) side.cancelled.push({ t, size: cancelled, ticks });
      }

      // Churn decays on every update, not only on changes, so a level that
      // settles down is forgiven. A level's first appearance is not churn --
      // showing up is normal; vanishing and returning is what we penalize.
      const base = Math.max(rec.size, level.size, 1);
      const relative = isBirth ? 0 : Math.abs(delta) / base;
      rec.churn = rec.churn * (1 - churnAlpha) + relative * churnAlpha;
      if (delta !== 0) rec.lastChangeAt = t;

      rec.size = level.size;
      rec.orderCount = level.orderCount;
      rec.peakSize = Math.max(rec.peakSize, level.size);
      rec.lastSeenAt = t;
      seen.add(level.price);
    }

    for (const rec of [...side.levels.values()]) {
      if (seen.has(rec.price)) continue;
      const ticks = touch == null ? 0 : Math.round(Math.abs(rec.price - touch) / tickSize);
      const filled = this.#consumeTrade(rec.price, t, rec.size);
      const cancelled = rec.size - filled;
      rec.removed += rec.size;
      if (cancelled > 0) side.cancelled.push({ t, size: cancelled, ticks });
      side.bury(rec, t);
    }
  }

  #prune(t) {
    const cutoff = t - this.config.windowMs;
    const graveyardCutoff = t - this.config.graveyardMs;
    this.bid.prune(cutoff, graveyardCutoff);
    this.ask.prune(cutoff, graveyardCutoff);
    pruneWindow(this.aggression, cutoff);
    pruneWindow(this.midHistory, cutoff);
  }

  #levelViews(side, touch, now) {
    const { tickSize, flickerVanishFull, flickerChurnFull } = this.config;
    const views = [];
    for (const rec of side.levels.values()) {
      if (rec.size <= 0) continue;
      const restMs = now - rec.firstSeenAt;
      const stableMs = now - rec.lastChangeAt;
      const vanishTerm = clamp(rec.vanishCount / flickerVanishFull, 0, 1);
      const churnTerm = clamp(rec.churn / flickerChurnFull, 0, 1);
      views.push({
        price: rec.price,
        size: rec.size,
        orderCount: rec.orderCount,
        ticksFromTouch: touch == null ? 0 : Math.round(Math.abs(rec.price - touch) / tickSize),
        restMs,
        stableMs,
        peakSize: rec.peakSize,
        vanishCount: rec.vanishCount,
        churn: rec.churn,
        flicker: clamp(0.55 * vanishTerm + 0.45 * churnTerm, 0, 1)
      });
    }
    views.sort((a, b) => a.ticksFromTouch - b.ticksFromTouch);
    return views;
  }

  #sideFlow(side, now) {
    const cutoff = now - this.config.windowMs;
    const near = this.config.nearTouchTicks;
    const cancelled = sumWindow(side.cancelled, (e) => e.t >= cutoff);
    const traded = sumWindow(side.traded, (e) => e.t >= cutoff);
    return {
      added: sumWindow(side.added, (e) => e.t >= cutoff),
      addedNearTouch: sumWindow(side.added, (e) => e.t >= cutoff && e.ticks <= near),
      cancelled,
      traded
    };
  }

  snapshot(now = this.lastUpdateAt ?? Date.now()) {
    const bestBid = this.bestBid;
    const bestAsk = this.bestAsk;
    const { tickSize, absorptionMinVolume } = this.config;

    const bids = this.#levelViews(this.bid, bestBid, now);
    const asks = this.#levelViews(this.ask, bestAsk, now);
    const bidFlow = this.#sideFlow(this.bid, now);
    const askFlow = this.#sideFlow(this.ask, now);

    const cutoff = now - this.config.windowMs;
    let buyVol = 0;
    let sellVol = 0;
    for (const e of this.aggression) {
      if (e.t < cutoff) continue;
      if (e.side === "buy") buyVol += e.size;
      else if (e.side === "sell") sellVol += e.size;
    }

    // Absorption: aggressive selling into a bid that keeps refilling means a
    // real buyer is soaking it up. That is the most trustworthy bullish tell in
    // the book, because it is confirmed by trades rather than by quotes alone.
    const bidAbsorb = absorption(bidFlow.addedNearTouch, sellVol, absorptionMinVolume);
    const askAbsorb = absorption(askFlow.addedNearTouch, buyVol, absorptionMinVolume);

    return {
      timestamp: now,
      updates: this.updates,
      elapsedMs: this.firstUpdateAt == null ? 0 : now - this.firstUpdateAt,
      stalenessMs: this.lastUpdateAt == null ? Infinity : now - this.lastUpdateAt,
      bestBid,
      bestAsk,
      mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
      spreadTicks:
        bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) / tickSize) : null,
      bids,
      asks,
      flow: {
        bid: bidFlow,
        ask: askFlow,
        // Sarao cancelled ~99% of what he sent. Measured per instrument rather
        // than per side, because layering on one side is funded by quoting that
        // never trades anywhere.
        cancelToTrade: cancelToTrade(bidFlow.cancelled + askFlow.cancelled, buyVol + sellVol)
      },
      volume: { buy: buyVol, sell: sellVol, total: buyVol + sellVol },
      absorption: { bid: bidAbsorb, ask: askAbsorb, net: bidAbsorb - askAbsorb },
      midChangeTicks: this.#midChangeTicks()
    };
  }

  #midChangeTicks() {
    if (this.midHistory.length < 2) return 0;
    const first = this.midHistory[0].mid;
    const last = this.midHistory[this.midHistory.length - 1].mid;
    return (last - first) / this.config.tickSize;
  }
}

function cancelToTrade(cancelled, traded) {
  if (traded > 0) return cancelled / traded;
  return cancelled > 0 ? Infinity : 0;
}

function absorption(replenishedSize, aggressiveVolume, minVolume) {
  if (aggressiveVolume <= 0) return 0;
  const ratio = clamp(replenishedSize / aggressiveVolume, 0, 2) / 2;
  const gate = clamp(aggressiveVolume / minVolume, 0, 1);
  return ratio * gate;
}
