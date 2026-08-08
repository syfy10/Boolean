import test from "node:test";
import assert from "node:assert/strict";

import { createJsonStreamParser, parseAll } from "../orderflow/src/json-stream.js";
import { classifyFrame, connectionAction, FrameKind } from "../orderflow/src/stream-events.js";

function collect() {
  const values = [];
  const errors = [];
  const parser = createJsonStreamParser({
    onValue: (v) => values.push(v),
    onError: (e) => errors.push(e)
  });
  return { parser, values, errors };
}

test("reassembles a JSON object split across chunk boundaries", () => {
  const { parser, values } = collect();
  parser.write('{"Symbol":"ESU26","Bid');
  parser.write('s":[{"Price":"5000.00","Total');
  parser.write('Size":"40"}]}');
  assert.equal(values.length, 1);
  assert.equal(values[0].Bids[0].TotalSize, "40");
});

test("emits every object when several arrive in one chunk", () => {
  const { parser, values } = collect();
  parser.write('{"Heartbeat":1}{"Heartbeat":2}\n{"Heartbeat":3}');
  assert.deepEqual(values.map((v) => v.Heartbeat), [1, 2, 3]);
});

test("does not split on braces or newlines inside string values", () => {
  const { parser, values } = collect();
  parser.write('{"Error":"bad {payload}\\n line","Symbol":"ES"}');
  assert.equal(values.length, 1);
  assert.equal(values[0].Error, "bad {payload}\n line");
});

test("handles escaped quotes without desyncing", () => {
  const { values } = parseAll('{"a":"he said \\"hi\\""}{"b":2}');
  assert.equal(values.length, 2);
  assert.equal(values[0].a, 'he said "hi"');
  assert.equal(values[1].b, 2);
});

test("a partial trailing object stays buffered rather than being emitted", () => {
  const { parser, values } = collect();
  parser.write('{"Heartbeat":1}{"Heartbeat":');
  assert.equal(values.length, 1);
  assert.ok(parser.pending > 0);
  parser.write("2}");
  assert.equal(values.length, 2);
});

test("an oversized frame resets the parser instead of growing without bound", () => {
  const values = [];
  const errors = [];
  const parser = createJsonStreamParser({
    maxFrameBytes: 64,
    onValue: (v) => values.push(v),
    onError: (e) => errors.push(e)
  });
  parser.write(`{"junk":"${"x".repeat(200)}`);
  assert.equal(errors.length, 1);
  assert.equal(parser.pending, 0);
  parser.write('{"Heartbeat":1}');
  assert.deepEqual(values, [{ Heartbeat: 1 }]);
});

test("classifies the control frames TradeStation sends", () => {
  assert.equal(classifyFrame({ Heartbeat: 1, Timestamp: "x" }).kind, FrameKind.HEARTBEAT);
  assert.equal(classifyFrame({ StreamStatus: "EndSnapshot" }).endOfSnapshot, true);
  assert.equal(classifyFrame({ StreamStatus: "GoAway" }).goAway, true);
  assert.equal(classifyFrame({ Bids: [], Asks: [] }).kind, FrameKind.DEPTH);
  assert.equal(classifyFrame({ Bid: "1", Ask: "2" }).kind, FrameKind.QUOTE);
});

test("GoAway reconnects but a DualLogon error stops the stream", () => {
  assert.equal(connectionAction(classifyFrame({ StreamStatus: "GoAway" })), "reconnect");
  assert.equal(connectionAction(classifyFrame({ Symbol: "ES", Error: "DualLogon" })), "stop");
  assert.equal(connectionAction(classifyFrame({ Symbol: "ES", Error: "Timeout" })), "reconnect");
  assert.equal(connectionAction(classifyFrame({ Heartbeat: 1 })), "continue");
});
