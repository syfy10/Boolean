import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { clearProviderModelCache, listProviderModels } from "../src/providers.js";

test("cloud model discovery is local on startup and cached after refresh", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-fast-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  clearProviderModelCache();

  const config = {
    provider: "openai",
    openai: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      model: "selected-model",
      apiKey: "test"
    }
  };

  const startup = await listProviderModels(config, { remote: false });
  assert.equal(requests, 0);
  assert.ok(startup.length > 0);

  const refreshed = await listProviderModels(config);
  assert.equal(requests, 1);
  assert.deepEqual(refreshed.map((item) => item.name), ["gpt-fast-model"]);

  await listProviderModels(config);
  assert.equal(requests, 1, "subsequent menus should reuse the cached model list");
});

test("Google discovery returns every usable generateContent model from the native API", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] }
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  clearProviderModelCache();
  const models = await listProviderModels({
    provider: "google",
    google: { baseUrl: `http://127.0.0.1:${server.address().port}/openai`, model: "gemini-2.5-flash", apiKey: "test-key" }
  }, { strict: true });
  assert.deepEqual(models.map((item) => item.name), ["gemini-2.5-flash", "gemini-3.6-flash"]);
  assert.match(requests[0], /^\/models\?key=test-key&/);
});

test("Z.AI Coding discovery keeps every GLM model returned by the account", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5-turbo", "glm-5.1", "glm-5.2"].map((id) => ({ id })) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  clearProviderModelCache();
  const models = await listProviderModels({
    provider: "zaiCoding",
    zaiCoding: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "glm-5.1", apiKey: "test-key" }
  }, { strict: true });
  assert.equal(models.length, 8);
  assert.ok(models.some((item) => item.name === "glm-5.2"));
  assert.ok(models.some((item) => item.name === "glm-5"));
});

test("strict model discovery reports a rejected key instead of showing fallback models", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  clearProviderModelCache();
  await assert.rejects(() => listProviderModels({
    provider: "glm",
    glm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: "glm-4.6", apiKey: "bad-key" }
  }, { strict: true }), /saved API key was rejected/i);
});

test("UI keeps the fast interaction paths and omits retry controls", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-act="retry"|data-chat-act="retry"|data-a="retry"/);
  assert.match(html, /fetch\("\/api\/status"\)/);
  assert.match(html, /THREAD_PAGE_SIZE=80/);
  assert.match(html, /loadOlderMessages\(\)/);
  assert.match(html, /requestAnimationFrame\(paintPendingStream\)/);
  assert.match(html, /class="stream-caret"/);
  assert.match(html, /run\.liveAI\.classList\.remove\("streaming"\)/);
  assert.match(html, /fetch\("\/api\/model\/warm"/);
  assert.match(server, /"cache-control": "no-cache, no-transform"/);
  assert.match(server, /"x-accel-buffering": "no"/);
  assert.match(server, /res\.socket\?\.setNoDelay\?\.\(true\)/);
  assert.match(server, /res\.flushHeaders\?\.\(\)/);
});

test("coding runs expose activity without forcing the legacy checklist", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(html, /function shouldShowProjectPlan\(snapshot\) \{\s*return false;\s*\}/);
  assert.match(html, /t\.pendingTask\?\.controller/);
  assert.match(html, /data-plan-action="raw"/);
  assert.match(html, /data-plan-action="cancel"/);
  assert.match(html, /data-plan-action="retry"/);
  assert.match(html, /plan-output-hidden/);
  assert.match(html, /planElapsed\(snapshot\)/);
  assert.match(html, /buildPlanProjectHTML\(snapshot\)/);
  assert.match(html, /class="plan-project-block"/);
  assert.doesNotMatch(html, /allDone \? ' collapsed' : ''/);
  assert.match(html, /if\(completedPlan&&planEl\?\.isConnected\)\{ col\.appendChild\(planEl\); scrollDown\(\); \}/);
  assert.match(server, /controller: publicTaskController\(task\.controller\)/);
  assert.match(server, /changedFiles: Array\.isArray\(controller\.changedFiles\)/);
  assert.match(server, /checks: Array\.isArray\(controller\.checks\)/);
  assert.match(server, /recentActions: Array\.isArray\(controller\.recentActions\)/);
  assert.doesNotMatch(html, /function buildDetailedPlanHTML\(snapshot\)/);
  assert.doesNotMatch(html, /Commit changes \(optional\)/);
  assert.doesNotMatch(html, /class="plan-progress-block"/);
});

test("loop pauses ask before restarting and clear only exhausted loop counters", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(html, /Boollm stopped a repeated loop\./);
  assert.match(html, /Use saved evidence/);
  assert.match(html, /Create one patch/);
  assert.match(server, /function resetLoopRecoveryState\(task\)/);
  assert.match(server, /controller\.nonProgressCount = 0/);
  assert.match(server, /controller\.actionCounts = \{\}/);
  assert.match(server, /Use the evidence already collected/);
  assert.match(server, /resetLoopRecoveryState\(savedTask\)/);
});
