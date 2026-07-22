import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyTurnMode, contextBudgetForTarget, contextLimitFromError, controllerStopAnswerFromToolResult, emailCleanupContinuationAction, estimateContext, recentTaskStatusMemory, requiresArtifactAction, requiresConnectorContinuationAction, requiresConnectorToolResult, requiresExplicitActionToolResult, runTurn, systemPrompt, toolDefinitionsForTurnMode } from "../src/agent.js";
import { chatCompletion } from "../src/providers.js";

test("local context overflow reports clamp future prompt budgets to the real engine window", () => {
  const err = new Error('400: {"error":{"message":"request exceeds the available context size (8192 tokens)","n_ctx":8192}}');
  err.body = '{"error":{"code":400,"message":"request (10327 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":10327,"n_ctx":8192}}';
  assert.equal(contextLimitFromError(err), 8192);

  const config = {
    provider: "local",
    local: { ctx: 32768 },
    ui: { contextMode: "balanced" }
  };
  const budget = contextBudgetForTarget(config, { provider: "local", ctx: 8192 }, "balanced");
  assert.ok(budget <= 5570, "8k local engines need a strict budget because tool instructions add prompt overhead");

  const messages = [
    { role: "system", content: "system ".repeat(600) },
    { role: "user", content: "older ".repeat(6000) },
    { role: "assistant", content: "old answer ".repeat(6000) },
    { role: "user", content: "hi" }
  ];
  const estimate = estimateContext(messages, budget, "balanced");
  assert.ok(estimate.sent <= 3800, "local chat history should fit below the 8k engine plus tool overhead");
});

test("numbered status follow-ups preserve the last assistant roadmap", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "tell me where we are with this project on this list" },
    { role: "assistant", content: [
      "Interesting - most of these are already built in ui.html. Here's the real status:",
      "| Roadmap item | Status |",
      "|---|---|",
      "| 1 Settings search bar | Built - line 1193 |",
      "| 2 Setup checklist / onboarding | Built - section 2048 |",
      "| 7 Next-edit suggestions | Built - CSS at 1137, JS at 6629 |",
      "| 8 Three-zone layout | Not started - no left/center/right zone structure found |",
      "| 9 Crash/error telemetry | Not started - only referenced in privacy policy |",
      "7 of 9 are implemented. The two genuinely missing items are the three-zone layout and crash/error telemetry."
    ].join("\n") },
    { role: "user", content: "finish 7-9" }
  ];

  const memory = recentTaskStatusMemory(messages);
  assert.match(memory, /Three-zone layout \| Not started/i);
  assert.match(memory, /Crash\/error telemetry \| Not started/i);
  assert.match(memory, /Next-edit suggestions \| Built/i);
});

test("controller loop stops render as a compact user-facing pause", () => {
  const answer = controllerStopAnswerFromToolResult(
    "blocked: Loop guard: this task already repeated the same kind of inspection several times. Do not inspect again; use the evidence already collected and take a different progress step."
  );
  assert.equal(answer, "Paused to avoid repeating the same checks. Work is saved.");
  assert.doesNotMatch(answer, /controller|loop guard|checkpointed|Do not inspect/i);
});

test("third-party provider 401 responses do not affect Boolean account sign-in", async (t) => {
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
      provider: "glm",
      noStream: true
    }, [{ role: "user", content: "hello" }]),
    (err) => err.status === 401 && err.code !== "cloud_auth_required"
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
    provider: "glm",
    noStream: true
  }, [{ role: "user", content: "hello" }]);

  assert.equal(calls, 3);
  assert.equal(result.content, "Recovered cloud response.");
});

test("cloud fallback is off by default even when another key exists", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    primaryCalls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "temporarily_unavailable" }));
  });
  const fallback = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    fallbackCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Backup should not run." } }] }));
  });
  await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => fallback.listen(0, "127.0.0.1", resolve));
  t.after(() => primary.close());
  t.after(() => fallback.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${primary.address().port}`, model: "primary", apiKey: "primary-key" },
    glm: { baseUrl: `http://127.0.0.1:${fallback.address().port}`, model: "backup", apiKey: "backup-key" },
    cloudFallback: { enabled: false, provider: "glm", model: "" },
    maxToolTurns: 0,
    autoApprove: false,
    projectsDir: "",
    ui: { aiBrowser: false, contextMode: "minimal", referenceChatMemory: false, learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt("", false, config) },
    { role: "user", content: "hello" }
  ];

  await assert.rejects(
    runTurn({ config, approve: async () => false, onStatus() {}, onStep() {}, onUsage() {} }, messages),
    (err) => err?.status === 503
  );
  assert.equal(primaryCalls, 3);
  assert.equal(fallbackCalls, 0);
});

test("enabled cloud fallback tries the selected backup provider after primary outage", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    primaryCalls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "temporarily_unavailable" }));
  });
  const fallback = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    fallbackCalls++;
    const body = JSON.parse(raw);
    assert.equal(body.model, "backup-model");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Backup answered." } }],
      usage: { prompt_tokens: 8, completion_tokens: 2 }
    }));
  });
  await new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => fallback.listen(0, "127.0.0.1", resolve));
  t.after(() => primary.close());
  t.after(() => fallback.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${primary.address().port}`, model: "primary-model", apiKey: "primary-key" },
    glm: { baseUrl: `http://127.0.0.1:${fallback.address().port}`, model: "backup-model", apiKey: "backup-key" },
    cloudFallback: { enabled: true, provider: "glm", model: "" },
    maxToolTurns: 0,
    autoApprove: false,
    projectsDir: "",
    ui: { aiBrowser: false, contextMode: "minimal", referenceChatMemory: false, learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt("", false, config) },
    { role: "user", content: "hello" }
  ];
  const statuses = [];
  const usage = [];

  const answer = await runTurn({
    config,
    approve: async () => false,
    onStatus(status) { statuses.push(status); },
    onStep() {},
    onUsage(item) { usage.push(item); }
  }, messages);

  assert.equal(answer, "Backup answered.");
  assert.equal(primaryCalls, 3);
  assert.equal(fallbackCalls, 1);
  assert.equal(config.provider, "openai", "fallback must not change the user's selected provider");
  assert.ok(statuses.some((status) => /trying backup GLM/i.test(status)));
  assert.equal(usage.at(-1)?.provider, "glm");
  assert.equal(usage.at(-1)?.model, "backup-model");
});

test("exhausted cloud retries preserve the selected provider and API key", async (t) => {
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
      provider: "glm",
      noStream: true
    }, [{ role: "user", content: "hello" }]),
    (err) => err.code === "cloud_provider_error"
      && err.status === 503
      && /temporarily unavailable/i.test(err.message)
      && /API key are unchanged/i.test(err.message)
      && err.code !== "cloud_auth_required"
  );
  assert.equal(calls, 3);
});

test("rate-limit responses keep the useful provider explanation after retries", async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    calls++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Plan quota exhausted for today" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    chatCompletion({
      base: `http://127.0.0.1:${server.address().port}`,
      apiKey: "active-session",
      model: "test-cloud-model",
      provider: "zaiCoding",
      noStream: true
    }, [{ role: "user", content: "hello" }]),
    (err) => err.code === "cloud_provider_error"
      && err.status === 429
      && /Z\.AI rate or usage limit/i.test(err.message)
      && /Plan quota exhausted/i.test(err.message)
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

test("a provider DONE event completes without waiting for the HTTP connection to close", async (t) => {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Ready"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    // Deliberately leave the response open. Some compatible providers keep the
    // transport alive after the protocol-level completion marker.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const completion = chatCompletion({
    base: `http://127.0.0.1:${server.address().port}`,
    apiKey: "active-session",
    model: "test-cloud-model",
    provider: "zaiCoding"
  }, [{ role: "user", content: "hello" }], undefined, undefined, () => {});

  const result = await Promise.race([
    completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not finish after [DONE]")), 500))
  ]);
  assert.equal(result.content, "Ready");
});

test("a provider finish reason completes when DONE is omitted and the connection stays open", async (t) => {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Finished"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n');
    // No [DONE] and no res.end(): this matches providers that finish at the
    // protocol level but keep the transport available for reuse.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const completion = chatCompletion({
    base: `http://127.0.0.1:${server.address().port}`,
    apiKey: "active-session",
    model: "test-cloud-model",
    provider: "zaiCoding"
  }, [{ role: "user", content: "hello" }], undefined, undefined, () => {});

  const result = await Promise.race([
    completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not finish after finish_reason")), 500))
  ]);
  assert.equal(result.content, "Finished");
  assert.deepEqual(result.usage, { input: 4, output: 1, estimated: false });
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
  assert.deepEqual(requestBody.tools.map((tool) => tool.function.name).sort(), ["research_web", "web_search"], "research turns should send only background search tools");
  assert.doesNotMatch(requestBody.messages[0].content, /TOOL DEFINITIONS|Boolean includes local GGUF models|mcp_list_tools/i, "research turns should not carry the full agent controller prompt");
  assert.deepEqual(steps, [], "the app must not force a tool before the model requests one");
  assert.equal(messages.at(-1).content, answer);
});

test("ordinary chat turns send no tools and use a compact prompt", async (t) => {
  let requestBody = null;
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requestBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi. How can I help?" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "chat-test", apiKey: "test" },
    projectsDir: "C:\\Users\\S10\\Documents\\Boolean",
    autoApprove: true,
    ui: { contextMode: "balanced", learnedMemory: false },
    connectors: { mcp: [{ name: "Robinhood", enabled: true }], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(config.projectsDir, true, config) },
    { role: "user", content: "hi" }
  ];

  const answer = await runTurn({
    config,
    approve: async () => false,
    onStatus() {},
    onStep() {},
    onUsage() {}
  }, messages);

  assert.equal(answer, "Hi. How can I help?");
  assert.equal(requestCount, 1, "plain chat should complete in one model call");
  assert.equal(requestBody.tools, undefined, "plain chat should not send tool schemas");
  assert.match(requestBody.messages[0].content, /concise AI workspace/);
  assert.doesNotMatch(requestBody.messages[0].content, /Available tools|mcp_list_tools|create_project|github_workflow/i);
});

test("side chat stays answer-only even when its wording resembles an action", async (t) => {
  let requestBody = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requestBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Side chat works." } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "side-chat-test", apiKey: "test" },
    projectsDir: "C:\\Users\\S10\\Documents\\Boolean",
    autoApprove: true,
    ui: { contextMode: "balanced", learnedMemory: false }
  };
  const messages = [
    { role: "system", content: systemPrompt(config.projectsDir, true, config) },
    { role: "user", content: "Reply with exactly: Side chat works." }
  ];
  const steps = [];
  const answer = await runTurn({
    config,
    forceTurnMode: "chat",
    approve: async () => { throw new Error("side chat must not request approval"); },
    onStatus() {},
    onStep(step) { steps.push(step); },
    onUsage() {}
  }, messages);

  assert.equal(answer, "Side chat works.");
  assert.equal(requestBody.tools, undefined);
  assert.deepEqual(steps, []);
});

test("turn classifier chooses the smallest useful mode", () => {
  assert.equal(classifyTurnMode([{ role: "user", content: "hi" }]), "chat");
  assert.equal(classifyTurnMode([{ role: "user", content: "hi" }], { projectDir: "C:\\repo" }), "chat");
  assert.equal(classifyTurnMode([{ role: "user", content: "stock news today" }]), "research");
  assert.equal(classifyTurnMode([{ role: "user", content: "build me a tic tac toe game" }], { artifactActionRequired: true }), "agent");
  assert.equal(classifyTurnMode([{ role: "user", content: "are you checking it?" }], { connectorActionRequired: true }), "agent");
  assert.equal(toolDefinitionsForTurnMode("chat").length, 0);
  assert.deepEqual(toolDefinitionsForTurnMode("research").map((tool) => tool.function.name).sort(), ["research_web", "web_search"]);
});

test("explicit email cleanup tool requests outrank web-research wording", () => {
  const prompt = [
    "Call email_cleanup_preview for the connected Gmail or Outlook account.",
    "Return the plan id, exact search query, counts, reasons, and representative samples.",
    "This step is read-only. Do not call email_cleanup_trash until I explicitly confirm a batch.",
    "Connected account: syfy10@gmail.com (gmail).",
    "older_than: 5y",
    "limit: 500",
    "protect_attachments: true",
    "protect_labeled: true"
  ].join("\n");

  const mode = classifyTurnMode([{ role: "user", content: prompt }]);
  const names = toolDefinitionsForTurnMode(mode).map((tool) => tool.function.name);
  assert.equal(mode, "agent");
  assert.equal(requiresExplicitActionToolResult([{ role: "user", content: prompt }]), true);
  assert.equal(requiresExplicitActionToolResult([{ role: "user", content: "What does email_cleanup_preview do?" }]), false);
  assert.equal(requiresExplicitActionToolResult([{ role: "user", content: "Do not call email_cleanup_trash yet." }]), false);
  assert.ok(names.includes("email_cleanup_preview"));
  assert.ok(names.includes("email_cleanup_trash"));
});

test("email cleanup confirmations retain the saved plan across every batch", () => {
  const planId = "8acb25eb-c711-41fb-9446-1b6382703659";
  const preview = [
    { role: "system", content: "system" },
    { role: "user", content: "Call email_cleanup_preview for syfy10@gmail.com." },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "preview_1", type: "function", function: { name: "email_cleanup_preview", arguments: "{}" } }]
    },
    {
      role: "tool",
      tool_call_id: "preview_1",
      content: JSON.stringify({ planId, provider: "gmail", account: "syfy10@gmail.com", candidateCount: 490, remainingCount: 490 })
    },
    { role: "assistant", content: "490 messages are candidates to move to Trash. Let me know if you want to proceed with a batch." }
  ];

  const firstConfirmation = [...preview, { role: "user", content: "yes do it" }];
  assert.deepEqual(emailCleanupContinuationAction(firstConfirmation), {
    name: "email_cleanup_trash",
    args: { provider: "gmail", plan_id: planId, batch_size: 250 },
    remaining: 490
  });
  assert.equal(classifyTurnMode(firstConfirmation), "agent");
  assert.equal(requiresExplicitActionToolResult(firstConfirmation), true);

  const secondConfirmation = [
    ...preview,
    { role: "user", content: "yes do it" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "trash_1", type: "function", function: { name: "email_cleanup_trash", arguments: JSON.stringify({ provider: "gmail", plan_id: planId, batch_size: 250 }) } }]
    },
    {
      role: "tool",
      tool_call_id: "trash_1",
      content: JSON.stringify({ planId, runId: "run-1", movedToTrash: 250, remainingCandidates: 240 })
    },
    { role: "assistant", content: "Done. 250 moved to Trash. There are 240 remaining candidates. Say go ahead to run the next batch." },
    { role: "user", content: "go ahead" }
  ];
  assert.deepEqual(emailCleanupContinuationAction(secondConfirmation), {
    name: "email_cleanup_trash",
    args: { provider: "gmail", plan_id: planId, batch_size: 240 },
    remaining: 240
  });
  assert.equal(classifyTurnMode(secondConfirmation), "agent");
  assert.match(systemPrompt("", true), /click the Move to Trash button or type `move next batch to trash`/);

  assert.equal(emailCleanupContinuationAction([
    { role: "system", content: "system" },
    { role: "assistant", content: "Ready when you are." },
    { role: "user", content: "go ahead" }
  ]), null);
  assert.equal(emailCleanupContinuationAction([...preview, { role: "user", content: "no, cancel" }]), null);
});

test("explicit no-change project questions do not require artifact edits", () => {
  const messages = [
    { role: "system", content: systemPrompt("C:\\Users\\S10\\Documents\\Boolean", true, { ui: { learnedMemory: false } }) },
    { role: "user", content: "dont make any changes just tell me about this project" }
  ];

  assert.equal(requiresArtifactAction(messages), false);
  assert.equal(classifyTurnMode(messages, {
    latestText: "dont make any changes just tell me about this project",
    artifactActionRequired: requiresArtifactAction(messages),
    projectDir: "C:\\Users\\S10\\Documents\\Boolean"
  }), "agent", "project overview can still inspect read-only");
});

test("connector progress follow-ups stay in tool mode", () => {
  assert.equal(requiresConnectorContinuationAction([
    { role: "user", content: "are you okay?" }
  ]), false);

  assert.equal(requiresConnectorContinuationAction([
    { role: "user", content: "any other trade idea/" },
    { role: "assistant", content: "Let me check the scanner and strategy feeds separately." },
    { role: "user", content: "are you checking it?" }
  ]), true);

  assert.equal(requiresConnectorContinuationAction([
    { role: "user", content: "are you connected to robinhood and stocksignal?" }
  ]), true);

  assert.equal(requiresConnectorToolResult([
    { role: "user", content: "are you connected to robinhood and stocksignal?" }
  ]), false);

  assert.equal(requiresConnectorToolResult([
    { role: "user", content: "give me all the trade idea available from stocksignal" }
  ]), true);

  assert.equal(requiresConnectorToolResult([
    { role: "user", content: "any other trade idea/" },
    { role: "assistant", content: "Let me check the scanner and strategy feeds separately." },
    { role: "user", content: "are you checking it?" }
  ]), true);
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
    } else if (calls === 3) {
      message = { role: "assistant", content: '```tool\n{"name":"write_file","arguments":{"path":"RandomGame/script.js","content":"console.log(\\"game ready\\");"}}\n```' };
    } else if (calls === 4) {
      message = { role: "assistant", content: '```tool\n{"name":"run_command","arguments":{"command":"node --check RandomGame/script.js"}}\n```' };
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
  assert.equal(calls, 5);
  assert.deepEqual(steps, ["create_project", "list_dir", "write_file", "run_command"]);
  assert.match(nudgedRequest.messages[0].content, /ACTION REQUIRED/);
  assert.match(nudgedRequest.messages[0].content, /created website project/i);
  assert.equal(nudgedRequest.tool_choice, "required");
  assert.equal(nudgedRequest.tools.length > 0, true);
  assert.equal(protocolRequest.tools, undefined);
  assert.match(protocolRequest.messages[0].content, /TOOL PROTOCOL/);
  assert.doesNotMatch(messages.map((message) => message.content || "").join("\n"), /steps you can follow/);
});

test("malformed native tool-call server errors retry without surfacing a 500", async (t) => {
  let calls = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    calls++;
    if (calls <= 3) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "Failed to parse tool call arguments as JSON: json.exception.parse_error.101"
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Recovered in compatibility mode." } }]
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const statuses = [];
  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "tool-test", apiKey: "test" },
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(os.tmpdir(), true, config) },
    { role: "user", content: "Check notepad if needed." }
  ];
  const answer = await runTurn({
    config,
    approve: async () => true,
    onStatus(status) { statuses.push(status); },
    onStep() {},
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Recovered in compatibility mode.");
  assert.equal(calls, 4);
  assert.equal(requests[0].tools.length > 0, true);
  assert.equal(requests[3].tools, undefined);
  assert.match(statuses.join("\n"), /malformed.*compatibility mode/i);
});

test("malformed native tool arguments are never executed as empty arguments", async (t) => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    calls++;
    const message = calls === 1
      ? {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "bad-call",
            type: "function",
            function: { name: "write_file", arguments: '{"path":"demo.js","content":"const broken = "quote";"}' }
          }]
        }
      : { role: "assistant", content: "Retried safely." };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "tool-test", apiKey: "test" },
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(os.tmpdir(), true, config) },
    { role: "user", content: "Tell me what you can do." }
  ];
  const steps = [];
  const answer = await runTurn({
    config,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step); },
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Retried safely.");
  assert.equal(calls, 2);
  assert.deepEqual(steps, []);
});

test("an empty response after tool work continues instead of silently stopping", async (t) => {
  let calls = 0;
  let continuationRequest = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    if (calls === 7) continuationRequest = body;
    const message = calls === 1
      ? {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "list-call",
            type: "function",
            function: { name: "list_dir", arguments: '{"path":"."}' }
          }]
        }
      : calls < 7
        ? { role: "assistant", content: "" }
        : { role: "assistant", content: "Finished and verified the project." };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "tool-test", apiKey: "test" },
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(os.tmpdir(), true, config) },
    { role: "user", content: "Inspect the current workspace." }
  ];
  const statuses = [];
  const steps = [];
  const answer = await runTurn({
    config,
    approve: async () => true,
    onStatus(status) { statuses.push(status); },
    onStep(step) { steps.push(step.name); },
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Finished and verified the project.");
  assert.equal(calls, 7);
  assert.deepEqual(steps, ["list_dir"]);
  assert.match(statuses.join("\n"), /paused before finishing.*continuing/i);
  assert.match(continuationRequest.messages[0].content, /CONTINUE REQUIRED/);
  assert.match(continuationRequest.messages.at(-1).content, /Do not wait for me to press Continue/i);
});

test("unsupported screenshot image content retries automatically as text", async (t) => {
  let calls = 0;
  let retriedBody = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    if (calls === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "1210", message: "messages.content.type is invalid, allowed values: ['text']" } }));
      return;
    }
    retriedBody = body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Finished from the page text." } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const config = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "text-only-test", apiKey: "test" },
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false },
    connectors: { mcp: [], agents: [] }
  };
  const screenshotMessage = {
    role: "user",
    content: [
      { type: "text", text: "Here is the screenshot you captured. Review the visual design, then continue." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]
  };
  const messages = [
    { role: "system", content: systemPrompt(os.tmpdir(), true, config) },
    { role: "user", content: "Review the app." },
    screenshotMessage
  ];
  const statuses = [];
  const answer = await runTurn({
    config,
    approve: async () => true,
    onStatus(status) { statuses.push(status); },
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Finished from the page text.");
  assert.equal(calls, 2);
  assert.match(statuses.join("\n"), /accepts text only.*continuing/i);
  assert.equal(typeof retriedBody.messages.at(-1).content, "string");
  assert.doesNotMatch(JSON.stringify(retriedBody.messages), /image_url/);
  assert.equal(typeof screenshotMessage.content, "string", "synthetic screenshot history should stay compatible on later turns");
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
