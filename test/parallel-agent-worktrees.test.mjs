import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discardAgentRun, listAgentRuns } from "../src/orchestrator.js";
import { executeTool } from "../src/tools.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

test("parallel editing agents use isolated worktrees and integrate in assignment order", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-team-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n");
  git(projectDir, "add", "base.txt");
  git(projectDir, "commit", "-m", "base");
  fs.writeFileSync(path.join(projectDir, "personal-untracked.txt"), "preserve\n");

  const steps = [];
  const result = await executeTool("run_subagent", {
    tasks: ["Build frontend", "Build backend"],
    isolation: "worktree",
    apply: true
  }, {
    projectDir,
    config: { provider: "openai", openai: { model: "gpt-test" } },
    approve: async () => true,
    onStep: (step) => steps.push(step),
    runSubagent: async (task, options) => {
      const file = /frontend/i.test(task) ? "frontend.txt" : "backend.txt";
      fs.writeFileSync(path.join(options.workspaceDir, file), `${task}\n`);
      return `${task} complete.`;
    }
  });

  assert.match(result, /Integration: applied .* successfully/);
  assert.equal(fs.readFileSync(path.join(projectDir, "frontend.txt"), "utf8").replaceAll("\r", ""), "Build frontend\n");
  assert.equal(fs.readFileSync(path.join(projectDir, "backend.txt"), "utf8").replaceAll("\r", ""), "Build backend\n");
  assert.equal(fs.readFileSync(path.join(projectDir, "personal-untracked.txt"), "utf8"), "preserve\n");
  assert.deepEqual(steps.filter((step) => step.name === "team_worker" && step.args.state === "queued").map((step) => step.args.role), ["Agent 1", "Agent 2"]);
  assert.equal(steps.filter((step) => step.name === "team_worker" && step.args.state === "working").length, 2);
  assert.ok(steps.some((step) => step.name === "team_worker" && /integrated/i.test(step.result)));

  const runs = listAgentRuns(projectDir);
  assert.equal(runs.filter((run) => run.state === "applied").length, 2);
  assert.ok(runs.every((run) => !fs.existsSync(run.workspaceDir)), "applied worker worktrees are cleaned up");
  for (const run of runs) await discardAgentRun(run.id);
});

test("parallel result integration requires isolated worktrees", async () => {
  const result = await executeTool("run_subagent", { tasks: ["Review"], isolation: "shared", apply: true }, {
    projectDir: os.tmpdir(), config: {}, approve: async () => true, runSubagent: async () => "done"
  });
  assert.match(result, /apply=true requires worktree isolation/);
});

test("overlapping agent edits never use last-writer-wins", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-conflict-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "shared.txt"), "base\n");
  git(projectDir, "add", "shared.txt");
  git(projectDir, "commit", "-m", "base");

  const result = await executeTool("run_subagent", {
    tasks: ["First version", "Second version"], isolation: "worktree", apply: true
  }, {
    projectDir,
    config: { provider: "openai", openai: { model: "gpt-test" }, ui: { codingAgent: { teamwork: { maxWorkers: 2 } } } },
    approve: async () => true,
    runSubagent: async (task, options) => {
      fs.writeFileSync(path.join(options.workspaceDir, "shared.txt"), `${task}\n`);
      return `${task} complete.`;
    }
  });

  assert.match(result, /agent result conflicted and was not applied/i);
  assert.equal(fs.readFileSync(path.join(projectDir, "shared.txt"), "utf8").replaceAll("\r", ""), "First version\n");
  const runs = listAgentRuns(projectDir);
  assert.equal(runs.filter((run) => run.state === "applied").length, 1);
  assert.equal(runs.filter((run) => run.state === "completed").length, 1);
  assert.ok(fs.existsSync(runs.find((run) => run.state === "completed").workspaceDir), "conflicted worktree is preserved for lead resolution");
  for (const run of runs) await discardAgentRun(run.id);
});

test("a failed editing worker retries in its saved worktree with another connected model", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-retry-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n");
  git(projectDir, "add", "base.txt");
  git(projectDir, "commit", "-m", "base");
  const steps = [];
  const result = await executeTool("run_subagent", { task: "Build retry result", isolation: "worktree", apply: true }, {
    projectDir,
    config: {
      provider: "openai", openai: { apiKey: "x", model: "lead-model" }, google: { apiKey: "y", model: "worker-model" },
      ui: { codingAgent: { teamwork: { maxWorkers: 2, workerProvider: "auto" } } }
    },
    approve: async () => true,
    onStep: (step) => steps.push(step),
    runSubagent: async (task, options) => {
      if (options.attempt !== 2) throw new Error("first worker unavailable");
      fs.writeFileSync(path.join(options.workspaceDir, "retry.txt"), `${task}\n`);
      return "Fallback completed.";
    }
  });
  assert.match(result, /Fallback: lead-model completed attempt 2/);
  assert.equal(fs.readFileSync(path.join(projectDir, "retry.txt"), "utf8").replaceAll("\r", ""), "Build retry result\n");
  assert.ok(steps.some((step) => step.args.state === "retrying" && step.args.attempt === 2));
  const runs = listAgentRuns(projectDir);
  for (const run of runs) await discardAgentRun(run.id);
});
