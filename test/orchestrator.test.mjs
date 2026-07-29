import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyAgentRun,
  createIsolatedAgentRun,
  discardAgentRun,
  finalizeIsolatedAgentRun,
  isGitRepository,
  listAgentRuns
} from "../src/orchestrator.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("isolated agent worktrees produce durable, selectively applied results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-orchestrator-"));
  let run;
  test.after(async () => {
    if (run) await discardAgentRun(run.id);
    fs.rmSync(root, { recursive: true, force: true });
  });
  git(root, "init");
  git(root, "config", "user.email", "boolean-test@example.invalid");
  git(root, "config", "user.name", "Boolean Test");
  fs.writeFileSync(path.join(root, "demo.txt"), "base\n");
  git(root, "add", "demo.txt");
  git(root, "commit", "-m", "initial");

  assert.equal(await isGitRepository(root), true);
  fs.writeFileSync(path.join(root, "demo.txt"), "uncommitted change\n");
  await assert.rejects(
    createIsolatedAgentRun(root, "should not start from stale HEAD"),
    /uncommitted changes/
  );
  fs.writeFileSync(path.join(root, "demo.txt"), "base\n");
  run = await createIsolatedAgentRun(root, "improve demo", 0);
  assert.notEqual(path.resolve(run.workspaceDir), path.resolve(root));
  fs.writeFileSync(path.join(run.workspaceDir, "demo.txt"), "isolated change\n");

  const completed = await finalizeIsolatedAgentRun(run.id, "Updated the demo.");
  assert.equal(completed.state, "completed");
  assert.match(completed.commit, /^[a-f0-9]{40}$/);
  assert.equal(fs.readFileSync(path.join(root, "demo.txt"), "utf8").replace(/\r\n/g, "\n"), "base\n");
  assert.equal(listAgentRuns(root).some((item) => item.id === run.id), true);

  const applied = await applyAgentRun(run.id, root);
  assert.equal(applied.state, "applied");
  assert.equal(fs.readFileSync(path.join(root, "demo.txt"), "utf8").replace(/\r\n/g, "\n"), "isolated change\n");
});
