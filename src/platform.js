import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SAZ_DIR } from "./config.js";

const PLATFORM_HOME = process.env.BOOLEAN_PLATFORM_HOME ? path.resolve(process.env.BOOLEAN_PLATFORM_HOME) : SAZ_DIR;
const SKILLS_DIR = path.join(PLATFORM_HOME, "skills");
const AUTOMATIONS_FILE = path.join(PLATFORM_HOME, "automations.json");
const AUTOMATION_LOG = path.join(PLATFORM_HOME, "automation-runs.json");
const SANDBOX_DIR = path.join(PLATFORM_HOME, "sandboxes");

export const PLATFORM_TOOL_DEFINITIONS = [
  tool("github_workflow", "Inspect or operate the current GitHub repository through the authenticated GitHub CLI. Read operations are immediate; mutations require approval.", {
    operation: enumProp(["status", "issues", "issue_view", "pr_view", "pr_diff", "pr_checks", "run_logs", "pr_create", "issue_comment", "pr_comment"]),
    number: intProp("Issue, pull request, or workflow run number"),
    title: strProp("Pull request title"),
    body: strProp("Comment, issue, or pull request body"),
    base: strProp("Pull request base branch"),
    head: strProp("Pull request head branch")
  }, ["operation"]),
  tool("review_repository", "Review the current Git changes or repository for security and quality risks. Returns file-and-line findings and never changes files.", {
    scope: enumProp(["changes", "repository"]),
    profile: enumProp(["standard", "security"])
  }),
  tool("manage_skill", "List, inspect, install, or remove reusable Boolean skills. Skill installs are local folders containing skill.json and require approval.", {
    operation: enumProp(["list", "inspect", "install", "remove", "use", "run_hook"]),
    id: strProp("Skill id"),
    source: strProp("Absolute local skill folder to install"),
    event: strProp("Hook event name declared by the skill")
  }, ["operation"]),
  tool("manage_automation", "Create, edit, list, run, pause, resume, or remove durable scheduled reminders, AI prompts, page opens, commands, and webhooks.", {
    operation: enumProp(["list", "create", "update", "run", "pause", "resume", "remove"]),
    id: strProp("Automation id"),
    name: strProp("Short automation name"),
    schedule: enumProp(["once", "daily", "weekly", "monthly", "interval"]),
    runAt: strProp("ISO date/time for a one-time automation"),
    everyMinutes: intProp("Interval in minutes"),
    actionType: enumProp(["reminder", "prompt", "open_url", "command", "webhook"]),
    text: strProp("Reminder text or AI prompt"),
    threadId: strProp("Chat where a scheduled AI response should be saved"),
    noteId: strProp("Source notepad tab id"),
    noteTitle: strProp("Source notepad tab title"),
    command: strProp("PowerShell command"),
    url: strProp("HTTPS webhook URL"),
    method: enumProp(["GET", "POST"]),
    body: strProp("Optional webhook body"),
    cwd: strProp("Optional command working directory")
  }, ["operation"]),
  tool("create_artifact", "Create a real DOCX, XLSX, PPTX, or PDF file locally using Boolean's dependency-free artifact writer.", {
    type: enumProp(["docx", "xlsx", "pptx", "pdf"]),
    path: strProp("Output file path"),
    title: strProp("Artifact title"),
    content: strProp("Document text. For XLSX use tab-separated rows; for PPTX separate slides with a line containing ---")
  }, ["type", "path", "content"]),
  tool("generate_image", "Generate or edit an image with the image API connection selected in Settings, save it locally, and attach a preview. This may incur provider charges.", {
    prompt: strProp("Image prompt"),
    path: strProp("Output PNG path"),
    source: strProp("Optional existing image path to edit"),
    model: strProp("Image model; defaults to gpt-image-1"),
    size: strProp("Requested size, for example 1024x1024")
  }, ["prompt", "path"]),
  tool("run_guarded", "Run a command in a disposable copied workspace with a timeout and capped output. This is filesystem isolation, not a hardened virtual machine.", {
    command: strProp("PowerShell command to run"),
    source: strProp("Folder to copy into the guarded workspace; defaults to the current project"),
    timeoutSeconds: intProp("Maximum runtime, 1-600 seconds"),
    allowNetwork: boolProp("Allow obvious network-capable commands. Default false."),
    keep: boolProp("Keep the guarded workspace after the run")
  }, ["command"])
];

export const PLATFORM_TOOL_NAMES = new Set(PLATFORM_TOOL_DEFINITIONS.map((item) => item.function.name));

function tool(name, description, properties, required = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
function strProp(description) { return { type: "string", description }; }
function intProp(description) { return { type: "integer", description }; }
function boolProp(description) { return { type: "boolean", description }; }
function enumProp(values) { return { type: "string", enum: values }; }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function runProcess(command, args, { cwd = process.cwd(), timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, env, windowsHide: true }); }
    catch (error) { resolve({ code: -1, output: error.message }); return; }
    let output = "";
    const append = (data) => { output = (output + data.toString()).slice(-120000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* best effort */ } }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: output.trim() }); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }); });
  });
}

function projectDir(ctx) {
  return path.resolve(ctx.projectDir || ctx.config?.projectsDir || process.cwd());
}

async function githubWorkflow(args, ctx) {
  const operation = String(args.operation || "status");
  const cwd = projectDir(ctx);
  const commands = {
    status: ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"],
    issues: ["issue", "list", "--limit", "30"],
    issue_view: ["issue", "view", String(args.number || "")],
    pr_view: ["pr", "view", String(args.number || ""), "--comments"],
    pr_diff: ["pr", "diff", String(args.number || "")],
    pr_checks: ["pr", "checks", String(args.number || "")],
    run_logs: ["run", "view", String(args.number || ""), "--log-failed"]
  };
  let command = commands[operation];
  const mutating = ["pr_create", "issue_comment", "pr_comment"].includes(operation);
  if (operation === "pr_create") {
    command = ["pr", "create", "--title", String(args.title || ""), "--body", String(args.body || "")];
    if (args.base) command.push("--base", String(args.base));
    if (args.head) command.push("--head", String(args.head));
  } else if (operation === "issue_comment") {
    command = ["issue", "comment", String(args.number || ""), "--body", String(args.body || "")];
  } else if (operation === "pr_comment") {
    command = ["pr", "comment", String(args.number || ""), "--body", String(args.body || "")];
  }
  if (!command) throw new Error(`unsupported GitHub operation '${operation}'`);
  if (mutating && !await ctx.approve(`GitHub ${operation.replace(/_/g, " ")}`)) return "user declined GitHub change";
  const result = await runProcess("gh", command, { cwd });
  if (result.code !== 0) throw new Error(result.output || "GitHub CLI failed. Install gh and sign in with 'gh auth login'.");
  return result.output || "GitHub operation completed.";
}

export async function ghStatus(ctx) {
  const cwd = projectDir(ctx);
  const authResult = await runProcess("gh", ["auth", "status", "--show-token"], { cwd, timeoutMs: 10000 });
  const authenticated = authResult.code === 0;
  let repo = null;
  if (authenticated) {
    const repoResult = await runProcess("gh", ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"], { cwd, timeoutMs: 10000 });
    if (repoResult.code === 0) {
      try { repo = JSON.parse(repoResult.output); } catch { /* not a repo */ }
    }
  }
  let user = null;
  if (authenticated) {
    const userResult = await runProcess("gh", ["api", "user", "--jq", ".login"], { cwd, timeoutMs: 10000 });
    if (userResult.code === 0) user = userResult.output.trim();
  }
  return { installed: true, authenticated, user, repo, raw: authenticated ? "" : authResult.output };
}

const REVIEW_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".cs", ".java", ".go", ".rs", ".php", ".rb", ".ps1", ".html"]);
const REVIEW_RULES = [
  { severity: "high", label: "Possible embedded secret", regex: /\b(api[_-]?key|client[_-]?secret|access[_-]?token|password)\b\s*[:=]\s*["'][^"']{12,}/i },
  { severity: "high", label: "Dynamic code execution", regex: /\b(eval|new Function)\s*\(/ },
  { severity: "medium", label: "Shell command execution", regex: /\b(exec|execSync|spawn|Start-Process|Invoke-Expression)\b/ },
  { severity: "medium", label: "Potentially unsafe HTML insertion", regex: /\b(innerHTML|outerHTML)\s*=/ },
  { severity: "medium", label: "Disabled TLS verification", regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false/i },
  { severity: "low", label: "Broad exception suppression", regex: /catch\s*\([^)]*\)\s*\{\s*\}|catch\s*\{\s*\}/ }
];

function walkFiles(root, limit = 3000) {
  const files = [];
  const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".saz"]);
  const visit = (dir) => {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit || ignored.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && REVIEW_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(target);
    }
  };
  visit(root);
  return files;
}

async function reviewRepository(args, ctx) {
  const root = projectDir(ctx);
  let files = walkFiles(root);
  if (args.scope !== "repository") {
    const changed = await runProcess("git", ["diff", "--name-only", "HEAD"], { cwd: root });
    if (changed.code === 0 && changed.output) {
      const names = new Set(changed.output.split(/\r?\n/).map((name) => path.resolve(root, name)));
      files = files.filter((file) => names.has(path.resolve(file)));
    }
  }
  const findings = [];
  for (const file of files) {
    let text = "";
    try { if (fs.statSync(file).size <= 2_000_000) text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of REVIEW_RULES) if (rule.regex.test(line)) findings.push({
        severity: rule.severity, file: path.relative(root, file), line: index + 1, finding: rule.label,
        evidence: line.trim().slice(0, 180)
      });
    });
  }
  findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity]) - ({ high: 0, medium: 1, low: 2 }[b.severity]));
  return JSON.stringify({ root, filesReviewed: files.length, profile: args.profile || "standard", findings: findings.slice(0, 200) }, null, 2);
}

function validateSkillManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("skill.json must contain an object");
  const id = String(manifest.id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error("skill id must use 2-64 lowercase letters, numbers, dots, underscores, or hyphens");
  if (!String(manifest.name || "").trim()) throw new Error("skill name is required");
  if (!String(manifest.instructions || "").trim()) throw new Error("skill instructions are required");
  return { version: 1, ...manifest, id, name: String(manifest.name).trim(), instructions: String(manifest.instructions).trim(), permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [] };
}

export function installedSkills() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((item) => item.isDirectory()).flatMap((item) => {
    try { return [validateSkillManifest(readJson(path.join(SKILLS_DIR, item.name, "skill.json"), null))]; } catch { return []; }
  });
}

export async function manageSkill(args, ctx) {
  const operation = String(args.operation || "list");
  const skills = installedSkills();
  if (operation === "list") return JSON.stringify(skills.map(({ id, name, version, description, permissions }) => ({ id, name, version, description: description || "", permissions })), null, 2);
  const id = String(args.id || "").trim().toLowerCase();
  if (operation === "inspect" || operation === "use") {
    const skill = skills.find((item) => item.id === id);
    if (!skill) throw new Error(`skill '${id}' is not installed`);
    return operation === "use" ? `ACTIVE SKILL: ${skill.name}\nPermissions: ${skill.permissions.join(", ") || "none"}\n\n${skill.instructions}` : JSON.stringify(skill, null, 2);
  }
  if (operation === "install") {
    const source = path.resolve(String(args.source || ""));
    const manifest = validateSkillManifest(readJson(path.join(source, "skill.json"), null));
    if (!await ctx.approve(`install local skill '${manifest.name}' with permissions: ${manifest.permissions.join(", ") || "none"}`)) return "user declined skill installation";
    const destination = path.join(SKILLS_DIR, manifest.id);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, filter: (item) => !item.includes(`${path.sep}.git${path.sep}`) });
    return `Installed skill ${manifest.name} (${manifest.id}) version ${manifest.version || 1}.`;
  }
  if (operation === "remove") {
    if (!await ctx.approve(`remove skill '${id}'`)) return "user declined skill removal";
    fs.rmSync(path.join(SKILLS_DIR, id), { recursive: true, force: true });
    return `Removed skill ${id}.`;
  }
  if (operation === "run_hook") {
    const skill = skills.find((item) => item.id === id);
    if (!skill) throw new Error(`skill '${id}' is not installed`);
    const event = String(args.event || "").trim();
    const command = skill.hooks && typeof skill.hooks === "object" ? String(skill.hooks[event] || "").trim() : "";
    if (!event || !command) throw new Error(`skill '${id}' does not declare hook '${event}'`);
    if (!await ctx.approve(`run '${event}' hook from skill '${skill.name}'`)) return "user declined skill hook";
    const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: path.join(SKILLS_DIR, id), timeoutMs: 120000 });
    return `Exit ${result.code}\n${result.output}`;
  }
  throw new Error(`unsupported skill operation '${operation}'`);
}

function automationStore() {
  const data = readJson(AUTOMATIONS_FILE, { version: 1, automations: [] });
  return Array.isArray(data.automations) ? data.automations : [];
}
function saveAutomations(automations) { atomicWrite(AUTOMATIONS_FILE, { version: 1, automations }); }
export function nextRunFor(item, from = Date.now()) {
  if (item.schedule === "interval") return from + Math.max(1, Number(item.everyMinutes || 1)) * 60000;
  const base = new Date(item.runAt).getTime();
  if (!Number.isFinite(base)) return NaN;
  if (item.schedule === "once" || base > from) return base;
  const next = new Date(base);
  const bump = () => {
    if (item.schedule === "daily") next.setDate(next.getDate() + 1);
    else if (item.schedule === "weekly") next.setDate(next.getDate() + 7);
    else if (item.schedule === "monthly") next.setMonth(next.getMonth() + 1);
    else return false;
    return true;
  };
  let guard = 0;
  while (next.getTime() <= from && guard++ < 5000) if (!bump()) break;
  return next.getTime();
}

let automationActionHandler = null;
export function setAutomationActionHandler(handler) {
  automationActionHandler = typeof handler === "function" ? handler : null;
}

async function executeAutomation(item) {
  const startedAt = Date.now();
  let result;
  try {
    if (item.actionType === "command") {
      result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", item.command], { cwd: item.cwd || os.homedir(), timeoutMs: 10 * 60 * 1000 });
    } else if (item.actionType === "webhook") {
      const response = await fetch(item.url, { method: item.method || "POST", headers: item.body ? { "content-type": "application/json" } : {}, body: item.method === "GET" ? undefined : item.body || undefined, signal: AbortSignal.timeout(120000) });
      result = { code: response.ok ? 0 : response.status, output: (await response.text()).slice(0, 120000) };
    } else if (automationActionHandler) {
      result = await automationActionHandler(item);
    } else {
      result = { code: 1, output: `No app handler is available for ${item.actionType}.` };
    }
  } catch (error) {
    result = { code: 1, output: error?.message || String(error) };
  }
  result = result && typeof result === "object" ? result : { code: 0, output: String(result || "") };
  const runs = readJson(AUTOMATION_LOG, { version: 1, runs: [] }).runs || [];
  runs.unshift({ id: crypto.randomUUID(), automationId: item.id, name: item.name, actionType: item.actionType, startedAt, finishedAt: Date.now(), code: Number(result.code || 0), output: String(result.output || "").slice(0, 120000), threadId: String(result.threadId || item.threadId || ""), url: String(result.url || item.url || "") });
  atomicWrite(AUTOMATION_LOG, { version: 1, runs: runs.slice(0, 200) });
  return result;
}

export async function runDueAutomations(now = Date.now()) {
  const automations = automationStore();
  const due = automations.filter((item) => item.enabled && !item.running && Number(item.nextRunAt) <= now);
  for (const item of due) {
    item.running = true;
    saveAutomations(automations);
    try {
      const result = await executeAutomation(item);
      item.lastError = Number(result.code || 0) === 0 ? "" : String(result.output || "Scheduled task failed.").slice(0, 2000);
    }
    catch (error) { item.lastError = error.message; }
    item.lastRunAt = Date.now();
    item.running = false;
    if (item.schedule === "once") item.enabled = false;
    else item.nextRunAt = nextRunFor(item, Date.now());
    saveAutomations(automations);
  }
  return due.length;
}

let automationTimer = null;
export function startAutomationScheduler() {
  if (automationTimer) return automationTimer;
  automationTimer = setInterval(() => { runDueAutomations().catch(() => {}); }, 30000);
  automationTimer.unref?.();
  runDueAutomations().catch(() => {});
  return automationTimer;
}

export async function manageAutomation(args, ctx) {
  const operation = String(args.operation || "list");
  const automations = automationStore();
  if (operation === "list") return JSON.stringify({ automations, recentRuns: (readJson(AUTOMATION_LOG, { runs: [] }).runs || []).slice(0, 20) }, null, 2);
  if (operation === "create") {
    const allowedActions = new Set(["reminder", "prompt", "agent", "open_url", "command", "webhook"]);
    const actionType = allowedActions.has(args.actionType) ? args.actionType : "reminder";
    if (actionType === "command" && !String(args.command || "").trim()) throw new Error("command is required");
    if (actionType === "webhook" && !/^https:\/\//i.test(String(args.url || ""))) throw new Error("an HTTPS webhook URL is required");
    if (actionType === "open_url" && !/^https?:\/\//i.test(String(args.url || ""))) throw new Error("an http(s) page URL is required");
    if (["reminder", "prompt", "agent"].includes(actionType) && !String(args.text || "").trim()) throw new Error("task text is required");
    const allowedSchedules = new Set(["once", "daily", "weekly", "monthly", "interval"]);
    const schedule = allowedSchedules.has(args.schedule) ? args.schedule : "once";
    const item = { id: crypto.randomUUID(), name: String(args.name || "Scheduled task").trim(), schedule, runAt: args.runAt || "", everyMinutes: Number(args.everyMinutes || 0), actionType, text: String(args.text || ""), threadId: String(args.threadId || ""), noteId: String(args.noteId || ""), noteTitle: String(args.noteTitle || ""), provider: String(args.provider || ""), model: String(args.model || ""), autoApprove: args.autoApprove === true, command: String(args.command || ""), url: String(args.url || ""), method: args.method === "GET" ? "GET" : "POST", body: String(args.body || ""), cwd: String(args.cwd || ctx.projectDir || os.homedir()), enabled: true, running: false, createdAt: Date.now() };
    item.nextRunAt = nextRunFor(item);
    if (!Number.isFinite(item.nextRunAt) || item.nextRunAt <= 0) throw new Error("enter a valid run time or interval");
    if (!await ctx.approve(`create scheduled automation '${item.name}' (${item.actionType})`)) return "user declined automation";
    automations.push(item); saveAutomations(automations); return JSON.stringify(item, null, 2);
  }
  const item = automations.find((entry) => entry.id === String(args.id || ""));
  if (!item) throw new Error(`automation '${args.id}' was not found`);
  if (operation === "update") {
    const patch = { ...args }; delete patch.operation; delete patch.id;
    const allowed = ["name", "schedule", "runAt", "everyMinutes", "actionType", "text", "threadId", "noteId", "noteTitle", "provider", "model", "autoApprove", "command", "url", "method", "body", "cwd"];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) {
      item[key] = key === "everyMinutes" ? Number(patch[key] || 0) : key === "autoApprove" ? patch[key] === true : String(patch[key] || "");
    }
    if (!["once", "daily", "weekly", "monthly", "interval"].includes(item.schedule)) throw new Error("unsupported schedule");
    if (!["reminder", "prompt", "agent", "open_url", "command", "webhook"].includes(item.actionType)) throw new Error("unsupported action type");
    if (item.actionType === "command" && !item.command.trim()) throw new Error("command is required");
    if (item.actionType === "webhook" && !/^https:\/\//i.test(item.url)) throw new Error("an HTTPS webhook URL is required");
    if (item.actionType === "open_url" && !/^https?:\/\//i.test(item.url)) throw new Error("an http(s) page URL is required");
    if (["reminder", "prompt", "agent"].includes(item.actionType) && !item.text.trim()) throw new Error("task text is required");
    if (!await ctx.approve(`update scheduled automation '${item.name}'`)) return "user declined automation update";
    item.nextRunAt = nextRunFor(item, Date.now());
    item.updatedAt = Date.now();
    if (!Number.isFinite(item.nextRunAt) || item.nextRunAt <= 0) throw new Error("enter a valid run time or interval");
    saveAutomations(automations);
    return JSON.stringify(item, null, 2);
  }
  if (operation === "run") {
    if (!await ctx.approve(`run automation '${item.name}' now`)) return "user declined automation run";
    const result = await executeAutomation(item); return `Exit ${result.code}\n${result.output}`;
  }
  if (operation === "remove") {
    if (!await ctx.approve(`remove automation '${item.name}'`)) return "user declined automation removal";
    saveAutomations(automations.filter((entry) => entry.id !== item.id)); return `Removed automation ${item.name}.`;
  }
  item.enabled = operation === "resume";
  if (item.enabled) item.nextRunAt = nextRunFor(item, Date.now());
  saveAutomations(automations);
  return `${item.name} ${item.enabled ? "resumed" : "paused"}.`;
}

function xmlEscape(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name.replace(/\\/g, "/"));
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBuffer.length, 26);
    local.push(header, nameBuffer, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(nameBuffer.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer); offset += header.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function officeEntries(type, title, content) {
  const lines = String(content).split(/\r?\n/);
  const rootRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${type === "docx" ? "word/document.xml" : type === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml"}"/></Relationships>`;
  if (type === "docx") return [
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", rootRels],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[title, ...lines].filter(Boolean).map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`]
  ];
  if (type === "xlsx") {
    const rows = lines.map((line, row) => `<row r="${row + 1}">${line.split("\t").map((cell, column) => `<c r="${String.fromCharCode(65 + column)}${row + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join("")}</row>`).join("");
    return [
      ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`], ["_rels/.rels", rootRels],
      ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(title || "Sheet1")}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`]
    ];
  }
  const slides = String(content).split(/^---\s*$/m).map((slide) => slide.trim()).filter(Boolean);
  const overrides = slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const slideList = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("");
  const slideRels = slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  const slideEntries = slides.map((slide, index) => [
    `ppt/slides/slide${index + 1}.xml`,
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="600000"/><a:ext cx="10800000" cy="5600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${slide.split(/\r?\n/).map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  ]);
  return [
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides}</Types>`],
    ["_rels/.rels", rootRels],
    ["ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slideList}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels}</Relationships>`],
    ...slideEntries
  ];
}

function simplePdf(title, content) {
  const escape = (value) => String(value).replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  const lines = [title, ...String(content).split(/\r?\n/)].filter(Boolean).slice(0, 55);
  const stream = `BT /F1 12 Tf 54 760 Td 15 TL ${lines.map((line, index) => `${index ? "T* " : ""}(${escape(line.slice(0, 100))}) Tj`).join(" ")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

async function createArtifact(args, ctx) {
  const type = String(args.type || "").toLowerCase();
  const output = path.resolve(String(args.path || path.join(projectDir(ctx), `artifact.${type}`)));
  if (path.extname(output).toLowerCase() !== `.${type}`) throw new Error(`output path must end in .${type}`);
  if (!await ctx.approve(`create ${type.toUpperCase()} artifact ${output}`)) return "user declined artifact creation";
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, type === "pdf" ? simplePdf(args.title || "", args.content) : zipStore(officeEntries(type, args.title || "", args.content)));
  const data = fs.readFileSync(output);
  const valid = type === "pdf" ? data.subarray(0, 5).toString() === "%PDF-" : data.readUInt32LE(0) === 0x04034b50;
  if (!valid) throw new Error(`artifact verification failed for ${output}`);
  return `Created and verified ${type.toUpperCase()} artifact: ${output} (${data.length} bytes)`;
}

async function generateImage(args, ctx) {
  const settings = ctx.config?.imageGeneration || {};
  const selected = String(settings.provider || "openai");
  const saved = (ctx.config?.connectors?.apis || []).find((item) => item.id === selected && item.enabled !== false);
  const provider = saved?.apiKey ? saved :
    selected === "customApi" && ctx.config?.customApi?.apiKey ? ctx.config.customApi :
    selected === "openai" && ctx.config?.openai?.apiKey ? ctx.config.openai : null;
  if (!provider) throw new Error("Choose an image API connection with a saved key in Settings > Creation & research.");
  const source = args.source ? path.resolve(String(args.source)) : "";
  if (source && (!fs.existsSync(source) || !fs.statSync(source).isFile())) throw new Error(`source image was not found: ${source}`);
  const model = String(args.model || settings.model || "gpt-image-1");
  const size = String(args.size || settings.size || "1024x1024");
  if (!await ctx.approve(`${source ? "edit" : "generate"} an image with ${model}; provider charges may apply`)) return "user declined image operation";
  const base = String(provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  let response;
  if (source) {
    const form = new FormData();
    form.set("model", model); form.set("prompt", args.prompt); form.set("size", size);
    form.set("image", new Blob([fs.readFileSync(source)]), path.basename(source));
    response = await fetch(`${base}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}` }, body: form, signal: AbortSignal.timeout(180000) });
  } else {
    response = await fetch(`${base}/images/generations`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, prompt: args.prompt, size, response_format: "b64_json" }), signal: AbortSignal.timeout(180000) });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `image provider returned HTTP ${response.status}`);
  const item = data.data?.[0];
  let buffer;
  if (item?.b64_json) buffer = Buffer.from(item.b64_json, "base64");
  else if (item?.url) { const image = await fetch(item.url); if (!image.ok) throw new Error("could not download generated image"); buffer = Buffer.from(await image.arrayBuffer()); }
  else throw new Error("image provider returned no image");
  const output = path.resolve(String(args.path)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, buffer);
  ctx.onImage?.(`data:image/png;base64,${buffer.toString("base64")}`, path.basename(output));
  return `${source ? "Edited" : "Generated"} image: ${output} (${buffer.length} bytes)`;
}

function copyGuardedSource(source, destination) {
  const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
  fs.cpSync(source, destination, { recursive: true, filter: (item) => !item.split(path.sep).some((part) => ignored.has(part)) });
}

function listWorkspaceFiles(root, limit = 500) {
  const files = [];
  const visit = (dir) => {
    if (files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit || entry.name === ".tmp") continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

async function runGuarded(args, ctx) {
  const command = String(args.command || "").trim();
  if (!args.allowNetwork && /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|git\s+(clone|pull|fetch|push)|npm\s+(install|publish)|winget|ssh|scp)\b/i.test(command)) throw new Error("network-capable command blocked; set allowNetwork only when the user explicitly requests network access");
  if (!await ctx.approve(`run guarded command in a disposable workspace: ${command.slice(0, 160)}`)) return "user declined guarded execution";
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const workspace = path.join(SANDBOX_DIR, id);
  fs.mkdirSync(workspace, { recursive: true });
  const source = path.resolve(String(args.source || ctx.projectDir || ""));
  if (source && fs.existsSync(source) && fs.statSync(source).isDirectory()) copyGuardedSource(source, workspace);
  const env = { SystemRoot: process.env.SystemRoot || "C:\\Windows", WINDIR: process.env.WINDIR || "C:\\Windows", TEMP: path.join(workspace, ".tmp"), TMP: path.join(workspace, ".tmp"), USERPROFILE: workspace, BOOLEAN_GUARDED: "1", PATH: process.env.PATH || "" };
  fs.mkdirSync(env.TEMP, { recursive: true });
  const timeoutMs = Math.max(1, Math.min(600, Number(args.timeoutSeconds || 120))) * 1000;
  const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: workspace, timeoutMs, env });
  const changed = listWorkspaceFiles(workspace, 500).map((file) => path.relative(workspace, file));
  if (!args.keep) fs.rmSync(workspace, { recursive: true, force: true });
  return JSON.stringify({ exitCode: result.code, output: result.output, workspace: args.keep ? workspace : "removed", files: changed.slice(0, 200), isolation: "disposable filesystem copy; not an OS security boundary" }, null, 2);
}

export async function executePlatformTool(name, args, ctx) {
  if (name === "github_workflow") return await githubWorkflow(args, ctx);
  if (name === "review_repository") return await reviewRepository(args, ctx);
  if (name === "manage_skill") return await manageSkill(args, ctx);
  if (name === "manage_automation") return await manageAutomation(args, ctx);
  if (name === "create_artifact") return await createArtifact(args, ctx);
  if (name === "generate_image") return await generateImage(args, ctx);
  if (name === "run_guarded") return await runGuarded(args, ctx);
  throw new Error(`unknown platform tool '${name}'`);
}
