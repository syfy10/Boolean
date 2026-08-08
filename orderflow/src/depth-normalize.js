// Maps TradeStation depth frames onto a stable internal shape.
//
// The exact casing/spelling of the depth fields is pinned in Phase 2 by logging
// raw frames off the sim endpoint. Until then we accept the plausible variants
// so the pipeline below never has to care which one we get.

function num(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(obj, names) {
  for (const name of names) {
    if (obj[name] != null) return obj[name];
  }
  return null;
}

const PRICE_KEYS = ["Price", "price"];
const SIZE_KEYS = ["TotalSize", "Size", "totalSize", "size", "Quantity", "quantity"];
const COUNT_KEYS = ["OrderCount", "TotalOrderCount", "orderCount", "Orders", "orders"];
const BIGGEST_KEYS = ["BiggestSize", "biggestSize"];
const SMALLEST_KEYS = ["SmallestSize", "smallestSize"];
const BIG_ORDER_KEYS = ["BigOrders", "bigOrders"];
const SMALL_ORDER_KEYS = ["SmallOrders", "smallOrders"];

function normalizeLevel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const price = num(pick(raw, PRICE_KEYS));
  const size = num(pick(raw, SIZE_KEYS));
  if (price == null || size == null) return null;
  return {
    price,
    size: Math.max(0, size),
    orderCount: num(pick(raw, COUNT_KEYS)) ?? 0,
    biggestSize: num(pick(raw, BIGGEST_KEYS)) ?? 0,
    smallestSize: num(pick(raw, SMALLEST_KEYS)) ?? 0,
    bigOrders: num(pick(raw, BIG_ORDER_KEYS)) ?? 0,
    smallOrders: num(pick(raw, SMALL_ORDER_KEYS)) ?? 0
  };
}

function normalizeSide(rawSide, { descending }) {
  if (!Array.isArray(rawSide)) return [];
  const levels = rawSide.map(normalizeLevel).filter((l) => l && l.size > 0);
  levels.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
  return levels;
}

export function normalizeDepthFrame(frame, options = {}) {
  const timestamp = options.timestamp ?? parseTimestamp(frame) ?? Date.now();
  return {
    timestamp,
    symbol: frame?.Symbol || frame?.symbol || options.symbol || null,
    // Bids descend from the touch, asks ascend, so index 0 is always the touch.
    bids: normalizeSide(frame?.Bids ?? frame?.bids, { descending: true }),
    asks: normalizeSide(frame?.Asks ?? frame?.asks, { descending: false })
  };
}

function parseTimestamp(frame) {
  const raw = frame?.TimeStamp ?? frame?.Timestamp ?? frame?.timestamp;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// Quote frames repeat the same last-trade fields on every tick, so they have to
// be de-duplicated into discrete prints. Cumulative volume is the reliable
// signal; TradeTime is the fallback when the feed omits volume.
export function createTradeExtractor() {
  let lastVolume = null;
  let lastKey = null;

  return function extract(frame, timestamp) {
    const price = num(pick(frame ?? {}, ["Last", "last", "Close", "close"]));
    if (price == null) return null;

    const volume = num(pick(frame, ["Volume", "volume", "TotalVolume", "totalVolume"]));
    const lastSize = num(pick(frame, ["LastSize", "lastSize"]));
    const tradeTime = pick(frame, ["TradeTime", "tradeTime", "LastTradeTime"]);

    if (volume != null) {
      const previous = lastVolume;
      lastVolume = volume;
      if (previous != null && volume > previous) {
        return { price, size: volume - previous, timestamp, aggressor: null };
      }
      if (previous != null) return null;
    }

    if (tradeTime && lastSize) {
      const key = `${tradeTime}|${price}|${lastSize}`;
      if (key !== lastKey) {
        lastKey = key;
        return { price, size: lastSize, timestamp, aggressor: null };
      }
    }
    return null;
  };
}

export function normalizeTrade(frame, options = {}) {
  const price = num(pick(frame ?? {}, ["Last", "Price", "last", "price"]));
  const size = num(pick(frame ?? {}, ["LastSize", "Size", "lastSize", "size", "Volume"]));
  if (price == null || !size) return null;
  return {
    timestamp: options.timestamp ?? parseTimestamp(frame) ?? Date.now(),
    price,
    size,
    aggressor: options.aggressor ?? null
  };
}
