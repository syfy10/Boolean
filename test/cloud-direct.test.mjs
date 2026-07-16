import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { runTurn, systemPrompt } from "../src/agent.js";
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
