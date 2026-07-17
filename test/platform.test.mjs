import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-platform-"));
const state = path.join(root, "state");
process.env.BOOLEAN_PLATFORM_HOME = state;
const { executePlatformTool } = await import(`../src/platform.js?test=${Date.now()}`);

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

