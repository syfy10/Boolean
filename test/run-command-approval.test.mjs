import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { executeTool, windowsCommandShim } from "../src/tools.js";

test("Windows PowerShell commands use npm.cmd and npx.cmd at command boundaries", () => {
  if (process.platform !== "win32") return;
  assert.equal(windowsCommandShim("npm install", "powershell"), "npm.cmd install");
  assert.equal(
    windowsCommandShim("cd app && npm run build; npx next lint", "powershell"),
    "cd app && npm.cmd run build; npx.cmd next lint"
  );
  assert.equal(windowsCommandShim("npm install", "cmd"), "npm install");
});

test("an exact approved run_command executes once and reuses its saved result", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-command-approval-"));
  let approvalCount = 0;
  const ctx = {
    projectDir,
    config: { projectsDir: projectDir, commandTimeoutMs: 10_000 },
    approve: async () => { approvalCount += 1; return true; }
  };
  try {
    const first = await executeTool("run_command", { command: "node --version" }, ctx);
    const second = await executeTool("run_command", { command: "node --version" }, ctx);
    assert.match(first, /^v\d+\.\d+\.\d+/m);
    assert.match(second, /Already ran this exact approved command once/);
    assert.match(second, /^Already ran[\s\S]*v\d+\.\d+\.\d+/m);
    assert.equal(approvalCount, 1);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("run_command refuses a project folder that does not exist and never fabricates it", async () => {
  const ghostRoot = path.join(os.tmpdir(), `boolean-ghost-${Date.now()}`);
  const ghost = path.join(ghostRoot, "does-not-exist", "greenscan-production-project");
  let approvalCount = 0;
  const ctx = {
    projectDir: ghost,
    config: { commandTimeoutMs: 10_000 },
    approve: async () => { approvalCount += 1; return true; }
  };
  try {
    const res = await executeTool("run_command", { command: "node --version" }, ctx);
    assert.match(res, /project folder does not exist/i, "gives a clear, actionable error");
    assert.match(res, /greenscan-production-project/, "names the offending path");
    assert.equal(approvalCount, 0, "must not prompt for approval or run when the dir is missing");
    assert.equal(fs.existsSync(ghost), false, "must not silently create the phantom project folder");
  } finally {
    fs.rmSync(ghostRoot, { recursive: true, force: true });
  }
});

test("a declined exact command does not keep asking", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-command-decline-"));
  let approvalCount = 0;
  const ctx = {
    projectDir,
    config: { projectsDir: projectDir, commandTimeoutMs: 10_000 },
    approve: async () => { approvalCount += 1; return false; }
  };
  try {
    assert.match(await executeTool("run_command", { command: "node --version" }, ctx), /user declined/);
    assert.match(await executeTool("run_command", { command: "node --version" }, ctx), /already declined/);
    assert.equal(approvalCount, 1);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
