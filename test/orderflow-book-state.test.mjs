import test from "node:test";
import assert from "node:assert/strict";

import { OrderBookState } from "../orderflow/src/book-state.js";
import { normalizeDepthFrame } from "../orderflow/src/depth-normalize.js";

function frame(t, bids, asks) {
  return normalizeDepthFrame(
    {
      Bids: bids.map(([Price, TotalSize]) => ({ Price: String(Price), TotalSize: String(TotalSize) })),
      Asks: asks.map(([Price, TotalSize]) => ({ Price: String(Price), TotalSize: String(TotalSize) }))
    },
    { timestamp: t }
  );
}

test("normalizes string prices and sorts each side from the touch", () => {
  const f = frame(0, [[99.75, 10], [100.0, 20]], [[100.5, 5], [100.25, 8]]);
  assert.equal(f.bids[0].price, 100.0);
  assert.equal(f.asks[0].price, 100.25);
  assert.equal(f.bids[0].size, 20);
});

test("resting size accumulates rest time while it stays put", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  for (let t = 0; t <= 2000; t += 100) {
    book.applyDepth(frame(t, [[100.0, 50]], [[100.25, 50]]));
  }
  const level = book.snapshot(2000).bids[0];
  assert.equal(level.restMs, 2000);
  assert.ok(level.flicker < 0.05, `a level that never changed should not look fake (${level.flicker})`);
});

test("a level that vanishes and returns is counted as flickering", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  for (let cycle = 0; cycle < 3; cycle++) {
    const base = cycle * 400;
    book.applyDepth(frame(base, [[100.0, 50], [99.75, 300]], [[100.25, 50]]));
    book.applyDepth(frame(base + 200, [[100.0, 50]], [[100.25, 50]]));
  }
  book.applyDepth(frame(1200, [[100.0, 50], [99.75, 300]], [[100.25, 50]]));

  const snapshot = book.snapshot(1200);
  const revived = snapshot.bids.find((l) => l.price === 99.75);
  assert.equal(revived.vanishCount, 3);
  assert.ok(revived.flicker > 0.5, `repeated disappearance should score as flicker (${revived.flicker})`);
});

test("size that leaves against a print is a fill, not a cancellation", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  book.applyDepth(frame(0, [[100.0, 50]], [[100.25, 50]]));
  book.applyTrade({ price: 100.0, size: 10, timestamp: 100, aggressor: "sell" });
  book.applyDepth(frame(100, [[100.0, 40]], [[100.25, 50]]));

  const flow = book.snapshot(100).flow;
  assert.equal(flow.bid.cancelled, 0);
  assert.equal(flow.bid.traded, 10);
});

test("size that leaves with no print is a cancellation", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  book.applyDepth(frame(0, [[100.0, 50]], [[100.25, 50]]));
  book.applyDepth(frame(100, [[100.0, 20]], [[100.25, 50]]));

  const flow = book.snapshot(100).flow;
  assert.equal(flow.bid.cancelled, 30);
  assert.equal(flow.bid.traded, 0);
});

test("one print cannot excuse two separate decrements", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  book.applyDepth(frame(0, [[100.0, 50]], [[100.25, 50]]));
  book.applyTrade({ price: 100.0, size: 10, timestamp: 100, aggressor: "sell" });
  book.applyDepth(frame(100, [[100.0, 40]], [[100.25, 50]]));
  book.applyDepth(frame(200, [[100.0, 30]], [[100.25, 50]]));

  const flow = book.snapshot(200).flow;
  assert.equal(flow.bid.traded, 10);
  assert.equal(flow.bid.cancelled, 10);
});

test("cancel-to-trade is measured per instrument and survives a tradeless book", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  book.applyDepth(frame(0, [[100.0, 500]], [[100.25, 50]]));
  book.applyDepth(frame(100, [[100.0, 100]], [[100.25, 50]]));
  assert.equal(book.snapshot(100).flow.cancelToTrade, Infinity);

  book.applyTrade({ price: 100.0, size: 20, timestamp: 200, aggressor: "sell" });
  book.applyDepth(frame(200, [[100.0, 80]], [[100.25, 50]]));
  assert.equal(book.snapshot(200).flow.cancelToTrade, 400 / 20);
});

test("aggressor side is inferred from the touch when the feed does not label it", () => {
  const book = new OrderBookState({ tickSize: 0.25 });
  book.applyDepth(frame(0, [[100.0, 50]], [[100.25, 50]]));
  book.applyTrade({ price: 100.25, size: 7, timestamp: 100 });
  book.applyTrade({ price: 100.0, size: 4, timestamp: 100 });

  const volume = book.snapshot(100).volume;
  assert.equal(volume.buy, 7);
  assert.equal(volume.sell, 4);
});

test("flow statistics only cover the rolling window", () => {
  const book = new OrderBookState({ tickSize: 0.25, windowMs: 1000 });
  book.applyDepth(frame(0, [[100.0, 500]], [[100.25, 50]]));
  book.applyDepth(frame(100, [[100.0, 100]], [[100.25, 50]]));
  assert.equal(book.snapshot(100).flow.bid.cancelled, 400);

  for (let t = 1200; t <= 2000; t += 100) {
    book.applyDepth(frame(t, [[100.0, 100]], [[100.25, 50]]));
  }
  assert.equal(book.snapshot(2000).flow.bid.cancelled, 0);
});
