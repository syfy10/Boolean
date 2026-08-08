import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SAZ_DIR } from "../src/config.js";
import {
  applyAgentRuns,
  createIsolatedAgentRun,
  detectVerifyCommand,
  discardAgentRun,
  finalizeIsolatedAgentRun,
  gcAgentWorktrees,
  listAgentRuns,
  verifyAgentRun
} from "../src/orchestrator.js";
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
  // Each worker reports working twice: doing the task, then running the
  // project's checks inside its own worktree before anything is merged.
  const working = steps.filter((step) => step.name === "team_worker" && step.args.state === "working");
  assert.equal(working.length, 4);
  assert.equal(working.filter((step) => /checks inside the isolated worktree/i.test(step.result)).length, 2);
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

  // Integration is all-or-nothing: applying one commit at a time used to leave
  // the project half-merged when a later result conflicted.
  assert.match(result, /rolled back to [0-9a-f]{8} and applied nothing/i);
  assert.equal(fs.readFileSync(path.join(projectDir, "shared.txt"), "utf8").replaceAll("\r", ""), "base\n", "a conflict leaves the project untouched");
  const runs = listAgentRuns(projectDir);
  assert.equal(runs.filter((run) => run.state === "applied").length, 0);
  assert.equal(runs.filter((run) => run.state === "completed").length, 2);
  assert.ok(runs.every((run) => fs.existsSync(run.workspaceDir)), "both worktrees are preserved for lead resolution");
  for (const run of runs) await discardAgentRun(run.id);
});

test("isolated agents start while the main project has uncommitted work", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-dirty-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n");
  git(projectDir, "add", "base.txt");
  git(projectDir, "commit", "-m", "base");
  // A tracked, uncommitted edit used to make every isolated agent refuse to
  // start, which is the normal state of a project during real work.
  fs.writeFileSync(path.join(projectDir, "base.txt"), "edited in the main tree\n");

  const result = await executeTool("run_subagent", { task: "Add a helper", isolation: "worktree", apply: false }, {
    projectDir,
    config: { provider: "openai", openai: { model: "gpt-test" } },
    approve: async () => true,
    runSubagent: async (task, options) => {
      assert.equal(fs.readFileSync(path.join(options.workspaceDir, "base.txt"), "utf8").replaceAll("\r", ""), "base\n",
        "the worktree branches from HEAD, not from the dirty main tree");
      fs.writeFileSync(path.join(options.workspaceDir, "helper.txt"), `${task}\n`);
      return "Helper added.";
    }
  });

  assert.match(result, /Helper added/);
  assert.doesNotMatch(result, /uncommitted/i);
  assert.equal(fs.readFileSync(path.join(projectDir, "base.txt"), "utf8").replaceAll("\r", ""), "edited in the main tree\n");
  const runs = listAgentRuns(projectDir);
  assert.equal(runs.length, 1);
  for (const run of runs) await discardAgentRun(run.id);
});

test("a worker's own checks run in its worktree and gate the merge", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-verify-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n");
  git(projectDir, "add", "base.txt");
  git(projectDir, "commit", "-m", "base");

  const run = await createIsolatedAgentRun(projectDir, "Add a broken change", 0);
  fs.writeFileSync(path.join(run.workspaceDir, "broken.txt"), "broken\n");
  const finalized = await finalizeIsolatedAgentRun(run.id, "done");
  assert.ok(finalized.commit, "the worker produced a commit");

  const failing = await verifyAgentRun(run.id, { check: { command: process.execPath, args: ["-e", "process.exit(3)"], label: "unit checks" } });
  assert.equal(failing.verification.ran, true);
  assert.equal(failing.verification.ok, false);
  assert.equal(failing.verification.code, 3);

  // A result that fails its own checks must not be merged even though nothing
  // about it conflicts textually.
  await assert.rejects(() => applyAgentRuns([run.id], projectDir), /failed its own unit checks/);
  assert.equal(fs.existsSync(path.join(projectDir, "broken.txt")), false);

  const passing = await verifyAgentRun(run.id, { check: { command: process.execPath, args: ["-e", "process.exit(0)"], label: "unit checks" } });
  assert.equal(passing.verification.ok, true);
  const [applied] = await applyAgentRuns([run.id], projectDir);
  assert.equal(applied.state, "applied");
  assert.equal(fs.readFileSync(path.join(projectDir, "broken.txt"), "utf8").replaceAll("\r", ""), "broken\n");
  await discardAgentRun(run.id).catch(() => {});
});

test("a check that cannot run is reported as unverified, never as a failure", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-parallel-unverified-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "boollm-test@example.invalid");
  git(projectDir, "config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  git(projectDir, "add", "package.json");
  git(projectDir, "commit", "-m", "base");

  const detected = detectVerifyCommand(projectDir);
  assert.equal(detected.label, "npm test");
  assert.equal(detected.needsModules, true);
  assert.equal(detectVerifyCommand(os.tmpdir()), null, "a project with no test script has no check");

  const run = await createIsolatedAgentRun(projectDir, "Change something", 0);
  fs.writeFileSync(path.join(run.workspaceDir, "changed.txt"), "changed\n");
  await finalizeIsolatedAgentRun(run.id, "done");
  // node_modules is untracked, so a fresh worktree never has it. Reporting that
  // honestly beats failing a result for a missing dependency install.
  const verified = await verifyAgentRun(run.id);
  assert.equal(verified.verification.ran, false);
  assert.equal(verified.verification.ok, true);
  assert.match(verified.verification.label, /dependencies are not installed/);
  const [applied] = await applyAgentRuns([run.id], projectDir);
  assert.equal(applied.state, "applied");
  await discardAgentRun(run.id).catch(() => {});
});

test("orphaned agent worktrees are swept and live ones are left alone", async (t) => {
  const worktreesDir = path.join(SAZ_DIR, "agent-worktrees");
  const orphanId = `gc-test-${Date.now().toString(36)}`;
  const orphanDir = path.join(worktreesDir, orphanId);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, "leftover.txt"), "leftover\n");
  t.after(() => fs.rmSync(orphanDir, { recursive: true, force: true }));

  // Fresh directories are inside the grace window: another session may be
  // mid-creation and not have written its record yet.
  let swept = await gcAgentWorktrees();
  assert.ok(!swept.removed.includes(orphanId), "a directory younger than the grace window is kept");

  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(orphanDir, old, old);
  swept = await gcAgentWorktrees();
  assert.ok(swept.removed.includes(orphanId), "an aged directory with no run record is swept");
  assert.equal(fs.existsSync(orphanDir), false);
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
