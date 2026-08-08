// Synthetic order-flow scenarios, emitted in raw TradeStation frame shape so
// the replay harness exercises normalization too.
//
// These exist so the signal engine can be tested deterministically. Watching a
// live book cannot tell you whether the spoof filter works, because you never
// learn which walls were real. Here we know, because we built them.

const TICK = 0.25;

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const px = (value) => Math.round(value * 100) / 100;

function rows(map, ascending) {
  return [...map.entries()]
    .filter(([, size]) => size > 0)
    .sort((a, b) => (ascending ? a[0] - b[0] : b[0] - a[0]))
    .map(([price, size]) => ({
      Price: price.toFixed(2),
      TotalSize: String(Math.round(size)),
      OrderCount: String(Math.max(1, Math.round(size / 25)))
    }));
}

function depthEvent(t, bidMap, askMap) {
  return {
    t,
    type: "depth",
    payload: { Symbol: "ESU26", Bids: rows(bidMap, false), Asks: rows(askMap, true) }
  };
}

function tradeEvent(t, price, size, aggressor) {
  return { t, type: "trade", payload: { price: px(price), size, aggressor } };
}

function ladder(touch, direction, sizes) {
  const map = new Map();
  sizes.forEach((size, i) => map.set(px(touch + direction * i * TICK), size));
  return map;
}

// A quiet two-sided market: no edge, and the engine should say so.
export function balanced({ steps = 250, dt = 100, seed = 7 } = {}) {
  const random = mulberry32(seed);
  const bestBid = 5000.0;
  const bestAsk = 5000.25;
  const events = [];

  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    if (s % 3 === 0) {
      const buy = s % 6 === 0;
      events.push(tradeEvent(t, buy ? bestAsk : bestBid, 5, buy ? "buy" : "sell"));
    }
    const jitter = () => Math.round(random() * 6) - 3;
    const bids = ladder(bestBid, -1, [40 + jitter(), 40 + jitter(), 38, 36, 34, 32, 30, 30, 28, 28]);
    const asks = ladder(bestAsk, 1, [40 + jitter(), 40 + jitter(), 38, 36, 34, 32, 30, 30, 28, 28]);
    events.push(depthEvent(t, bids, asks));
  }

  return {
    name: "balanced",
    description: "Symmetric book, mixed two-way trade. Expect no signal.",
    tickSize: TICK,
    expect: "neutral",
    events
  };
}

// A real offer: large, posted once, left alone, and it holds when hit.
export function genuineSellWall({ steps = 250, dt = 100 } = {}) {
  const bestBid = 5000.0;
  const bestAsk = 5000.25;
  const wallPrice = px(bestAsk + 2 * TICK);
  const events = [];
  let askTouchSize = 40;

  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    if (s % 2 === 0) {
      events.push(tradeEvent(t, bestAsk, 5, "buy"));
      askTouchSize = Math.max(0, askTouchSize - 5);
    } else {
      askTouchSize = 40; // refilled by the same seller, not a new one
    }

    const bids = ladder(bestBid, -1, [40, 38, 36, 34, 32, 30, 30, 28, 28, 26]);
    const asks = new Map();
    asks.set(bestAsk, askTouchSize);
    asks.set(px(bestAsk + TICK), 38);
    asks.set(wallPrice, 800); // never moves, never pulled
    asks.set(px(bestAsk + 3 * TICK), 34);
    asks.set(px(bestAsk + 4 * TICK), 32);
    events.push(depthEvent(t, bids, asks));
  }

  return {
    name: "genuineSellWall",
    description: "Persistent 800-lot offer two ticks up, absorbing buyers. Expect a sell signal.",
    tickSize: TICK,
    expect: "sell",
    events
  };
}

// Sarao's dynamic layering, reconstructed: several large offers held 3-7 ticks
// above the touch, re-priced in lockstep so they never get hit, and pulled
// entirely whenever price approaches. Naive depth reads this as heavy supply.
export function dynamicLayering({ steps = 300, dt = 100 } = {}) {
  const bestBid = 5000.0;
  const bestAsk = 5000.25;
  const events = [];
  let offset = 3; // ticks above the touch where the block starts
  let pulled = false;

  for (let s = 0; s < steps; s++) {
    const t = s * dt;

    // Re-price the whole block every 400ms so it tracks price without trading.
    if (s % 4 === 0) offset = offset === 3 ? 4 : 3;
    // Periodically yank it outright, the way a layerer does on approach.
    pulled = s % 12 === 11;

    if (s % 5 === 0) {
      const buy = s % 10 === 0;
      events.push(tradeEvent(t, buy ? bestAsk : bestBid, 3, buy ? "buy" : "sell"));
    }

    const bids = ladder(bestBid, -1, [40, 38, 36, 34, 32, 30, 30, 28, 28, 26]);
    const asks = new Map();
    asks.set(bestAsk, 40);
    asks.set(px(bestAsk + TICK), 38);
    asks.set(px(bestAsk + 2 * TICK), 36);
    if (!pulled) {
      for (let i = 0; i < 5; i++) {
        asks.set(px(bestAsk + (offset + i) * TICK), 400);
      }
    }
    events.push(depthEvent(t, bids, asks));
  }

  return {
    name: "dynamicLayering",
    description:
      "Five 400-lot offers held 3-4 ticks away, re-priced constantly and pulled on approach. Naive depth says heavily bearish; it is a spoof.",
    tickSize: TICK,
    expect: "neutral",
    events
  };
}

// Aggressive sellers hitting a bid that keeps refilling while price holds.
export function bidAbsorption({ steps = 250, dt = 100 } = {}) {
  const bestBid = 5000.0;
  const bestAsk = 5000.25;
  const events = [];
  let bidTouchSize = 100;

  for (let s = 0; s < steps; s++) {
    const t = s * dt;
    if (s % 2 === 0) {
      events.push(tradeEvent(t, bestBid, 12, "sell"));
      bidTouchSize = Math.max(0, bidTouchSize - 12);
    } else {
      bidTouchSize = 100;
    }

    const bids = new Map();
    bids.set(bestBid, bidTouchSize);
    [95, 90, 85, 80, 75, 70, 65, 60, 55].forEach((size, i) => {
      bids.set(px(bestBid - (i + 1) * TICK), size);
    });
    const asks = ladder(bestAsk, 1, [30, 30, 28, 28, 26, 26, 24, 24, 22, 22]);
    events.push(depthEvent(t, bids, asks));
  }

  return {
    name: "bidAbsorption",
    description: "Heavy selling absorbed by a bid that refills and holds. Expect a buy signal.",
    tickSize: TICK,
    expect: "buy",
    events
  };
}

export const SCENARIOS = { balanced, genuineSellWall, dynamicLayering, bidAbsorption };
