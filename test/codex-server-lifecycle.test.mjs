import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  clearCodexThreadMapping,
  codexHistoryDisposition,
  codexOrchestrationSnapshot
} from "../src/server.js";

test("Boolean history rewinds detach stale Codex thread state", () => {
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
