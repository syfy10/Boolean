import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

function post(base, route, body = {}) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-saz": "1" },
    body: JSON.stringify(body)
  });
}

async function readNdjson(response) {
  const text = await response.text();
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("Auto tries the selected API first and escalates only its unverified coding task to Claude", { timeout: 15000 }, async (t) => {
  let modelCalls = 0;
  let claudeCalls = 0;
  const modelServer = http.createServer(async (_req, res) => {
    modelCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "I could not make or verify the requested file change." } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 }
    }));
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(modelServer));

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-subscription-route-"));
  const projectDir = path.join(workspace, "Demo");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const config = defaultConfig();
  config.provider = "openai";
  config.openai = {
    ...config.openai,
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    model: "selected-api-model",
    apiKey: "test-key"
  };
  config.projectsDir = workspace;
  config.accessMode = "full_access";
  config.autoApprove = true;
  config.codingEngine = "auto";
  config.ui = {
    ...config.ui,
    autoSave: false,
    learnedMemory: false,
    modelRouting: {
      ...config.ui.modelRouting,
      allowEscalation: true,
      subscriptionEngines: { explicit: true, codex: false, claudeCode: true, preferred: "claude-code" }
    }
  };

  const app = await startServer(config, {
    port: 0,
    sessionToken: "1",
    claudeStatusReader() {
      return { ready: true, installed: true, signedIn: true, command: "claude", version: "test", account: { email: "test@example.com" }, error: "" };
    },
    async claudeTurnRunner() {
      claudeCalls++;
      return { status: "completed", answer: "Claude completed and verified the project task." };
    }
  });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;
  const adopted = await (await post(base, "/api/project/adopt", { dir: projectDir })).json();
  const response = await post(base, "/api/chat", {
    threadId: adopted.id,
    message: "Fix app.js and verify the change.",
    images: [],
    accessMode: "full_access"
  });
  assert.equal(response.status, 200);
  const events = await readNdjson(response);

  assert.ok(modelCalls >= 1, "the selected API must receive the first attempt");
  assert.equal(claudeCalls, 1, "Claude should run once after Boollm cannot verify the task");
  assert.ok(events.some((event) => event.type === "route" && event.engine === "claude-code" && event.escalated === true));
  assert.ok(events.some((event) => event.type === "answer" && /Claude completed/.test(event.text)));
});
