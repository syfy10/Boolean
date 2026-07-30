import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, systemPrompt } from "../src/agent.js";

async function mockServer(handler) {
  let calls = 0;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    calls++;
    const message = await handler(calls, body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, calls: () => calls, port: server.address().port };
}

function limitedConfig(port) {
  return {
    provider: "zaiCoding",
    zaiCoding: {
      baseUrl: `http://127.0.0.1:${port}/api/coding/paas/v4`,
      model: "GLM-5-Turbo",
      apiKey: "test"
    },
    modelCapabilities: {},
    autoApprove: true,
    ui: {
      contextMode: "full",
      learnedMemory: false,
      codingAgent: { compatibilityMode: "patch", stopLoop: false, autopilot: true }
    },
    connectors: { mcp: [], agents: [] }
  };
}

test("limited models apply only an explicit exact Boolean patch", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-patch-agent-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer((call) => call === 1
    ? {
        role: "assistant",
        content: [
          "```boolean_patch",
          JSON.stringify({ edits: [{ path: "app.js", old: "const value = 1;", new: "const value = 2;" }] }),
          "```"
        ].join("\n")
      }
    : { role: "assistant", content: "Applied one exact patch. Tests were not run." });
  t.after(() => mock.server.close());
  const cfg = limitedConfig(mock.port);
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Change app.js so value is 2." }
  ];
  const steps = [];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step); },
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Applied one exact patch. Tests were not run.");
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 2;\n");
  assert.equal(mock.calls(), 2);
  assert.equal(mock.requests[0].tools, undefined);
  assert.match(mock.requests[0].messages[0].content, /BOOLEAN PATCH MODE/);
  assert.ok(steps.some((step) => step.name === "boolean_patch"));
});

test("limited models stop after two inspections and zero file changes", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-patch-loop-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer(() => ({
    role: "assistant",
    content: '```tool\n{"name":"read_file","arguments":{"path":"app.js"}}\n```'
  }));
  t.after(() => mock.server.close());
  const cfg = limitedConfig(mock.port);
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Change app.js so value is 2." }
  ];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus() {},
    onStep() {},
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.match(answer, /stopped after two inspection steps with 0 file changes/i);
  assert.equal(mock.calls(), 3);
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 1;\n");
  assert.doesNotMatch(mock.requests[0].messages[0].content, /run_command:/);
  assert.doesNotMatch(mock.requests[0].messages[0].content, /write_file:/);
});

test("limited models never translate bare or trailing JSON mutations", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-patch-prose-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer(() => ({
    role: "assistant",
    content: 'I will edit it now. {"name":"write_file","arguments":{"path":"app.js","content":"unsafe"}}'
  }));
  t.after(() => mock.server.close());
  const cfg = limitedConfig(mock.port);
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Change app.js." }
  ];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus() {},
    onStep() {},
    onUsage() {},
    onCheckpoint() {}
  }, messages);

  assert.match(answer, /did not return one exact fenced boolean_patch block/i);
  assert.equal(mock.calls(), 1);
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 1;\n");
});
