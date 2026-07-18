import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-platform-"));
const state = path.join(root, "state");
process.env.BOOLEAN_PLATFORM_HOME = state;
const { executePlatformTool, nextRunFor, runDueAutomations, setAutomationActionHandler } = await import(`../src/platform.js?test=${Date.now()}`);

const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
const approvals = [];
const ctx = {
  projectDir: project,
  config: { projectsDir: project },
  approve: async (message) => { approvals.push(message); return true; }
};

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("creates structurally valid document artifacts", async () => {
  const cases = [
    ["docx", "PK", "Hello\nWorld"],
    ["xlsx", "PK", "Name\tValue\nBoolean\t1"],
    ["pptx", "PK", "First slide\n---\nSecond slide"],
    ["pdf", "%PDF-", "A verified PDF"]
  ];
  for (const [type, signature, content] of cases) {
    const output = path.join(project, `sample.${type}`);
    const result = await executePlatformTool("create_artifact", { type, path: output, title: "Boolean", content }, ctx);
    assert.match(result, /Created and verified/);
    assert.equal(fs.readFileSync(output).subarray(0, signature.length).toString(), signature);
  }
});

test("XLSX columns beyond Z produce correct AA, AB references", async () => {
  // 30 columns → last column should be AD, not [
  const headers = Array.from({ length: 30 }, (_, i) => `C${i + 1}`).join("\t");
  const output = path.join(project, "wide.xlsx");
  const result = await executePlatformTool("create_artifact", { type: "xlsx", path: output, title: "Wide", content: headers }, ctx);
  assert.match(result, /Created and verified/);
  const xml = fs.readFileSync(output, "latin1");
  // Column 27 (index 26) → AA, Column 30 (index 29) → AD
  assert.match(xml, /r="AA1"/);
  assert.match(xml, /r="AD1"/);
  // No invalid column reference characters ([, \, ], ^, _, `
  assert.doesNotMatch(xml, /r="[\[\\\]^_`]/);
});

test("PDF writer paginates long content across multiple pages", async () => {
  const manyLines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: ${"X".repeat(60)}`).join("\n");
  const output = path.join(project, "long.pdf");
  const result = await executePlatformTool("create_artifact", { type: "pdf", path: output, title: "Long Doc", content: manyLines }, ctx);
  assert.match(result, /Created and verified/);
  const pdf = fs.readFileSync(output, "latin1");
  // Multiple page objects → /Type /Page appears more than once
  const pageMatches = pdf.match(/\/Type\s*\/Page[^s]/g) || [];
  assert.ok(pageMatches.length > 1, `expected multiple pages, got ${pageMatches.length}`);
  // The /Count should reflect more than one page
  const countMatch = pdf.match(/\/Count\s+(\d+)/);
  assert.ok(countMatch);
  assert.ok(Number(countMatch[1]) > 1, `expected /Count > 1, got ${countMatch[1]}`);
  // Later content should survive — check that "Line 100" or nearby appears
  // (exact content depends on wrapping, but we should NOT see only 55 lines)
  assert.ok(pdf.includes("Line 1"), "first line present");
});

test("PDF writer wraps very long lines instead of truncating at 100 chars", async () => {
  const longLine = "A".repeat(250);
  const output = path.join(project, "wrapped.pdf");
  const result = await executePlatformTool("create_artifact", { type: "pdf", path: output, title: "Wrap", content: longLine }, ctx);
  assert.match(result, /Created and verified/);
  const pdf = fs.readFileSync(output, "latin1");
  // The original line of 250 A's should produce multiple wrapped Tj entries
  // Verify the PDF has multiple text-show operators (wrapping produces multiple lines)
  const tjCount = (pdf.match(/\) Tj/g) || []).length;
  assert.ok(tjCount > 2, `expected wrapping to produce multiple Tj entries, got ${tjCount}`);
});

test("generates images through the selected saved API connection", async () => {
  const output = path.join(project, "generated.png");
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image-bytes").toString("base64") }] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  const images = [];
  try {
    const result = await executePlatformTool("generate_image", { prompt: "A flat Boolean app icon", path: output }, {
      ...ctx,
      config: {
        imageGeneration: { provider: "image-api", model: "image-model", size: "512x512" },
        connectors: { apis: [{ id: "image-api", name: "Images", baseUrl: "https://images.example/v1", apiKey: "test-key", enabled: true }] }
      },
      onImage: (src, caption) => images.push({ src, caption })
    });
    assert.match(result, /Generated image/);
    assert.equal(request.url, "https://images.example/v1/images/generations");
    assert.deepEqual(JSON.parse(request.options.body), { model: "image-model", prompt: "A flat Boolean app icon", size: "512x512", response_format: "b64_json" });
    assert.equal(fs.readFileSync(output, "utf8"), "image-bytes");
    assert.equal(images.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installs, activates, runs hooks, and removes a local skill", async () => {
  const source = path.join(root, "skill-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "skill.json"), JSON.stringify({
    id: "demo-skill",
    name: "Demo skill",
    version: 2,
    instructions: "Always verify the demo output.",
    permissions: ["project:read"],
    hooks: { verify: "Write-Output hook-ok" }
  }));
  assert.match(await executePlatformTool("manage_skill", { operation: "install", source }, ctx), /Installed skill/);
  assert.match(await executePlatformTool("manage_skill", { operation: "use", id: "demo-skill" }, ctx), /Always verify/);
  assert.match(await executePlatformTool("manage_skill", { operation: "run_hook", id: "demo-skill", event: "verify" }, ctx), /hook-ok/);
  assert.match(await executePlatformTool("manage_skill", { operation: "remove", id: "demo-skill" }, ctx), /Removed skill/);
});

test("persists and manages durable automation definitions", async () => {
  const created = JSON.parse(await executePlatformTool("manage_automation", {
    operation: "create", name: "Daily check", schedule: "interval", everyMinutes: 60,
    actionType: "command", command: "Write-Output ready", cwd: project
  }, ctx));
  assert.equal(created.enabled, true);
  const listed = JSON.parse(await executePlatformTool("manage_automation", { operation: "list" }, ctx));
  assert.equal(listed.automations.some((item) => item.id === created.id), true);
  assert.match(await executePlatformTool("manage_automation", { operation: "pause", id: created.id }, ctx), /paused/);
  assert.match(await executePlatformTool("manage_automation", { operation: "resume", id: created.id }, ctx), /resumed/);
  assert.match(await executePlatformTool("manage_automation", { operation: "remove", id: created.id }, ctx), /Removed automation/);
});

test("scheduled agent tasks preserve their model and unattended approval snapshot", async () => {
  const created = JSON.parse(await executePlatformTool("manage_automation", {
    operation: "create", name: "Build later", schedule: "once",
    runAt: new Date(Date.now() + 60000).toISOString(), actionType: "agent",
    text: "Build a small tic-tac-toe game", provider: "zaiCoding",
    model: "glm-5", autoApprove: true, threadId: "thread-1"
  }, ctx));
  assert.equal(created.actionType, "agent");
  assert.equal(created.provider, "zaiCoding");
  assert.equal(created.model, "glm-5");
  assert.equal(created.autoApprove, true);
  assert.equal(created.threadId, "thread-1");
  await executePlatformTool("manage_automation", { operation: "remove", id: created.id }, ctx);
});

test("calculates calendar recurrence and executes due app reminders", async () => {
  const daily = nextRunFor({ schedule: "daily", runAt: "2026-07-15T09:30:00.000Z" }, Date.parse("2026-07-17T10:00:00.000Z"));
  const weekly = nextRunFor({ schedule: "weekly", runAt: "2026-07-15T09:30:00.000Z" }, Date.parse("2026-07-17T10:00:00.000Z"));
  assert.equal(new Date(daily).toISOString(), "2026-07-18T09:30:00.000Z");
  assert.equal(new Date(weekly).toISOString(), "2026-07-22T09:30:00.000Z");

  const seen = [];
  setAutomationActionHandler(async (item) => { seen.push(item.text); return { code: 0, output: item.text }; });
  const created = JSON.parse(await executePlatformTool("manage_automation", {
    operation: "create", name: "Remember this", schedule: "once",
    runAt: new Date(Date.now() + 1000).toISOString(), actionType: "reminder", text: "Check the report"
  }, ctx));
  assert.equal(await runDueAutomations(created.nextRunAt + 1), 1);
  assert.deepEqual(seen, ["Check the report"]);
  const listed = JSON.parse(await executePlatformTool("manage_automation", { operation: "list" }, ctx));
  assert.equal(listed.automations.find((item) => item.id === created.id).enabled, false);
  assert.equal(listed.recentRuns[0].automationId, created.id);
  assert.equal(listed.recentRuns[0].code, 0);
  await executePlatformTool("manage_automation", { operation: "remove", id: created.id }, ctx);
});

test("reports repository risks with file and line evidence", async () => {
  fs.writeFileSync(path.join(project, "unsafe.js"), "const token = 'api_key=secret-value';\neval(userInput);\n");
  const review = JSON.parse(await executePlatformTool("review_repository", { scope: "repository", profile: "security" }, ctx));
  assert.equal(review.filesReviewed > 0, true);
  assert.equal(review.findings.some((item) => item.file === "unsafe.js" && item.line === 2), true);
});

test("runs commands in a disposable copied workspace", async () => {
  fs.writeFileSync(path.join(project, "source.txt"), "source");
  const result = JSON.parse(await executePlatformTool("run_guarded", {
    command: "Set-Content -LiteralPath result.txt -Value done", source: project, keep: false, timeoutSeconds: 10
  }, ctx));
  assert.equal(result.exitCode, 0);
  assert.equal(result.files.includes("result.txt"), true);
  assert.equal(result.workspace, "removed");
});
