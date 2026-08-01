import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { executeTool } from "../src/tools.js";

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
