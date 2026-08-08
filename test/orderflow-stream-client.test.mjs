import test from "node:test";
import assert from "node:assert/strict";

import { createStream, depthStreamUrl, quoteStreamUrl } from "../orderflow/src/tradestation-client.js";
import { createReconnectGovernor } from "../orderflow/src/reconnect-governor.js";
import { FrameKind } from "../orderflow/src/stream-events.js";
import { createTradeExtractor } from "../orderflow/src/depth-normalize.js";

// A fake chunked response: each entry is one chunk, split wherever we like, so
// the parser has to cope with objects spanning chunk boundaries the way proxies
// force it to in production.
function streamResponse(chunks, { ok = true, status = 200, body = "" } = {}) {
  if (!ok) return { ok, status, text: async () => body };
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
          },
          async cancel() {
            i = chunks.length;
          }
        };
      }
    }
  };
}

function harness(responses, options = {}) {
  const logs = [];
  const events = [];
  const sleeps = [];
  let attempt = 0;
  let clock = 0;

  const stream = createStream({
    url: "https://sim-api.tradestation.com/v3/marketdata/stream/marketdepth/aggregates/ESU26",
    label: "depth",
    tokenProvider: options.tokenProvider || (async () => "token-123"),
    governor: options.governor || createReconnectGovernor({ random: () => 0.5 }),
    onLog: (entry) => logs.push(entry),
    onEvent: (event) => events.push(event),
    onRaw: options.onRaw,
    deps: {
      now: () => clock,
      // Stopping happens between connections, never mid-body, so a response is
      // always fully consumed before the harness intervenes.
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (attempt >= (options.maxAttempts || responses.length) || sleeps.length > 12) {
          stream.stop();
        }
      },
      fetchImpl: async (url, init) => {
        const response = responses[Math.min(attempt, responses.length - 1)];
        attempt++;
        if (options.onFetch) options.onFetch(url, init, attempt);
        return typeof response === "function" ? response() : response;
      }
    }
  });

  return { stream, logs, events, sleeps, get attempts() { return attempt; } };
}

test("depth frames reach the consumer and the bearer token is sent", async () => {
  let auth = null;
  let accept = null;
  const h = harness(
    [streamResponse(['{"Bids":[{"Price":"5000.00","TotalSize":"40"}],', '"Asks":[{"Price":"5000.25","TotalSize":"38"}]}'])],
    {
      onFetch: (_url, init) => {
        auth = init.headers.Authorization;
        accept = init.headers.Accept;
      }
    }
  );

  await h.stream.start();
  assert.equal(auth, "Bearer token-123");
  assert.match(accept, /tradestation\.streams/);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, FrameKind.DEPTH);
  assert.equal(h.events[0].frame.Bids[0].Price, "5000.00");
});

test("heartbeats and status frames are logged, not delivered as data", async () => {
  const h = harness([
    streamResponse([
      '{"StreamStatus":"EndSnapshot"}',
      '{"Heartbeat":1,"Timestamp":"t"}',
      '{"Bids":[],"Asks":[{"Price":"1","TotalSize":"2"}]}'
    ])
  ]);
  await h.stream.start();
  assert.equal(h.events.length, 1, "only the depth frame is data");
  assert.ok(h.logs.some((l) => /EndSnapshot/.test(l.text)));
  assert.ok(h.logs.some((l) => /Heartbeat/.test(l.text)));
});

test("a GoAway reconnects without escalating the backoff ladder", async () => {
  const h = harness(
    [
      streamResponse(['{"Bids":[],"Asks":[]}', '{"StreamStatus":"GoAway"}']),
      streamResponse(['{"Bids":[],"Asks":[]}'])
    ],
    { maxAttempts: 2 }
  );
  await h.stream.start();
  assert.ok(h.attempts >= 2, "it should have reconnected");
  assert.ok(h.sleeps.every((ms) => ms <= 1000), `GoAway must not trigger exponential backoff (${h.sleeps})`);
});

test("a non-retryable error stops the client instead of hammering the quota", async () => {
  const h = harness([streamResponse(['{"Symbol":"ESU26","Error":"DualLogon"}'])], { maxAttempts: 99 });
  await h.stream.start();
  assert.equal(h.stream.stopped, true);
  assert.equal(h.attempts, 1, "it must not retry a DualLogon");
  assert.ok(h.logs.some((l) => /will not resolve by retrying/.test(l.text)));
});

test("a 429 backs off rather than retrying immediately", async () => {
  const h = harness(
    [
      streamResponse([], { ok: false, status: 429, body: "Too Many Requests" }),
      streamResponse([], { ok: false, status: 429, body: "Too Many Requests" }),
      streamResponse(['{"Bids":[],"Asks":[]}'])
    ],
    { maxAttempts: 3 }
  );
  await h.stream.start();
  assert.ok(h.logs.some((l) => /429.*rate limited/.test(l.text)));
  assert.ok(h.sleeps.length >= 2);
  assert.ok(h.sleeps[1] > h.sleeps[0], `backoff should grow (${h.sleeps})`);
});

test("the depth quota is respected across repeated reconnects", async () => {
  const governor = createReconnectGovernor({ maxPerWindow: 30, maxConcurrent: 10, random: () => 0.5 });
  const h = harness([streamResponse(['{"Bids":[],"Asks":[]}'])], { governor, maxAttempts: 99 });
  await h.stream.start();
  // 30/minute with a 5-attempt reserve leaves 25; the client must never exceed it.
  assert.ok(governor.stats.attemptsInWindow <= 25, `used ${governor.stats.attemptsInWindow} of a 25 budget`);
});

test("an auth failure backs off instead of spinning", async () => {
  let calls = 0;
  const h = harness([streamResponse(['{"Bids":[],"Asks":[]}'])], {
    maxAttempts: 99,
    tokenProvider: async () => {
      calls++;
      throw new Error("no tokens stored");
    }
  });
  await h.stream.start();
  assert.ok(h.logs.some((l) => /auth failed.*no tokens stored/.test(l.text)));
  assert.ok(h.sleeps.length > 0, "it must sleep between auth attempts");
  assert.ok(calls > 1);
});

test("raw chunks are handed to the capture writer verbatim", async () => {
  const raw = [];
  const chunks = ['{"Bids":[{"Price":"1",', '"TotalSize":"2"}],"Asks":[]}'];
  const h = harness([streamResponse(chunks)], { onRaw: (text) => raw.push(text) });
  await h.stream.start();
  assert.deepEqual(raw, chunks, "capture must record the bytes as received, not reserialized");
});

test("stream URLs point at the configured environment", () => {
  const config = { api: "https://sim-api.tradestation.com/v3" };
  assert.equal(
    depthStreamUrl(config, "ESU26", 20),
    "https://sim-api.tradestation.com/v3/marketdata/stream/marketdepth/aggregates/ESU26?maxlevels=20"
  );
  assert.equal(
    quoteStreamUrl(config, "@ES"),
    "https://sim-api.tradestation.com/v3/marketdata/stream/quotes/%40ES"
  );
});

test("repeated quote frames become discrete prints, not one per tick", () => {
  const extract = createTradeExtractor();
  assert.equal(extract({ Last: "5000.25", Volume: "1000" }, 0), null, "first frame only sets the baseline");
  const first = extract({ Last: "5000.25", Volume: "1005" }, 100);
  assert.equal(first.size, 5);
  assert.equal(first.price, 5000.25);
  assert.equal(extract({ Last: "5000.25", Volume: "1005" }, 200), null, "an unchanged quote is not a new print");
  assert.equal(extract({ Last: "5000.50", Volume: "1012" }, 300).size, 7);
});

test("prints are still recovered when the feed omits cumulative volume", () => {
  const extract = createTradeExtractor();
  const a = extract({ Last: "10.00", LastSize: "3", TradeTime: "T1" }, 0);
  assert.equal(a.size, 3);
  assert.equal(extract({ Last: "10.00", LastSize: "3", TradeTime: "T1" }, 50), null);
  assert.equal(extract({ Last: "10.25", LastSize: "2", TradeTime: "T2" }, 100).size, 2);
});
