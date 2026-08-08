import test from "node:test";
import assert from "node:assert/strict";

import { createReconnectGovernor } from "../orderflow/src/reconnect-governor.js";

test("stops reconnecting before the depth quota is exhausted", () => {
  const gov = createReconnectGovernor({ maxConcurrent: 100, random: () => 0.5 });
  let now = 0;
  // 30/minute with a reserve of 5 leaves 25 usable attempts.
  for (let i = 0; i < 25; i++) {
    assert.equal(gov.canConnect(now).ok, true, `attempt ${i} should be allowed`);
    gov.noteConnect(now);
    gov.noteDisconnect();
    now += 100;
  }
  const blocked = gov.canConnect(now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "quota");
  assert.ok(blocked.waitMs > 0);
});

test("quota frees up once the window rolls past", () => {
  const gov = createReconnectGovernor({ maxConcurrent: 100, random: () => 0.5 });
  for (let i = 0; i < 25; i++) {
    gov.noteConnect(i * 100);
    gov.noteDisconnect();
  }
  assert.equal(gov.canConnect(2500).ok, false);
  assert.equal(gov.canConnect(61_000).ok, true);
});

test("refuses to exceed the concurrent connection cap", () => {
  const gov = createReconnectGovernor({ maxConcurrent: 3, random: () => 0.5 });
  for (let i = 0; i < 3; i++) gov.noteConnect(i);
  const blocked = gov.canConnect(10);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "max-concurrent");

  gov.noteDisconnect();
  assert.equal(gov.canConnect(10).ok, true);
});

test("backoff grows exponentially and is capped", () => {
  const gov = createReconnectGovernor({ random: () => 0.5, baseDelayMs: 1000, maxDelayMs: 30_000 });
  assert.equal(gov.noteFailure(), 1000);
  assert.equal(gov.noteFailure(), 2000);
  assert.equal(gov.noteFailure(), 4000);
  assert.equal(gov.noteFailure(), 8000);
  assert.equal(gov.noteFailure(), 16_000);
  assert.equal(gov.noteFailure(), 30_000);
  assert.equal(gov.noteFailure(), 30_000);
});

test("a success resets the backoff ladder", () => {
  const gov = createReconnectGovernor({ random: () => 0.5 });
  gov.noteFailure();
  gov.noteFailure();
  gov.noteSuccess();
  assert.equal(gov.noteFailure(), 1000);
});

test("jitter stays within the configured band", () => {
  const low = createReconnectGovernor({ random: () => 0, baseDelayMs: 1000, jitter: 0.25 });
  const high = createReconnectGovernor({ random: () => 1, baseDelayMs: 1000, jitter: 0.25 });
  assert.equal(low.noteFailure(), 750);
  assert.equal(high.noteFailure(), 1250);
});
