import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBoundedWorkers, runSubagent, runTurn, systemPrompt, teamworkAssignments } from "../src/agent.js";

function teamConfig(port, mode = "team") {
  return {
    provider: "zaiCoding",
    zaiCoding: {
      baseUrl: `http://127.0.0.1:${port}/api/coding/paas/v4`,
      model: "GLM-5.1",
      apiKey: "zai-key"
    },
    openai: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "gpt-5-mini",
      apiKey: "openai-key"
    },
    google: {
      baseUrl: `http://127.0.0.1:${port}/v1beta/openai`,
      model: "gemini-2.5-flash",
      apiKey: "google-key"
    },
    autoApprove: true,
    ui: {
      contextMode: "full",
      codingAgent: {
        autopilot: true,
        teamwork: { mode, workerProvider: "auto", maxWorkers: 3, useLowCost: true, taskBudget: 0.5 }
      }
    },
    connectors: { mcp: [], agents: [] }
  };
}

test("teamwork assigns inexpensive connected models while keeping the selected lead", () => {
  const assignments = teamworkAssignments(teamConfig(1));
  assert.deepEqual(assignments.map((item) => item.role), ["Mapper", "Test analyst", "Reviewer"]);
  assert.equal(assignments[0].provider, "openai");
  assert.equal(assignments[0].model, "gpt-5-mini");
  assert.equal(assignments[1].provider, "google");
  assert.equal(assignments[2].provider, "zaiCoding");
  assert.equal(teamworkAssignments(teamConfig(1, "solo")).length, 0);
  assert.equal(teamworkAssignments(teamConfig(1, "assist")).length, 1);
});

test("assist runs a specialist first and passes its report to the lead", async (t) => {
  const requests = [];
  let leadCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const text = (body.messages || []).map((message) => String(message.content || "")).join("\n");
    const content = /supporting a lead coding agent/i.test(text)
      ? "Reviewer report: app.js and app.test.js are the relevant files."
      : ++leadCalls === 1
        ? '```tool\n{"name":"write_file","arguments":{"path":"app.js","content":"export const value = 2;\\n"}}\n```'
        : leadCalls === 2
          ? '```tool\n{"name":"run_command","arguments":{"command":"node --check app.js"}}\n```'
          : "Lead integrated the reviewer report and completed the task.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-team-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");
  const cfg = teamConfig(server.address().port, "assist");
  const steps = [];
  const controllers = [];
  const usageEvents = [];
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Fix app.js and verify it." }
  ];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step); },
    onController(controller) { controllers.push(controller); },
    onUsage(usage) { usageEvents.push(usage); },
    onCheckpoint() {}
  }, messages);

  assert.equal(answer, "Lead integrated the reviewer report and completed the task.");
  assert.ok(requests.length >= 2);
  assert.ok(requests.some((body) => (body.messages || []).some((message) => /BOOLLM TEAM HANDOFF/.test(String(message.content || "")))));
  assert.deepEqual(steps.filter((step) => step.name === "team_worker").map((step) => step.args.state), ["queued", "working", "done"]);
  assert.equal(controllers.at(-1)?.teamWorkers?.Reviewer?.state, "done");
  assert.equal(controllers.at(-1)?.teamWorkers?.Reviewer?.workspace, projectDir);
  assert.equal(controllers.at(-1)?.teamWorkers?.Reviewer?.maxTurns, 6);
  assert.ok(controllers.at(-1)?.teamWorkers?.Reviewer?.lastProgressAt > 0);
  assert.ok(controllers.at(-1)?.taskRun?.events?.some((event) => event.type === "team.worker.done"));
  assert.equal(usageEvents.find((usage) => usage.teamWorker)?.role, "Reviewer");
  assert.equal(usageEvents.find((usage) => usage.teamWorker)?.attempt, 1);
  assert.ok(usageEvents.some((usage) => !usage.teamWorker));
});

test("team retries one failed specialist on a different connected provider", async (t) => {
  let leadCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const text = (body.messages || []).map((message) => String(message.content || "")).join("\n");
    if (/Mapper supporting a lead coding agent/i.test(text) && req.url.startsWith("/v1/")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad worker key" } }));
      return;
    }
    const content = /supporting a lead coding agent/i.test(text)
      ? "Fallback specialist report."
      : ++leadCalls === 1
        ? '```tool\n{"name":"write_file","arguments":{"path":"app.js","content":"export const value = 2;\\n"}}\n```'
        : leadCalls === 2
          ? '```tool\n{"name":"run_command","arguments":{"command":"node --check app.js"}}\n```'
          : "Lead completed the task.";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-team-fallback-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "export const value = 1;\n");
  const steps = [];
  const answer = await runTurn({
    config: teamConfig(server.address().port, "team"), projectDir,
    approve: async () => true, onStatus() {}, onUsage() {}, onCheckpoint() {},
    onStep(step) { steps.push(step); }
  }, [
    { role: "system", content: systemPrompt(projectDir, true, teamConfig(server.address().port, "team")) },
    { role: "user", content: "Fix app.js and verify it." }
  ]);
  assert.equal(answer, "Lead completed the task.");
  const mapper = steps.filter((step) => step.name === "team_worker" && step.args.role === "Mapper");
  assert.deepEqual(mapper.map((step) => step.args.state), ["queued", "working", "retrying", "done"]);
  assert.equal(mapper[2].args.provider, "google");
  assert.equal(mapper[2].args.attempt, 2);
});

test("specialists stay in the active project and cannot overwrite the lead controller", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Scoped specialist report." } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-team-active-"));
  const wrongDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-team-wrong-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wrongDir, { recursive: true, force: true }));
  const cfg = teamConfig(server.address().port, "solo");
  cfg.projectsDir = wrongDir;
  let parentControllerWrites = 0;
  const answer = await runSubagent({
    config: cfg,
    projectDir,
    onController() { parentControllerWrites++; },
    onStatus() {},
    onUsage() {}
  }, "Review the active project and report only.", { provider: "openai", role: "Reviewer" });
  assert.equal(answer, "Scoped specialist report.");
  assert.equal(parentControllerWrites, 0);
  const agentSource = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(agentSource, /options\.workspaceDir \|\| parentCtx\.projectDir \|\| cfg\.projectsDir/);
  assert.match(agentSource, /onController: null/);
});

test("a stalled specialist times out instead of blocking the team forever", async (t) => {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request and intentionally never answer */ }
    t.after(() => { if (!res.writableEnded) res.destroy(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const cfg = teamConfig(server.address().port, "solo");
  const started = Date.now();
  const lifecycle = [];
  await assert.rejects(
    runSubagent(
      { config: cfg, projectDir: os.tmpdir(), onStatus() {}, onUsage() {} },
      "Report only.",
      { provider: "openai", role: "Reviewer", timeoutMs: 140, stallMs: 50, onLifecycle(state) { lifecycle.push(state); } }
    ),
    /timed out/i
  );
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(lifecycle.slice(0, 2), ["working", "stalled"]);
});

test("bounded Team queue never exceeds its worker limit and preserves result order", async () => {
  let active = 0, peak = 0;
  const result = await runBoundedWorkers([1, 2, 3, 4, 5], 2, async (value) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active--;
    return value * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
});

test("teamwork controls are compact, persisted, and shown beside the model selector", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(ui, /id="teamAnchor"[\s\S]*id="teambtn"[\s\S]*id="teammenu"/);
  assert.match(ui, /\.menu#teammenu\{[^}]*position:fixed;[^}]*width:238px;[^}]*max-width:calc\(100vw - 16px\);[^}]*padding:7px;/);
  assert.match(ui, /\.team-modes\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\);/);
  assert.match(ui, /\.team-options\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(72px,\.72fr\);/);
  assert.match(ui, /\.team-mode small\{ display:none; \}/);
  assert.match(ui, /function positionTeamMenu\(\)[\s\S]*?availableWidth=Math\.max\(180,workspaceRect\.width-margin\*2\)[\s\S]*?menu\.style\.left=/);
  assert.match(ui, /data-team-mode="solo"[\s\S]*data-team-mode="assist"[\s\S]*data-team-mode="team"/);
  assert.match(ui, /id="teamWorkerProvider"/);
  assert.match(ui, /id="teamTaskBudget"/);
  assert.match(ui, /teamwork:\{mode:\["solo","assist","team"\]/);
  assert.match(ui, /team_worker:\(entry\?\.args\?\.state==="done"/);
  assert.match(ui, /function updateTeamWorker\(entry\)/);
  assert.match(ui, /function workingToolActivitySubject\(entry\)/);
  assert.match(ui, /if\(group==="agents"\) return count===1\?"Asked another model for help":"Asked other models for help"/);
  assert.match(ui, /run\?\.statusEl\?\.classList\.remove\("team-active"\)/);
  assert.doesNotMatch(ui, /class="team-run-progress"/);
  assert.match(ui, /Stopping safely/);
  assert.match(ui, /run\.controller\?\.teamWorkers/);
  assert.match(ui, /Team model usage/);
  assert.match(ui, /team-usage-row/);
  const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /name: step\.name, args: step\.args \|\| \{\}/);
  assert.match(serverSource, /runUsageByWorker/);
  assert.match(serverSource, /breakdown/);
  const liveRunner = serverSource.slice(serverSource.indexOf("async function streamRun"));
  assert.match(liveRunner, /let runIn = 0, runOut = 0, runEst = false, runCalls = 0, teamUsageSeen = false;\s*const runUsageByWorker = new Map\(\);/);
  assert.ok(liveRunner.indexOf("const runUsageByWorker = new Map();") < liveRunner.indexOf("runUsageByWorker.get(usageKey)"));
  assert.doesNotMatch(ui, /â|Ã|Â|ð/);
  assert.match(ui, /id="teambtn"[^>]*>Solo <span class="chev">&#9660;<\/span>/);
});

// Specialists used to spawn from the classification alone, so a question Boollm
// misread as a build burned three worker calls and left worker chips in the UI
// before the lead had touched anything. The handoff now waits for a real change.
test("specialists do not spawn until the lead actually changes something", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    // The lead answers the question outright and never edits a file.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "The one change I would make is caching the repository map." } }],
      usage: { prompt_tokens: 90, completion_tokens: 20 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-team-idle-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const cfg = teamConfig(server.address().port, "team");
  const steps = [];
  const controllers = [];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    forceNoArtifact: true,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step); },
    onController(controller) { controllers.push(controller); },
    onUsage() {},
    onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "give 1 thing we can change to make this application better" }
  ]);

  assert.match(answer, /caching the repository map/);
  assert.equal(steps.filter((step) => step.name === "team_worker").length, 0, "no specialist may run for a turn that changed nothing");
  assert.ok(
    !requests.some((body) => (body.messages || []).some((message) => /supporting a lead coding agent/i.test(String(message.content || "")))),
    "no worker prompt may reach a model"
  );
  assert.ok(
    !requests.some((body) => (body.messages || []).some((message) => /BOOLLM TEAM HANDOFF/.test(String(message.content || "")))),
    "no team handoff may be injected"
  );
  assert.notEqual(controllers.at(-1)?.showPlan, true, "a turn that ran no tool must not raise a step plan");
});
