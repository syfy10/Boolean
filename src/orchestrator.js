import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SAZ_DIR } from "./config.js";

const RUNS_FILE = path.join(SAZ_DIR, "agent-runs.json");
const WORKTREES_DIR = path.join(SAZ_DIR, "agent-worktrees");

function execGit(cwd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, output: error.message });
      return;
    }
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      output += "\n[timed out]";
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
  });
}

function readRuns() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

function writeRuns(runs) {
  fs.mkdirSync(SAZ_DIR, { recursive: true });
  const temp = RUNS_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ version: 1, runs }, null, 2));
  fs.renameSync(temp, RUNS_FILE);
}

function saveRun(run) {
  const runs = readRuns().filter((item) => item.id !== run.id);
  runs.unshift(run);
  writeRuns(runs.slice(0, 100));
  return run;
}

function safeSlug(value, fallback = "task") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || fallback;
}

export async function isGitRepository(directory) {
  if (!directory || !fs.existsSync(directory)) return false;
  const result = await execGit(directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.output.trim() === "true";
}

export async function createIsolatedAgentRun(projectDir, task, index = 0) {
  const root = path.resolve(String(projectDir || ""));
  if (!await isGitRepository(root)) {
    throw new Error("isolated agents require a Git project; initialize Git or use shared isolation");
  }
  const status = await execGit(root, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect the main project");
  if (status.output.trim()) {
    throw new Error(
      "the main project has uncommitted changes; commit or stash them before starting isolated agents so every agent sees the current project"
    );
  }
  const id = `${Date.now().toString(36)}-${index + 1}-${crypto.randomBytes(3).toString("hex")}`;
  const slug = safeSlug(task);
  const branch = `boolean/agent/${id}-${slug}`;
  const workspaceDir = path.join(WORKTREES_DIR, id);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const added = await execGit(root, ["worktree", "add", "-b", branch, workspaceDir, "HEAD"], 120000);
  if (added.code !== 0) throw new Error(`could not create isolated worktree: ${added.output}`);
  return saveRun({
    id,
    task: String(task || "").trim(),
    projectDir: root,
    workspaceDir,
    branch,
    state: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    commit: "",
    summary: ""
  });
}

export async function finalizeIsolatedAgentRun(id, summary = "") {
  const run = readRuns().find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (!fs.existsSync(run.workspaceDir)) throw new Error(`worktree for '${id}' no longer exists`);

  const status = await execGit(run.workspaceDir, ["status", "--short"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect agent worktree");
  let commit = "";
  if (status.output.trim()) {
    const add = await execGit(run.workspaceDir, ["add", "-A"]);
    if (add.code !== 0) throw new Error(add.output || "could not stage agent changes");
    const message = `Boolean agent: ${safeSlug(run.task).replace(/-/g, " ")}`;
    const committed = await execGit(run.workspaceDir, ["commit", "-m", message], 120000);
    if (committed.code !== 0) throw new Error(committed.output || "could not commit agent changes");
    const head = await execGit(run.workspaceDir, ["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new Error(head.output || "could not read agent commit");
    commit = head.output.trim();
  }
  const changed = commit
    ? await execGit(run.workspaceDir, ["diff", "--stat", "HEAD~1", "HEAD"])
    : { code: 0, output: "No file changes." };
  return saveRun({
    ...run,
    state: "completed",
    commit,
    summary: String(summary || "").trim(),
    changeSummary: changed.code === 0 ? changed.output : "Changes committed.",
    updatedAt: Date.now()
  });
}

export function listAgentRuns(projectDir = "") {
  const root = projectDir ? path.resolve(projectDir) : "";
  return readRuns().filter((run) => !root || path.resolve(run.projectDir) === root);
}

export async function applyAgentRun(id, targetDir) {
  const run = readRuns().find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (!run.commit) throw new Error(`agent run '${id}' did not produce file changes`);
  const target = path.resolve(String(targetDir || run.projectDir));
  if (target !== path.resolve(run.projectDir)) throw new Error("agent result belongs to a different project");
  const status = await execGit(target, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect target project");
  if (status.output.trim()) throw new Error("the main project has uncommitted changes; commit or stash them before applying an agent result");
  const applied = await execGit(target, ["cherry-pick", run.commit], 120000);
  if (applied.code !== 0) {
    await execGit(target, ["cherry-pick", "--abort"]);
    throw new Error(`agent result conflicted and was not applied: ${applied.output}`);
  }
  const updated = { ...run, state: "applied", appliedAt: Date.now(), updatedAt: Date.now() };
  saveRun(updated);
  return updated;
}

export async function discardAgentRun(id) {
  const runs = readRuns();
  const run = runs.find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (fs.existsSync(run.workspaceDir) && await isGitRepository(run.projectDir)) {
    const removed = await execGit(run.projectDir, ["worktree", "remove", "--force", run.workspaceDir], 120000);
    if (removed.code !== 0) throw new Error(`could not remove agent worktree: ${removed.output}`);
  }
  if (run.branch && await isGitRepository(run.projectDir)) {
    await execGit(run.projectDir, ["branch", "-D", run.branch]);
  }
  writeRuns(runs.filter((item) => item.id !== id));
  return run;
}
