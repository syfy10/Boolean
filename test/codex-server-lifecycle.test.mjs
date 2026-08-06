import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  clearCodexThreadMapping,
  codexHistoryDisposition,
  codexOrchestrationSnapshot,
  interruptOrphanedPendingTask
} from "../src/server.js";

test("orphaned live tasks become resumable instead of displaying Working forever", () => {
  const thread = { updatedAt: 1, abort: null, pendingTask: { state: "running", updatedAt: 1000, controller: { phase: "executing", taskRun: { state: "running", sequence: 2, events: [] }, compaction: { state: "running" } } } };
  assert.equal(interruptOrphanedPendingTask(thread, { now: 20000, graceMs: 15000 }), true);
  assert.equal(thread.pendingTask.state, "interrupted");
  assert.equal(thread.pendingTask.controller.phase, "paused");
  assert.equal(thread.pendingTask.controller.taskRun.state, "paused");
  assert.equal(thread.pendingTask.controller.taskRun.events.at(-1).type, "run.paused");
  assert.equal(thread.pendingTask.controller.compaction.state, "paused");
});

test("active and freshly-started tasks are never interrupted by reconciliation", () => {
  const active = { abort: new AbortController(), pendingTask: { state: "running", updatedAt: 1 } };
  const fresh = { abort: null, pendingTask: { state: "running", updatedAt: 19000 } };
  assert.equal(interruptOrphanedPendingTask(active, { now: 20000 }), false);
  assert.equal(interruptOrphanedPendingTask(fresh, { now: 20000 }), false);
});

test("an interrupted outer task repairs a nested timeline still claiming to run", () => {
  const thread = { abort: null, pendingTask: { state: "interrupted", updatedAt: 1000, controller: { phase: "executing", taskRun: { state: "running", events: [] } } } };
  assert.equal(interruptOrphanedPendingTask(thread, { now: 2000 }), true);
  assert.equal(thread.pendingTask.state, "interrupted");
  assert.equal(thread.pendingTask.controller.taskRun.state, "paused");
  assert.equal(thread.pendingTask.controller.taskRun.events.at(-1).title, "Task interrupted");
});

test("Boollm history rewinds detach stale Codex thread state", () => {
  const thread = {
    codex: { threadId: "codex-thread", turnId: "old-turn" },
    codexActive: { threadId: "codex-thread", turnId: "active-turn" },
    orchestration: { thread: { id: "codex-thread" }, turn: { id: "old-turn" } },
    pendingTask: {
      orchestration: { thread: { id: "codex-thread" }, turn: { id: "old-turn" } }
    }
  };

  assert.deepEqual(clearCodexThreadMapping(thread), ["codex-thread"]);
  assert.equal(Object.hasOwn(thread, "codex"), false);
  assert.equal(Object.hasOwn(thread, "codexActive"), false);
  assert.equal(thread.orchestration, null);
  assert.equal(thread.pendingTask.orchestration, null);
});

test("history deletion reports separately retained Codex history", () => {
  const result = codexHistoryDisposition(["one", "two", "one"], ["one"]);
  assert.equal(result.linkedThreads, 2);
  assert.equal(result.archivedThreads, 1);
  assert.equal(result.retainedExternally, true);
  assert.match(result.notice, /Codex manages its task history separately/i);

  const localOnly = codexHistoryDisposition();
  assert.equal(localOnly.retainedExternally, false);
  assert.match(localOnly.notice, /No linked Codex task history/i);
});

test("Codex activity snapshots expose terminal turn state", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: String(index) }));
  const completed = codexOrchestrationSnapshot({
    threadId: "thread-1",
    turnId: "turn-1",
    items,
    status: "completed"
  });
  assert.equal(completed.thread.status, "completed");
  assert.equal(completed.turn.status, "completed");
  assert.deepEqual(completed.turn.items.map((item) => item.id), ["2", "3", "4", "5", "6", "7", "8", "9"]);

  const active = codexOrchestrationSnapshot({ status: "unexpected" });
  assert.equal(active.turn.status, "in_progress");
});

test("server routes reset mappings, use one interrupt path, and disclose external history", () => {
  const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const retry = source.slice(source.indexOf('p === "/api/retry"'), source.indexOf('p === "/api/thread/rewind"'));
  const rewind = source.slice(source.indexOf('p === "/api/thread/rewind"'), source.indexOf('p === "/api/compare/retry"'));
  const rollback = source.slice(source.indexOf("function rollbackLastUserTurn"), source.indexOf("function openNdjsonStream"));
  const stop = source.slice(source.indexOf('p === "/api/stop"'), source.indexOf('p === "/api/retry"'));
  const deletion = source.slice(source.indexOf('p === "/api/thread/delete"'), source.indexOf('p === "/api/config"'));

  assert.match(retry, /clearCodexThreadMapping\(t\)/);
  assert.match(rewind, /clearCodexThreadMapping\(t\)/);
  assert.match(rollback, /clearCodexThreadMapping\(t\)/);
  assert.match(stop, /t\.abort\.abort\(\)/);
  assert.doesNotMatch(stop, /turnInterrupt/);
  assert.match(deletion, /archiveLinkedCodexThreads/);
  assert.match(deletion, /codexHistory/);
  assert.match(source, /emitActivity\(\{ method: `turn\/\$\{codexTurnStatus\}` \}, codexTurnStatus\)/);
});
