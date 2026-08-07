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
    try { child = spawn("git", args, { cwd, windowsHide: true }); }
    catch (error) { resolve({ code: -1, output: error.message }); return; }
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    child.stderr.on("data", (data) => { output += data.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} output += "\n[timed out]"; }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim() }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }); });
  });
}

function readRuns() { try { const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")); return Array.isArray(parsed.runs) ? parsed.runs : []; } catch { return []; } }
function writeRuns(runs) { fs.mkdirSync(SAZ_DIR, { recursive: true }); const temp = RUNS_FILE + ".tmp"; fs.writeFileSync(temp, JSON.stringify({ version: 1, runs }, null, 2)); fs.renameSync(temp, RUNS_FILE); }
function saveRun(run) { const runs = readRuns().filter((item) => item.id !== run.id); runs.unshift(run); writeRuns(runs.slice(0, 100)); return run; }
function safeSlug(value, fallback = "task") { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || fallback; }

export async function isGitRepository(directory) {
  if (!directory || !fs.existsSync(directory)) return false;
  const result = await execGit(directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.output.trim() === "true";
}

export async function createIsolatedAgentRun(projectDir, task, index = 0) {
  const root = path.resolve(String(projectDir || ""));
  if (!await isGitRepository(root)) throw new Error("isolated agents require a Git project; initialize Git or use shared isolation");
  const status = await execGit(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect the main project");
  if (status.output.trim()) throw new Error("the main project has tracked uncommitted changes; commit or stash them before starting isolated agents so every agent sees the current project");
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

export async function applyAgentRun(id, targetDir) {
  const run = readRuns().find((item) => item.id === id);
  if (!run) throw new Error(`unknown isolated agent run '${id}'`);
  if (!run.commit) throw new Error(`agent run '${id}' did not produce file changes`);
  const target = path.resolve(String(targetDir || run.projectDir));
  if (target !== path.resolve(run.projectDir)) throw new Error("agent result belongs to a different project");
  const status = await execGit(target, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new Error(status.output || "could not inspect target project");
  if (status.output.trim()) throw new Error("the main project has uncommitted changes; commit or stash them before applying an agent result");
  const applied = await execGit(target, ["cherry-pick", run.commit], 120000);
  if (applied.code !== 0) { await execGit(target, ["cherry-pick", "--abort"]); throw new Error(`agent result conflicted and was not applied: ${applied.output}`); }
  if (fs.existsSync(run.workspaceDir)) {
    const removed = await execGit(run.projectDir, ["worktree", "remove", "--force", run.workspaceDir], 120000);
    if (removed.code !== 0) throw new Error(`agent result applied, but its worktree could not be cleaned up: ${removed.output}`);
  }
  if (run.branch) await execGit(run.projectDir, ["branch", "-D", run.branch]);
  const updated = { ...run, state: "applied", appliedAt: Date.now(), updatedAt: Date.now() };
  saveRun(updated); return updated;
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
