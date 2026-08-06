import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAutoVerificationVerdict, runTurn, systemPrompt } from "../src/agent.js";
import { resetAutoModelHealth } from "../src/model-router.js";

async function mockServer(handler) {
  const requests = [];
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    calls++;
    const message = await handler(calls);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, port: server.address().port };
}

test("Auto verification accepts only an explicit structured verdict", () => {
  assert.deepEqual(
    parseAutoVerificationVerdict('```json\n{"verified":true,"reason":"Tests and file evidence pass."}\n```'),
    { verified: true, reason: "Tests and file evidence pass." }
  );
  assert.equal(parseAutoVerificationVerdict("Looks good to me.").verified, false);
  assert.equal(parseAutoVerificationVerdict('{"verified":false,"reason":"No test evidence."}').verified, false);
});

test("autopilot does not override one model's completion with a forced handoff", async (t) => {
  resetAutoModelHealth();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-handoff-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");

  // Primary keeps falsely claiming completion without ever editing the file.
  const primary = await mockServer(() => ({ role: "assistant", content: "I've updated app.js as requested." }));
  // Secondary takes over — assert only that it receives the task, then it can bow out.
  const secondary = await mockServer(() => ({ role: "assistant", content: "Confirmed — nothing further to do." }));
  t.after(() => { primary.server.close(); secondary.server.close(); });

  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${primary.port}/v1`, model: "gpt-stall", apiKey: "test" },
    deepseek: { baseUrl: `http://127.0.0.1:${secondary.port}`, model: "deepseek-chat", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: {
      contextMode: "full", learnedMemory: false, autoRouteModels: false,
      codingAgent: { compatibilityMode: "auto", stopLoop: false, autopilot: true, autoHandoff: true }
    },
    connectors: { mcp: [], agents: [] }
  };
  const routes = [];
  const answer = await runTurn({
    config: cfg, projectDir, approve: async () => true,
    onStatus() {}, onStep() {}, onUsage() {}, onCheckpoint() {}, onRoute(d) { routes.push(d); }
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Update app.js so the exported value is 2." }
  ]);

  assert.equal(primary.requests.length, 1);
  assert.equal(secondary.requests.length, 0);
  assert.equal(routes.some((d) => d.model === "deepseek-chat"), false);
  assert.equal(answer, "I've updated app.js as requested.");
});

test("handoff does not fire when autoHandoff is disabled", async (t) => {
  resetAutoModelHealth();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-handoff-off-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");

  const primary = await mockServer(() => ({ role: "assistant", content: "I've updated app.js as requested." }));
  const secondary = await mockServer(() => ({ role: "assistant", content: "Confirmed." }));
  t.after(() => { primary.server.close(); secondary.server.close(); });

  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${primary.port}/v1`, model: "gpt-stall", apiKey: "test" },
    deepseek: { baseUrl: `http://127.0.0.1:${secondary.port}`, model: "deepseek-chat", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: {
      contextMode: "full", learnedMemory: false, autoRouteModels: false,
      codingAgent: { compatibilityMode: "auto", stopLoop: false, autopilot: true, autoHandoff: false }
    },
    connectors: { mcp: [], agents: [] }
  };
  const answer = await runTurn({
    config: cfg, projectDir, approve: async () => true,
    onStatus() {}, onStep() {}, onUsage() {}, onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Update app.js so the exported value is 2." }
  ]);

  assert.equal(secondary.requests.length, 0, "no handoff happens when the setting is off");
  assert.equal(answer, "I've updated app.js as requested.");
});

test("a Boollm budget checkpoint is reported as failed so Auto can escalate", async (t) => {
  resetAutoModelHealth();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-budget-handoff-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");
  const primary = await mockServer(() => ({ role: "assistant", content: "This should not be called." }));
  t.after(() => primary.server.close());
  const cfg = {
    provider: "openai", codingEngine: "auto",
    openai: { baseUrl: `http://127.0.0.1:${primary.port}/v1`, model: "budgeted", apiKey: "test" },
    modelCapabilities: {}, autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, autoRouteModels: false, codingAgent: { budget: "small", autopilot: false } },
    connectors: { mcp: [], agents: [] }
  };
  let orchestration = null;
  const answer = await runTurn({
    config: cfg, projectDir, controllerState: { tokensUsed: 60_000 },
    approve: async () => true, onStatus() {}, onStep() {}, onUsage() {}, onCheckpoint() {},
    onOrchestration(_event, snapshot) { orchestration = snapshot; }
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Finish updating app.js." }
  ]);
  assert.equal(primary.requests.length, 0);
  assert.match(answer, /^\(stopped:/);
  assert.equal(orchestration?.thread?.turns?.at(-1)?.status, "failed");
});
