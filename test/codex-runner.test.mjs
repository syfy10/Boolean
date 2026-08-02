import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexBootstrap, CodexRunner, runCodexTurn, verifyCodexFileChanges } from "../src/codex-runner.js";

class FakeCodexClient extends EventEmitter {
  constructor({ threadId = "thr_new", turnId = "turn_1", onTurn } = {}) {
    super();
    this.threadId = threadId;
    this.turnId = turnId;
    this.onTurn = onTurn;
    this.startCalls = 0;
    this.threadStarts = [];
    this.threadResumes = [];
    this.turnStarts = [];
    this.interrupts = [];
    this.status = { state: "stopped", ready: false };
  }

  async start() {
    this.startCalls++;
    this.status = { state: "ready", ready: true };
    return { userAgent: "codex-test" };
  }

  async stop() { this.status = { state: "stopped", ready: false }; }

  async threadStart(options) {
    this.threadStarts.push(options);
    return { thread: { id: this.threadId } };
  }

  async threadResume(threadId, options) {
    this.threadResumes.push({ threadId, options });
    return { thread: { id: threadId } };
  }

  async turnStart(threadId, input, options) {
    this.turnStarts.push({ threadId, input, options });
    setImmediate(() => this.onTurn?.(this));
    return { turn: { id: this.turnId, status: "inProgress", items: [] } };
  }

  async turnInterrupt(threadId, turnId) {
    this.interrupts.push({ threadId, turnId });
    setImmediate(() => this.notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted", items: [], error: null }
    }));
    return {};
  }

  notify(method, params = {}) { this.emit("event", { method, params }); }

  request(method, params, id = `${method}-request`) {
    return new Promise((resolve, reject) => {
      this.emit("serverRequest", { id, method, params }, resolve, reject);
    });
  }
}

function successfulTurn(client) {
  const ids = { threadId: client.threadId, turnId: client.turnId };
  client.notify("turn/started", { ...ids, turn: { id: client.turnId, status: "inProgress" } });
  client.notify("turn/plan/updated", {
    ...ids,
    explanation: "Keep the change focused.",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "inProgress" }
    ]
  });
  client.notify("item/started", {
    ...ids,
    item: { id: "cmd_1", type: "commandExecution", command: "node --version", cwd: "C:/work", status: "inProgress" }
  });
  client.notify("item/completed", {
    ...ids,
    item: { id: "cmd_1", type: "commandExecution", command: "node --version", cwd: "C:/work", status: "completed", aggregatedOutput: "v24", exitCode: 0 }
  });
  client.notify("item/started", {
    ...ids,
    item: { id: "msg_1", type: "agentMessage", phase: "final_answer", text: "" }
  });
  client.notify("item/agentMessage/delta", { ...ids, itemId: "msg_1", delta: "Done" });
  client.notify("item/completed", {
    ...ids,
    item: { id: "msg_1", type: "agentMessage", phase: "final_answer", text: "Done." }
  });
  client.notify("thread/tokenUsage/updated", {
    ...ids,
    tokenUsage: { last: { inputTokens: 40, cachedInputTokens: 5, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 49 } }
  });
  client.notify("turn/completed", {
    ...ids,
    turn: { id: client.turnId, status: "completed", items: [], error: null }
  });
}

test("new Boolean chats lazily start Codex, bootstrap bounded history, and stream mapped lifecycle events", async () => {
  const client = new FakeCodexClient({ onTurn: successfulTurn });
  const statuses = [];
  const tokens = [];
  const plans = [];
  const steps = [];
  const usage = [];
  const mappings = [];
  const result = await runCodexTurn({
    client,
    messages: [
      { role: "system", content: "Do not include this Boolean-only system rule." },
      { role: "user", content: "We were fixing the parser." },
      { role: "assistant", content: "I found the failing branch." },
      { role: "user", content: "Finish it and run the test." }
    ],
    model: "gpt-test",
    projectDir: "C:/work",
    workspaceChanges: [{ status: "modified", path: "src/parser.js", absolutePath: "C:/work/src/parser.js", diff: "@@ -1 +1 @@\n-old\n+new" }],
    networkAccess: true,
    onStatus: (value) => statuses.push(value),
    onToken: (value) => tokens.push(value),
    onPlan: (value) => plans.push(value),
    onStep: (value) => steps.push(value),
    onUsage: (value) => usage.push(value),
    onMapping: (value) => mappings.push({ ...value })
  });
  assert.equal(client.startCalls, 1);
  assert.equal(client.threadStarts.length, 1);
  assert.equal(client.threadResumes.length, 0);
  assert.equal(client.threadStarts[0].approvalPolicy, "on-request");
  assert.equal(client.threadStarts[0].sandbox, "workspace-write");
  assert.equal(client.turnStarts[0].options.approvalPolicy, "on-request");
  assert.equal(client.turnStarts[0].options.sandboxPolicy.type, "workspaceWrite");
  assert.equal(client.turnStarts[0].options.sandboxPolicy.networkAccess, true);
  assert.match(client.turnStarts[0].input[0].text, /We were fixing the parser/);
  assert.match(client.turnStarts[0].input[0].text, /Current request:\nFinish it and run the test/);
  assert.match(client.turnStarts[0].input[0].text, /Boolean Changes panel before this turn/);
  assert.match(client.turnStarts[0].input[0].text, /C:\/work\/src\/parser\.js/);
  assert.match(client.turnStarts[0].input[0].text, /\+new/);
  assert.doesNotMatch(client.turnStarts[0].input[0].text, /Boolean-only system rule/);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Done.");
  assert.equal(result.threadId, "thr_new");
  assert.equal(result.turnId, "turn_1");
  assert.equal(tokens.join(""), "Done.");
  assert.equal(plans[0][1].step, "Patch");
  assert.equal(steps[0].name, "run_command");
  assert.equal(steps[0].result, "v24");
  assert.deepEqual(usage[0], {
    provider: "codex",
    model: "gpt-test",
    input: 40,
    output: 9,
    cachedInput: 5,
    reasoningOutput: 2,
    estimated: false
  });
  assert.equal(mappings[0].threadId, "thr_new");
  assert.equal(mappings.at(-1).status, "completed");
  assert.ok(statuses.includes("Codex finished the task."));
});

test("a completed Codex edit is counted only after Boolean verifies its exact path and diff on disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-edit-"));
  try {
    const filename = "codex-edit-test.txt";
    const absolute = path.join(root, filename);
    const diff = "--- /dev/null\n+++ b/codex-edit-test.txt\n@@ -0,0 +1 @@\n+verified content\n";
    const client = new FakeCodexClient({
      onTurn(instance) {
        fs.writeFileSync(absolute, "verified content\n");
        const ids = { threadId: instance.threadId, turnId: instance.turnId };
        instance.notify("item/completed", {
          ...ids,
          item: { id: "file_1", type: "fileChange", status: "completed", changes: [{ path: filename, kind: { type: "add" }, diff }] }
        });
        instance.notify("turn/diff/updated", { ...ids, diff });
        instance.notify("turn/completed", { ...ids, turn: { id: instance.turnId, status: "completed", items: [], error: null } });
      }
    });
    const steps = [];
    await runCodexTurn({ client, input: `Create ${filename}`, projectDir: root, onStep: (step) => steps.push(step) });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, "apply_patch");
    assert.equal(steps[0].verified, true);
    assert.equal(steps[0].args.changes.length, 1);
    assert.equal(steps[0].args.changes[0].path, filename);
    assert.equal(path.resolve(steps[0].args.changes[0].absolutePath), path.resolve(absolute));
    assert.equal(steps[0].args.changes[0].readable, true);
    assert.equal(steps[0].args.changes[0].diff, diff);
    assert.equal(fs.readFileSync(absolute, "utf8"), "verified content\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed or unverifiable Codex edits never produce a Changed file step", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-failed-edit-"));
  try {
    const failed = verifyCodexFileChanges(root, [{
      type: "fileChange",
      status: "failed",
      changes: [{ path: "codex-edit-test.txt", kind: { type: "add" }, diff: "+missing" }]
    }]);
    assert.deepEqual(failed.changes, []);
    assert.match(failed.issues.join(" "), /did not count it/);
    const missing = verifyCodexFileChanges(root, [{
      type: "fileChange",
      status: "completed",
      changes: [{ path: "codex-edit-test.txt", kind: { type: "add" }, diff: "+missing" }]
    }]);
    assert.deepEqual(missing.changes, []);
    assert.match(missing.issues.join(" "), /could not verify/);
    fs.writeFileSync(path.join(root, "codex-edit-test.txt"), "old content\n");
    const unwritten = verifyCodexFileChanges(root, [{
      type: "fileChange",
      status: "completed",
      changes: [{ path: "codex-edit-test.txt", kind: { type: "update" }, diff: "+expected content" }]
    }]);
    assert.deepEqual(unwritten.changes, []);
    assert.match(unwritten.issues.join(" "), /reported content was not written/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex deletion is verified only when the exact file is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-delete-"));
  try {
    const filename = "codex-edit-test.txt";
    const absolute = path.join(root, filename);
    fs.writeFileSync(absolute, "remove me\n");
    fs.rmSync(absolute);
    const result = verifyCodexFileChanges(root, [{
      type: "fileChange",
      status: "completed",
      changes: [{ path: filename, kind: { type: "delete" }, diff: "-remove me" }]
    }]);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].status, "deleted");
    assert.equal(result.changes[0].exists, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex thread modes use kebab-case while turn sandbox policies stay structured", async () => {
  for (const [inputType, threadType, turnType] of [
    ["readOnly", "read-only", "readOnly"],
    ["workspace-write", "workspace-write", "workspaceWrite"],
    ["dangerFullAccess", "danger-full-access", "dangerFullAccess"]
  ]) {
    const client = new FakeCodexClient({ onTurn: successfulTurn });
    await runCodexTurn({
      client,
      input: "Check the project.",
      sandboxPolicy: inputType === "readOnly"
        ? { type: inputType, access: { type: "fullAccess" } }
        : { type: inputType },
      onStatus: () => {}
    });
    assert.equal(client.threadStarts[0].sandbox, threadType);
    assert.equal(client.turnStarts[0].options.sandboxPolicy.type, turnType);
  }
});

test("turn completion uses the final agent-message fallback when deltas were missed", async () => {
  const client = new FakeCodexClient({
    onTurn(instance) {
      instance.notify("turn/completed", {
        threadId: instance.threadId,
        turnId: instance.turnId,
        turn: {
          id: instance.turnId,
          status: "completed",
          items: [{ id: "final_1", type: "agentMessage", text: "Recovered final answer." }],
          error: null
        }
      });
    }
  });
  const tokens = [];
  const result = await new CodexRunner({ client }).runCodexTurn({
    input: "Finish the task",
    onToken: (token) => tokens.push(token)
  });
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Recovered final answer.");
  assert.equal(tokens.join(""), "Recovered final answer.");
});

test("resumed Codex threads receive only the latest user input and failed completion is authoritative", async () => {
  const client = new FakeCodexClient({
    threadId: "unused",
    turnId: "turn_failed",
    onTurn(instance) {
      const ids = { threadId: "thr_saved", turnId: instance.turnId };
      instance.notify("item/started", { ...ids, item: { id: "comment_1", type: "agentMessage", phase: "commentary", text: "" } });
      instance.notify("item/agentMessage/delta", { ...ids, itemId: "comment_1", delta: "Checking the failing test" });
      instance.notify("item/completed", { ...ids, item: { id: "comment_1", type: "agentMessage", phase: "commentary", text: "Checking the failing test" } });
      instance.notify("error", { ...ids, error: { message: "Sandbox setup failed" } });
      instance.notify("turn/completed", {
        ...ids,
        turn: { id: instance.turnId, status: "failed", error: { message: "Sandbox setup failed" } }
      });
    }
  });
  const tokens = [];
  const result = await new CodexRunner({ client }).runCodexTurn({
    mapping: { threadId: "thr_saved" },
    messages: [
      { role: "user", content: "Old request" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "Try the test again" }
    ],
    onToken: (value) => tokens.push(value)
  });
  assert.equal(client.threadStarts.length, 0);
  assert.equal(client.threadResumes[0].threadId, "thr_saved");
  assert.equal(client.turnStarts[0].input[0].text, "Try the test again");
  assert.equal(tokens.length, 0, "commentary must not be rendered as the final answer");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Sandbox setup failed");
});

test("command and file approvals plus requestUserInput are routed through async callbacks", async () => {
  const responses = [];
  const client = new FakeCodexClient({
    threadId: "thr_approve",
    turnId: "turn_approve",
    async onTurn(instance) {
      const ids = { threadId: instance.threadId, turnId: instance.turnId };
      responses.push(await instance.request("item/commandExecution/requestApproval", {
        ...ids,
        itemId: "cmd_1",
        reason: "Run the test",
        command: "npm test"
      }, "approval_1"));
      responses.push(await instance.request("item/fileChange/requestApproval", {
        ...ids,
        itemId: "file_1",
        reason: "Apply the patch"
      }, "approval_2"));
      responses.push(await instance.request("item/tool/requestUserInput", {
        ...ids,
        questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
        isBlocking: true,
        autoResolutionMs: null
      }, "input_1"));
      instance.notify("turn/completed", {
        ...ids,
        turn: { id: instance.turnId, status: "completed", items: [], error: null }
      });
    }
  });
  const approvalKinds = [];
  const result = await new CodexRunner({ client }).runCodexTurn({
    input: "Make the requested change",
    onApproval: async ({ kind }) => {
      approvalKinds.push(kind);
      return kind === "command" ? { approved: true, session: true } : false;
    },
    onUserInput: async ({ questions }) => ({ [questions[0].id]: "Current project" })
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(approvalKinds, ["command", "file"]);
  assert.deepEqual(responses, [
    { decision: "acceptForSession" },
    { decision: "decline" },
    { answers: { scope: { answers: ["Current project"] } } }
  ]);
});

test("server-resolved requests clear Boolean prompts without sending a stale response", async () => {
  let releaseApproval;
  const resolved = [];
  const client = new FakeCodexClient({
    threadId: "thr_resolved",
    turnId: "turn_resolved",
    onTurn(instance) {
      void instance.request("item/commandExecution/requestApproval", {
        threadId: instance.threadId,
        turnId: instance.turnId,
        itemId: "cmd_resolved",
        command: "node --version"
      }, "approval_resolved");
      setImmediate(() => {
        instance.notify("serverRequest/resolved", { requestId: "approval_resolved" });
        instance.notify("turn/completed", {
          threadId: instance.threadId,
          turnId: instance.turnId,
          turn: { id: instance.turnId, status: "completed", items: [], error: null }
        });
      });
    }
  });
  const result = await new CodexRunner({ client }).runCodexTurn({
    input: "Check Node",
    onApproval: () => new Promise((resolve) => { releaseApproval = resolve; }),
    onRequestResolved: (event) => {
      resolved.push(event);
      releaseApproval?.("cancel");
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].requestId, "approval_resolved");
  assert.equal(resolved[0].method, "item/commandExecution/requestApproval");
});

test("AbortSignal interrupts the exact active Codex turn and waits for interrupted completion", async () => {
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  const client = new FakeCodexClient({ onTurn: () => started() });
  const controller = new AbortController();
  const promise = new CodexRunner({ client }).runCodexTurn({
    input: "Keep working until stopped",
    signal: controller.signal
  });
  await active;
  controller.abort();
  const result = await promise;
  assert.deepEqual(client.interrupts, [{ threadId: "thr_new", turnId: "turn_1" }]);
  assert.equal(result.status, "interrupted");
});

test("a missing persisted Codex thread recovers once with a bounded bootstrap", async () => {
  const client = new FakeCodexClient({ onTurn: successfulTurn });
  client.threadResume = async function(threadId, options) {
    this.threadResumes.push({ threadId, options });
    throw new Error(`Thread ${threadId} not found`);
  };
  const result = await new CodexRunner({ client }).runCodexTurn({
    mapping: { threadId: "thr_gone" },
    messages: [
      { role: "user", content: "Earlier context" },
      { role: "assistant", content: "Earlier result" },
      { role: "user", content: "Continue now" }
    ]
  });
  assert.equal(client.threadResumes.length, 1);
  assert.equal(client.threadStarts.length, 1);
  assert.match(client.turnStarts[0].input[0].text, /Earlier context/);
  assert.equal(result.threadId, "thr_new");
});

test("bootstrap limits historical context without trimming the current request", () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `history-${index}-${"x".repeat(200)}`
  }));
  history.push({ role: "user", content: "CURRENT REQUEST MUST REMAIN" });
  const text = buildCodexBootstrap(history, "", { maxMessages: 4, maxChars: 1400 });
  assert.ok(text.length <= 1400);
  assert.match(text, /CURRENT REQUEST MUST REMAIN$/);
  assert.doesNotMatch(text, /history-0-/);
});
