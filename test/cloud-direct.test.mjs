import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requiresArtifactAction, runTurn, systemPrompt } from "../src/agent.js";
import { chatCompletion } from "../src/providers.js";

test("Boolean Cloud 401 responses become a sign-in-required error", async (t) => {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "request_error", message: "unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    chatCompletion({
      base: `http://127.0.0.1:${server.address().port}`,
      apiKey: "expired-session",
      model: "test-cloud-model",
      provider: "boolean",
      noStream: true
    }, [{ role: "user", content: "hello" }]),
    (err) => err.code === "cloud_auth_required"
      && err.status === 401
      && err.message === "Your Boolean Cloud session expired. Sign in again to continue."
  );
});

test("transient cloud failures retry without becoming sign-in failures", async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    calls++;
    if (calls < 3) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Recovered cloud response." } }],
      usage: { prompt_tokens: 4, completion_tokens: 3 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await chatCompletion({
    base: `http://127.0.0.1:${server.address().port}`,
    apiKey: "active-session",
    model: "test-cloud-model",
    provider: "boolean",
    noStream: true
  }, [{ role: "user", content: "hello" }]);

  assert.equal(calls, 3);
  assert.equal(result.content, "Recovered cloud response.");
});

test("exhausted cloud retries preserve the selected cloud session", async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    calls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "temporarily_unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    chatCompletion({
      base: `http://127.0.0.1:${server.address().port}`,
      apiKey: "active-session",
      model: "test-cloud-model",
      provider: "boolean",
      noStream: true
    }, [{ role: "user", content: "hello" }]),
    (err) => err.code === "cloud_connection_interrupted"
      && /still active/i.test(err.message)
      && err.code !== "cloud_auth_required"
  );
  assert.equal(calls, 3);
});

test("a dropped local model stream is identified for engine recovery", async (t) => {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    chatCompletion({
      base: `http://127.0.0.1:${server.address().port}`,
      apiKey: "local",
      model: "test-local-model",
      provider: "local"
    }, [{ role: "user", content: "hello" }], undefined, undefined, () => {}),
    (err) => err.code === "local_transport_error" && err.partial === false
  );
});

test("the model receives topic changes without deterministic routing", async (t) => {
  let requestBody = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requestBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "The cloud model handled this question." } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const config = {
    provider: "openai",
    openai: {
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-cloud-model",
      apiKey: "test-key"
    },
    maxToolTurns: 3,
    autoApprove: false,
    projectsDir: "",
    ui: {
      aiBrowser: true,
      contextMode: "balanced",
      referenceChatMemory: true,
      learnedMemory: false
    },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt("", false, config) },
    { role: "user", content: "When is the FIFA World Cup final?" },
    { role: "assistant", content: "The final is on Sunday." },
    { role: "user", content: "stock news" }
  ];
  const steps = [];

  const answer = await runTurn({
    config,
    approve: async () => false,
    onStatus() {},
    onStep(step) { steps.push(step); },
    onUsage() {}
  }, messages);

  assert.equal(answer, "The cloud model handled this question.");
  assert.equal(requestBody.model, "test-cloud-model");
  assert.equal(requestBody.messages.at(-1).content, "stock news");
  assert.ok(Array.isArray(requestBody.tools), "the model should retain access to app tools");
  assert.deepEqual(steps, [], "the app must not force a tool before the model requests one");
  assert.equal(messages.at(-1).content, answer);
});

test("agent tasks continue past the legacy tool-turn limit", async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    calls++;
    const message = calls <= 15
      ? {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${calls}`,
            type: "function",
            function: { name: "notepad_read", arguments: JSON.stringify({ tab: calls }) }
          }]
        }
      : { role: "assistant", content: "Finished after all tool work." };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${port}`, model: "tool-test", apiKey: "test" },
    maxToolTurns: 3,
    autoApprove: false,
    projectsDir: "",
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt("", false, config) },
    { role: "user", content: "Complete this long task." }
  ];
  let checkpoints = 0;
  const answer = await runTurn({
    config,
    approve: async () => false,
    notepad: async (command) => `read ${command}`,
    onStatus() {},
    onStep() {},
    onUsage() {},
    onCheckpoint() { checkpoints++; }
  }, messages);

  assert.equal(answer, "Finished after all tool work.");
  assert.equal(calls, 16, "the old maxToolTurns=3 value must not stop the task");
  assert.equal(checkpoints, 16, "every tool result and final answer should be checkpointed");
});

test("clear artifact requests retry tutorial-only answers with an action nudge", async (t) => {
  let calls = 0;
  let nudgedRequest = null;
  let protocolRequest = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    if (calls === 1) nudgedRequest = body;
    if (calls === 2) protocolRequest = body;
    let message;
    if (calls === 1) {
      message = { role: "assistant", content: "Here are the steps you can follow to make the game yourself." };
    } else if (calls === 2) {
      message = { role: "assistant", content: '```tool\n{"name":"list_dir","arguments":{"path":"."}}\n```' };
    } else {
      message = { role: "assistant", content: "Built and verified the requested game." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-action-test-"));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "tool-test", apiKey: "test" },
    projectsDir,
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(projectsDir, true, config) },
    { role: "user", content: "Make me a random browser game with a start menu and a three-second countdown." }
  ];
  const steps = [];
  const answer = await runTurn({
    config,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step.name); },
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Built and verified the requested game.");
  assert.equal(calls, 3);
  assert.deepEqual(steps, ["create_project", "list_dir"]);
  assert.match(nudgedRequest.messages[0].content, /ACTION REQUIRED/);
  assert.match(nudgedRequest.messages[0].content, /created website project/i);
  assert.equal(nudgedRequest.tool_choice, "required");
  assert.equal(nudgedRequest.tools.length > 0, true);
  assert.equal(protocolRequest.tools, undefined);
  assert.match(protocolRequest.messages[0].content, /TOOL PROTOCOL/);
  assert.doesNotMatch(messages.map((message) => message.content || "").join("\n"), /steps you can follow/);
});

test("artifact action detection excludes advice and follows explicit do-it followups", () => {
  assert.equal(requiresArtifactAction([{ role: "user", content: "Give me ideas for a random game." }]), false);
  assert.equal(requiresArtifactAction([{ role: "user", content: "Build me a random game." }]), true);
  assert.equal(requiresArtifactAction([
    { role: "user", content: "Can you create a browser game with a countdown?" },
    { role: "assistant", content: "Here are instructions." },
    { role: "user", content: "No, do it for me." }
  ]), true);
});
