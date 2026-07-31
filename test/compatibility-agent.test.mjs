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

test("compatibility models can patch files and continue through terminal verification", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-patch-agent-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer((call) => {
    if (call === 1) return {
        role: "assistant",
        content: [
          "```boolean_patch",
          JSON.stringify({ edits: [{ path: "app.js", old: "const value = 1;", new: "const value = 2;" }] }),
          "```"
        ].join("\n")
      };
    if (call === 2) return {
      role: "assistant",
      content: '```tool\n{"name":"run_command","arguments":{"command":"node -e \\"console.log(2)\\""}}\n```'
    };
    return { role: "assistant", content: "Applied the patch and verified it with the terminal." };
  });
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

  assert.equal(answer, "Applied the patch and verified it with the terminal.");
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 2;\n");
  assert.ok(mock.calls() >= 3);
  assert.equal(mock.requests[0].tools, undefined);
  assert.match(mock.requests[0].messages[0].content, /BOOLEAN COMPATIBILITY MODE/);
  assert.ok(steps.some((step) => step.name === "boolean_patch"));
  assert.ok(steps.some((step) => step.name === "run_command"));
});

test("compatibility models use the shared loop guard instead of a two-inspection coding limit", async (t) => {
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

  assert.match(answer, /paused to avoid repeating the same checks/i);
  assert.ok(mock.calls() >= 3);
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 1;\n");
  assert.match(mock.requests[0].messages[0].content, /run_command:/);
  assert.match(mock.requests[0].messages[0].content, /write_file:/);
});

test("compatibility models never execute bare or trailing JSON mutations", async (t) => {
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

  assert.match(answer, /I will edit it now/);
  assert.ok(mock.calls() >= 1);
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 1;\n");
});

test("compatibility models recover from rejected bulk patches with grounded edit tools", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-patch-recovery-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const badPatch = [
    "```boolean_patch",
    JSON.stringify({ edits: [{ path: "app.js", old: "missing text", new: "const value = 2;" }] }),
    "```"
  ].join("\n");
  const mock = await mockServer((call) => {
    if (call <= 3) return { role: "assistant", content: badPatch };
    if (call === 4) return {
      role: "assistant",
      content: '```tool\n{"name":"edit_file","arguments":{"path":"app.js","old_string":"const value = 1;","new_string":"const value = 2;"}}\n```'
    };
    if (call === 5) return {
      role: "assistant",
      content: '```tool\n{"name":"run_command","arguments":{"command":"node --check app.js"}}\n```'
    };
    return { role: "assistant", content: "Recovered with a targeted edit and verified the file." };
  });
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

  assert.equal(answer, "Recovered with a targeted edit and verified the file.");
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 2;\n");
  assert.ok(steps.some((step) => step.name === "edit_file"));
  assert.ok(steps.some((step) => step.name === "run_command"));
  assert.match(mock.requests[3].messages.at(-1).content, /PATCH RECOVERY/);
  assert.match(mock.requests[3].messages.at(-1).content, /repository_map/);
});
