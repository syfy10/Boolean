import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SAZ_DIR } from "./config.js";

const RUNS_FILE = path.join(SAZ_DIR, "agent-runs.json");
const WORKTREES_DIR = path.join(SAZ_DIR, "agent-worktrees");
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

function execIn(cwd, command, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, windowsHide: true }); }
    catch (error) { resolve({ code: -1, output: error.message }); return; }
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} output += "\n[timed out]"; }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim() }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }); });
  });
}

function execGit(cwd, args, timeoutMs = 60000) { return execIn(cwd, "git", args, timeoutMs); }

function readRuns() { try { const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")); return Array.isArray(parsed.runs) ? parsed.runs : []; } catch { return []; } }
function writeRuns(runs) { fs.mkdirSync(SAZ_DIR, { recursive: true }); const temp = RUNS_FILE + ".tmp"; fs.writeFileSync(temp, JSON.stringify({ version: 1, runs }, null, 2)); fs.renameSync(temp, RUNS_FILE); }
// Trimming purely by age orphaned worktrees: the record fell out of the file
// while its directory stayed on disk, and discard/gc look runs up by id, so
// nothing could ever remove it again. Never drop a run that still owns a
// directory; age out only the finished ones.
function saveRun(run) {
  const runs = readRuns().filter((item) => item.id !== run.id);
  runs.unshift(run);
  const owned = new Set(runs.filter((item) => item.workspaceDir && fs.existsSync(item.workspaceDir)).map((item) => item.id));
  const trimmed = [];
  for (const item of runs) if (owned.has(item.id) || trimmed.length < 100) trimmed.push(item);
  writeRuns(trimmed);
  return run;
}
function safeSlug(value, fallback = "task") { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || fallback; }

export async function isGitRepository(directory) {
  if (!directory || !fs.existsSync(directory)) return false;
  const result = await execGit(directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.output.trim() === "true";
}

export async function createIsolatedAgentRun(projectDir, task, index = 0) {
  const root = path.resolve(String(projectDir || ""));
  if (!await isGitRepository(root)) throw new Error("isolated agents require a Git project; initialize Git or use shared isolation");
  // A worktree branches from HEAD and is isolated from the main working tree by
  // construction, so uncommitted work there cannot reach an agent. Demanding a
  // clean tree here made parallel agents refuse to start during ordinary work.
  // The requirement is real only at apply time, where cherry-pick needs it.
  const id = `${Date.now().toString(36)}-${index + 1}-${crypto.randomBytes(3).toString("hex")}`;
  const branch = `boolean/agent/${id}-${safeSlug(task)}`;
  const workspaceDir = path.join(WORKTREES_DIR, id);
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const added = await execGit(root, ["worktree", "add", "-b", branch, workspaceDir, "HEAD"], 120000);
  if (added.code !== 0) throw new Error(`could not create isolated worktree: ${added.output}`);
  return saveRun({ id, task: String(task || "").trim(), projectDir: root, workspaceDir, branch, state: "running", createdAt: Date.now(), updatedAt: Date.now(), commit: "", summary: "" });
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
    const committed = await execGit(run.workspaceDir, ["commit", "-m", `Boollm agent: ${safeSlug(run.task).replace(/-/g, " ")}`], 120000);
    if (committed.code !== 0) throw new Error(committed.output || "could not commit agent changes");
    const head = await execGit(run.workspaceDir, ["rev-parse", "HEAD"]);
    if (head.code !== 0) throw new Error(head.output || "could not read agent commit");
    commit = head.output.trim();
  }
  const changed = commit ? await execGit(run.workspaceDir, ["diff", "--stat", "HEAD~1", "HEAD"]) : { code: 0, output: "No file changes." };
  return saveRun({ ...run, state: "completed", commit, summary: String(summary || "").trim(), changeSummary: changed.code === 0 ? changed.output : "Changes committed.", updatedAt: Date.now() });
}

export function listAgentRuns(projectDir = "") { const root = projectDir ? path.resolve(projectDir) : ""; return readRuns().filter((run) => !root || path.resolve(run.projectDir) === root); }

// The worktree is already checked out and isolated, which makes it the cheapest
// possible place to find out whether a worker's work is any good - before it is
// merged rather than after. A fresh worktree has no node_modules (untracked, so
// never copied), so a dependency-based check is reported as unverifiable rather
// than failed; claiming a false failure would be worse than admitting the gap.
export function detectVerifyCommand(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const script = String(pkg?.scripts?.test || "").trim();
    if (script && !/no test specified/i.test(script)) {
      return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["test", "--silent"], label: "npm test", needsModules: true };
    }
  } catch {}
  return null;
}

export async function verifyAgentRun(id, options = {}) {
  const run = readRuns().find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (!fs.existsSync(run.workspaceDir)) throw new Error(`worktree for '${id}' no longer exists`);
  const skip = (label) => saveRun({ ...run, verification: { ran: false, ok: true, label, at: Date.now() }, updatedAt: Date.now() });
  if (!run.commit) return skip("no file changes to check");
  const check = options.check === undefined ? detectVerifyCommand(run.workspaceDir) : options.check;
  if (!check) return skip("no project check found");
  if (check.needsModules && !fs.existsSync(path.join(run.workspaceDir, "node_modules"))) return skip(`${check.label} skipped: dependencies are not installed in the worktree`);
  const result = await execIn(run.workspaceDir, check.command, check.args, Number(options.timeoutMs) || 300000);
  const verification = { ran: true, ok: result.code === 0, label: check.label, code: result.code, output: String(result.output || "").slice(-4000), at: Date.now() };
  return saveRun({ ...run, verification, updatedAt: Date.now() });
}

// Applying one commit at a time left a half-merged project whenever a later
// result conflicted, and reported it only as text. Record HEAD first and reset
// to it on any failure, so integration is all-or-nothing.
export async function applyAgentRuns(ids, targetDir, { requireVerified = true } = {}) {
  const all = readRuns();
  const runs = (Array.isArray(ids) ? ids : [ids]).map((id) => {
    const run = all.find((item) => item.id === id);
    if (!run) throw new Error(`unknown isolated agent run '${id}'`);
    return run;
  });
  const changed = runs.filter((run) => run.commit);
  if (!changed.length) throw new Error(`agent run '${runs[0].id}' did not produce file changes`);
  const target = path.resolve(String(targetDir || changed[0].projectDir));
  for (const run of changed) {
    if (path.resolve(run.projectDir) !== target) throw new Error("agent result belongs to a different project");
  }
  if (requireVerified) {
    const failed = changed.filter((run) => run.verification?.ran && run.verification.ok === false);
    if (failed.length) throw new Error(`not applied: ${failed.map((run) => `${run.id} failed its own ${run.verification.label}`).join("; ")}`);
  }
  const status = await execGit(target, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect target project");
  if (status.output.trim()) throw new Error("the main project has uncommitted changes; commit or stash them before applying an agent result");
  const head = await execGit(target, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(head.output || "could not read the project HEAD");
  const baseline = head.output.trim();
  for (const run of changed) {
    const applied = await execGit(target, ["cherry-pick", run.commit], 120000);
    if (applied.code !== 0) {
      await execGit(target, ["cherry-pick", "--abort"]);
      await execGit(target, ["reset", "--hard", baseline], 120000);
      throw new Error(`agent result '${run.id}' conflicted; rolled back to ${baseline.slice(0, 8)} and applied nothing: ${applied.output}`);
    }
  }
  const updated = [];
  for (const run of changed) {
    // Cleanup failure must not undo a merge that already succeeded, so it is
    // recorded on the run rather than thrown.
    let cleanup = "";
    if (fs.existsSync(run.workspaceDir)) {
      const removed = await execGit(run.projectDir, ["worktree", "remove", "--force", run.workspaceDir], 120000);
      if (removed.code !== 0) cleanup = removed.output;
    }
    if (run.branch) await execGit(run.projectDir, ["branch", "-D", run.branch]);
    await execGit(run.projectDir, ["worktree", "prune"]);
    updated.push(saveRun({ ...run, state: "applied", appliedAt: Date.now(), updatedAt: Date.now(), ...(cleanup ? { cleanupWarning: cleanup } : {}) }));
  }
  return updated;
}

export async function applyAgentRun(id, targetDir, options) {
  const [run] = await applyAgentRuns([id], targetDir, options);
  return run;
}

// A worktree whose run is applied, or whose run record is gone entirely, is
// dead weight on disk. Sweep both.
export async function gcAgentWorktrees(projectDir = "") {
  let entries = [];
  try { entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); }
  catch { return { removed: [], kept: 0 }; }
  const runs = new Map(readRuns().map((run) => [run.id, run]));
  const removed = [];
  for (const id of entries) {
    const run = runs.get(id);
    if (run && run.state !== "applied") continue;
    // Another session may have just created this worktree and not yet written
    // its record, so a directory with no record is only swept once it is old.
    if (!run) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(path.join(WORKTREES_DIR, id)).mtimeMs; } catch {}
      if (age < ORPHAN_GRACE_MS) continue;
    }
    const dir = path.join(WORKTREES_DIR, id);
    const root = run?.projectDir || String(projectDir || "");
    const tracked = root && await isGitRepository(root);
    if (tracked) {
      await execGit(root, ["worktree", "remove", "--force", dir], 120000);
      if (run?.branch) await execGit(root, ["branch", "-D", run.branch]);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (tracked) await execGit(root, ["worktree", "prune"]);
    removed.push(id);
  }
  return { removed, kept: entries.length - removed.length };
}

export async function discardAgentRun(id) {
  const runs = readRuns(); const run = runs.find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (fs.existsSync(run.workspaceDir) && await isGitRepository(run.projectDir)) {
    const removed = await execGit(run.projectDir, ["worktree", "remove", "--force", run.workspaceDir], 120000);
    if (removed.code !== 0) throw new Error(`could not remove agent worktree: ${removed.output}`);
  }
  if (run.branch && await isGitRepository(run.projectDir)) await execGit(run.projectDir, ["branch", "-D", run.branch]);
  writeRuns(runs.filter((item) => item.id !== id)); return run;
}

// Codex-style Thread / Turn / Item lifecycle is kept beside the isolated-run
// helpers so existing tool imports remain backward compatible.

const STATES = new Set(["in_progress", "completed", "failed", "interrupted", "waiting"]);
const ITEM_STATES = new Set(["in_progress", "completed", "failed", "waiting"]);
const MAX_TURNS = 80;
const MAX_ITEMS = 240;
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+)\b/gi;

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function text(value, max = 1200) {
  return String(value || "").replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim().slice(0, max);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeItem(item = {}) {
  return {
    id: text(item.id, 90) || id("item"),
    type: text(item.type, 60) || "agent_message",
    status: ITEM_STATES.has(item.status) ? item.status : "in_progress",
    title: text(item.title, 180),
    content: text(item.content, 12000),
    detail: text(item.detail, 1200),
    startedAt: Number(item.startedAt) || Date.now(),
    completedAt: Number(item.completedAt) || 0,
    metadata: item.metadata && typeof item.metadata === "object" ? clone(item.metadata) : {}
  };
}
function normalizeTurn(turn = {}) {
  return {
    id: text(turn.id, 90) || id("turn"),
    status: STATES.has(turn.status) ? turn.status : "in_progress",
    input: text(turn.input, 8000),
    startedAt: Number(turn.startedAt) || Date.now(),
    completedAt: Number(turn.completedAt) || 0,
    items: Array.isArray(turn.items) ? turn.items.slice(-MAX_ITEMS).map(normalizeItem) : [],
    steering: Array.isArray(turn.steering) ? turn.steering.slice(-20).map((entry) => ({ text: text(entry?.text, 4000), at: Number(entry?.at) || Date.now() })) : [],
    error: text(turn.error, 1200),
    completion: text(turn.completion, 4000)
  };
}

export class CodexOrchestrator {
  constructor({ threadId, persisted, onEvent } = {}) {
    const saved = persisted && typeof persisted === "object" ? persisted : {};
    this.thread = {
      id: text(threadId || saved.thread?.id, 90) || id("thread"),
      createdAt: Number(saved.thread?.createdAt) || Date.now(),
      updatedAt: Number(saved.thread?.updatedAt) || Date.now(),
      turns: Array.isArray(saved.thread?.turns) ? saved.thread.turns.slice(-MAX_TURNS).map(normalizeTurn) : []
    };
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.sequence = Math.max(0, Number(saved.sequence) || 0);
  }

  emit(method, params = {}) {
    const event = { sequence: ++this.sequence, method, params: clone(params), at: Date.now() };
    this.thread.updatedAt = event.at;
    this.onEvent?.(event, this.snapshot());
    return event;
  }

  activeTurn() { return [...this.thread.turns].reverse().find((turn) => ["in_progress", "waiting"].includes(turn.status)) || null; }

  startTurn(input, metadata = {}) {
    const active = this.activeTurn();
    if (active) this.interruptTurn("Superseded by a new turn.");
    const turn = normalizeTurn({ input, status: "in_progress" });
    turn.metadata = clone(metadata);
    this.thread.turns.push(turn);
    this.thread.turns = this.thread.turns.slice(-MAX_TURNS);
    this.emit("turn/started", { turn: clone(turn) });
    this.startItem("user_message", { content: input, title: "User request" }, { complete: true });
    return turn;
  }

  steer(input) {
    const turn = this.activeTurn();
    if (!turn) return this.startTurn(input);
    const entry = { text: text(input, 4000), at: Date.now() };
    turn.steering.push(entry);
    this.emit("turn/steered", { turnId: turn.id, input: entry });
    this.startItem("user_message", { content: input, title: "Follow-up" }, { complete: true });
    return turn;
  }

  startItem(type, value = {}, options = {}) {
    const turn = this.activeTurn();
    if (!turn) throw new Error("Cannot start an item without an active turn.");
    const item = normalizeItem({ ...value, type, status: options.complete ? "completed" : (value.status || "in_progress") });
    if (options.complete) item.completedAt = Date.now();
    turn.items.push(item);
    turn.items = turn.items.slice(-MAX_ITEMS);
    this.emit("item/started", { turnId: turn.id, item: clone(item) });
    if (options.complete) this.emit("item/completed", { turnId: turn.id, item: clone(item) });
    return item;
  }

  delta(itemId, delta) {
    const turn = this.activeTurn();
    const item = turn?.items.find((entry) => entry.id === itemId);
    if (!item || item.status !== "in_progress") return null;
    item.content = text(`${item.content}${delta}`, 12000);
    this.emit("item/agentMessage/delta", { turnId: turn.id, itemId, delta: String(delta || "") });
    return item;
  }

  completeItem(itemId, update = {}) {
    const turn = this.activeTurn();
    const item = turn?.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    Object.assign(item, normalizeItem({ ...item, ...update, id: item.id, status: "completed", completedAt: Date.now() }));
    this.emit("item/completed", { turnId: turn.id, item: clone(item) });
    return item;
  }

  failItem(itemId, error) {
    const turn = this.activeTurn();
    const item = turn?.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    item.status = "failed";
    item.detail = text(error, 1200);
    item.completedAt = Date.now();
    this.emit("item/completed", { turnId: turn.id, item: clone(item) });
    return item;
  }

  requestApproval(summary, metadata = {}) {
    const item = this.startItem("approval", { status: "waiting", title: "Approval needed", detail: summary, metadata });
    const turn = this.activeTurn();
    turn.status = "waiting";
    this.emit("approval/requested", { turnId: turn.id, item: clone(item) });
    return item;
  }

  resolveApproval(itemId, approved) {
    const turn = this.activeTurn();
    const item = turn?.items.find((entry) => entry.id === itemId && entry.type === "approval");
    if (!item) return null;
    item.status = approved ? "completed" : "failed";
    item.detail = approved ? "Approved" : "Denied";
    item.completedAt = Date.now();
    turn.status = approved ? "in_progress" : "waiting";
    this.emit("approval/resolved", { turnId: turn.id, item: clone(item), approved: !!approved });
    return item;
  }

  completeTurn(message = "") {
    const turn = this.activeTurn();
    if (!turn) return null;
    turn.status = "completed";
    turn.completion = text(message, 4000);
    turn.completedAt = Date.now();
    this.emit("turn/completed", { turn: clone(turn) });
    return turn;
  }

  failTurn(error) {
    const turn = this.activeTurn();
    if (!turn) return null;
    turn.status = "failed";
    turn.error = text(error, 1200);
    turn.completedAt = Date.now();
    this.emit("turn/completed", { turn: clone(turn) });
    return turn;
  }

  interruptTurn(reason = "Interrupted by the user.") {
    const turn = this.activeTurn();
    if (!turn) return null;
    turn.status = "interrupted";
    turn.error = text(reason, 1200);
    turn.completedAt = Date.now();
    this.emit("turn/completed", { turn: clone(turn) });
    return turn;
  }

  snapshot() { return { version: 1, sequence: this.sequence, thread: clone(this.thread) }; }
  publicSnapshot() {
    const turn = this.thread.turns.at(-1) || null;
    return { threadId: this.thread.id, turn: turn ? clone(turn) : null, sequence: this.sequence };
  }
}

export function createCodexOrchestrator(options) { return new CodexOrchestrator(options); }
