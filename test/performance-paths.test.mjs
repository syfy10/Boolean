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

test("coding plans render as persistent, controllable progress checklists", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(html, /function makePlanChecklist\(snapshot,\{live=false\}=\{\}\)/);
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
  assert.match(html, /Boolean stopped a repeated loop\./);
  assert.match(html, /Continue differently/);
  assert.match(server, /function resetLoopRecoveryState\(task\)/);
  assert.match(server, /controller\.nonProgressCount = 0/);
  assert.match(server, /controller\.actionCounts = \{\}/);
  assert.match(server, /Use the evidence already collected/);
  assert.match(server, /resetLoopRecoveryState\(savedTask\)/);
});
