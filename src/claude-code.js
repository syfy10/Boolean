import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { gitDiffFiles } from "./git-review.js";

const MAX_OUTPUT = 64 * 1024;
const SNAPSHOT_FILE_LIMIT = 20_000;
const SNAPSHOT_CONTENT_LIMIT = 1024 * 1024;
const SNAPSHOT_SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", ".cache", "coverage"]);
const SAFE_TOOLS = [
  "Read", "Glob", "Grep", "LS",
  "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
  "Bash(node --check *)", "Bash(npm test)", "Bash(npm test *)", "Bash(npm run test *)",
  "Bash(npm run build *)", "Bash(npx tsc *)",
  "PowerShell(Test-Path *)", "PowerShell(Get-ChildItem *)", "PowerShell(git status *)",
  "PowerShell(git diff *)", "PowerShell(node --check *)", "PowerShell(npm test)",
  "PowerShell(npm test *)", "PowerShell(npm run test *)", "PowerShell(npm run build *)"
];

function bounded(value, max = MAX_OUTPUT) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}

function commandCandidates(command = "claude", { env = process.env, platform = process.platform } = {}) {
  const saved = String(command || "claude").trim() || "claude";
  const rows = [saved];
  if (platform === "win32") {
    const profile = env.USERPROFILE || os.homedir();
    const localAppData = env.LOCALAPPDATA || path.join(profile, "AppData", "Local");
    const roamingAppData = env.APPDATA || path.join(profile, "AppData", "Roaming");
    rows.push(
      path.join(profile, ".local", "bin", "claude.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe")
    );
    const wingetPackages = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(wingetPackages, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Anthropic\.ClaudeCode_/i.test(entry.name)) {
          rows.push(path.join(wingetPackages, entry.name, "claude.exe"));
        }
      }
    } catch {}
    const versionRoot = path.join(roamingAppData, "Claude", "claude-code");
    try {
      const versions = fs.readdirSync(versionRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) rows.push(path.join(versionRoot, version, "claude.exe"));
    } catch {}
    try {
      const result = spawnSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true, timeout: 3000, env });
      if (result.status === 0) rows.push(...String(result.stdout || "").split(/\r?\n/));
    } catch {}
  }
  return [...new Set(rows.map((row) => String(row || "").trim()).filter(Boolean))];
}

function verifyCommand(command, { spawnSyncImpl = spawnSync, env = process.env } = {}) {
  try {
    const result = spawnSyncImpl(command, ["--version"], {
      encoding: "utf8", windowsHide: true, timeout: 8000, env
    });
    if (!result.error && result.status === 0) {
      return { ready: true, command, version: bounded(result.stdout || result.stderr, 500).trim() };
    }
  } catch {}
  return null;
}

export function resolveClaudeCodeLaunch(command = "claude", options = {}) {
  for (const candidate of commandCandidates(command, options)) {
    const explicit = path.isAbsolute(candidate) || /[\\/]/.test(candidate);
    if (explicit && !fs.existsSync(candidate)) continue;
    const verified = verifyCommand(candidate, options);
    if (verified) return verified;
  }
  return {
    ready: false,
    command: String(command || "claude").trim() || "claude",
    version: "",
    error: "Claude Code CLI was not found. Use Set up Claude Code below."
  };
}

export function readClaudeCodeStatus(command = "claude", options = {}) {
  const launch = resolveClaudeCodeLaunch(command, options);
  if (!launch.ready) return { ...launch, installed: false, signedIn: false, account: null };
  try {
    const result = (options.spawnSyncImpl || spawnSync)(launch.command, ["auth", "status"], {
      encoding: "utf8", windowsHide: true, timeout: 10000, env: options.env || process.env
    });
    const raw = bounded(result.stdout || result.stderr, 8000).trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const signedIn = result.status === 0 && (parsed?.loggedIn === true || parsed?.authenticated === true || /logged in|authenticated/i.test(raw));
    return {
      ...launch,
      installed: true,
      signedIn,
      account: signedIn ? {
        email: String(parsed?.email || parsed?.account?.email || "").slice(0, 320),
        organization: String(parsed?.organizationName || parsed?.organization || "").slice(0, 200),
        authMethod: String(parsed?.authMethod || parsed?.subscriptionType || "Claude account").slice(0, 120)
      } : null,
      authOutput: signedIn ? "" : raw,
      error: signedIn ? "" : "Claude Code is installed but not signed in."
    };
  } catch (error) {
    return { ...launch, installed: true, signedIn: false, account: null, error: `Could not check Claude Code sign-in: ${error?.message || error}` };
  }
}

function runProcess(command, args, { spawnImpl = spawn, env = process.env, timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child;
    try {
      child = spawnImpl(command, args, { env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, error, output: "" });
      return;
    }
    const append = (chunk) => { output = bounded(output + String(chunk || "")); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, error, output });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null, new Error("Claude Code setup timed out."));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function installClaudeCode({ platform = process.platform, spawnImpl = spawn, spawnSyncImpl = spawnSync, env = process.env } = {}) {
  if (platform !== "win32") {
    return { ok: false, error: "unsupported_platform", message: "Automatic Claude Code setup is currently available on Windows only." };
  }
  // Anthropic recommends the native installer on Windows. It installs per-user,
  // requires no administrator rights, and keeps itself updated.
  const native = await runProcess("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "$ProgressPreference='SilentlyContinue'; Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression"
  ], { spawnImpl, env });
  let launch = resolveClaudeCodeLaunch("claude", { env, platform, spawnSyncImpl });
  if (native.status === 0 && launch.ready) {
    return { ok: true, installed: true, command: launch.command, version: launch.version, method: "native", message: "Claude Code installed. Complete the Claude sign-in to continue." };
  }

  // Restricted networks sometimes block the native download host while WinGet
  // remains available. Use the official package as an automatic fallback.
  const winget = await runProcess("winget.exe", [
    "install", "--id", "Anthropic.ClaudeCode", "--exact", "--silent",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
  ], { spawnImpl, env });
  launch = resolveClaudeCodeLaunch("claude", { env, platform, spawnSyncImpl });
  if (winget.status === 0 && launch.ready) {
    return { ok: true, installed: true, command: launch.command, version: launch.version, method: "winget", message: "Claude Code installed. Complete the Claude sign-in to continue." };
  }
  return {
    ok: false,
    error: launch.ready ? "install_failed" : "install_not_found",
    message: "Claude Code setup could not finish with either the native installer or WinGet. Check internet access and Windows app-install policies, then try again.",
    output: bounded(`Native installer:\n${native.output || native.error?.message || "failed"}\nWinGet:\n${winget.output || winget.error?.message || "failed"}`)
  };
}

export function startClaudeCodeLogin(command = "claude", { spawnImpl = spawn, spawnSyncImpl = spawnSync, env = process.env, platform = process.platform } = {}) {
  const launch = resolveClaudeCodeLaunch(command, { env, platform, spawnSyncImpl });
  if (!launch.ready) return { ok: false, error: "not_installed", message: launch.error };
  try {
    if (platform === "win32") {
      const escaped = launch.command.replace(/'/g, "''");
      const script = `& '${escaped}' auth login; if ($LASTEXITCODE -eq 0) { Write-Host 'Claude Code sign-in complete. You can close this window.' -ForegroundColor Green } else { Write-Host 'Claude Code sign-in did not finish. Keep this window open and try again.' -ForegroundColor Yellow }`;
      // Encode the complete inner command so Start-Process cannot lose quotes
      // around a versioned WinGet path. The short wrapper stays hidden while
      // the authentication terminal it creates is deliberately visible.
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const opener = `Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoExit -NoProfile -EncodedCommand ${encoded}' -WindowStyle Normal`;
      const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", opener], { detached: true, windowsHide: true, stdio: "ignore", env });
      child.unref?.();
    } else {
      const child = spawnImpl(launch.command, ["auth", "login"], { detached: true, stdio: "inherit", env });
      child.unref?.();
    }
    return { ok: true, command: launch.command, message: "Claude Code sign-in opened in a terminal. Finish there, then press Check connection." };
  } catch (error) {
    return { ok: false, error: "login_failed", message: `Claude Code sign-in could not start: ${error?.message || error}` };
  }
}

function changesMap(rows) {
  return new Map((rows || []).map((row) => [String(row.path || "").toLowerCase(), `${row.status}\n${row.diff || ""}`]));
}

function currentGitChanges(projectDir) {
  const result = gitDiffFiles(projectDir);
  return (result.files || []).map((row) => ({
    path: row.path,
    status: row.status,
    absolutePath: row.absolutePath || path.resolve(projectDir, row.path),
    diff: (row.lines || []).map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text || ""}`).join("\n")
  }));
}

function readableSnapshotContent(buffer) {
  if (!buffer || buffer.length > SNAPSHOT_CONTENT_LIMIT || buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function fileWorkspaceSnapshot(projectDir) {
  const rows = [];
  const walk = (folder) => {
    if (rows.length >= SNAPSHOT_FILE_LIMIT) return;
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (rows.length >= SNAPSHOT_FILE_LIMIT) break;
      if (entry.isDirectory() && SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      const absolutePath = path.join(folder, entry.name);
      if (entry.isDirectory()) { walk(absolutePath); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolutePath);
        const buffer = stat.size <= SNAPSHOT_CONTENT_LIMIT ? fs.readFileSync(absolutePath) : null;
        const relativePath = path.relative(projectDir, absolutePath).replace(/\\/g, "/");
        rows.push({
          path: relativePath,
          absolutePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          digest: buffer ? createHash("sha256").update(buffer).digest("hex") : `${stat.size}:${stat.mtimeMs}`,
          content: readableSnapshotContent(buffer)
        });
      } catch {}
    }
  };
  walk(projectDir);
  return rows;
}

function captureWorkspace(projectDir) {
  try { return { kind: "git", rows: currentGitChanges(projectDir) }; }
  catch { return { kind: "files", rows: fileWorkspaceSnapshot(projectDir) }; }
}

function textFileDiff(before, after, status) {
  const beforeText = before?.content;
  const afterText = after?.content;
  if (beforeText === null || afterText === null) return "Binary or large file changed.";
  if (status === "added") return String(afterText || "").split(/\r?\n/).map((line) => `+${line}`).join("\n");
  if (status === "deleted") return String(beforeText || "").split(/\r?\n/).map((line) => `-${line}`).join("\n");
  return `--- before\n${beforeText || ""}\n+++ after\n${afterText || ""}`;
}

function fileSnapshotDelta(before = [], after = [], projectDir = "") {
  const previous = new Map(before.map((row) => [row.path.toLowerCase(), row]));
  const current = new Map(after.map((row) => [row.path.toLowerCase(), row]));
  const keys = new Set([...previous.keys(), ...current.keys()]);
  const changed = [];
  for (const key of keys) {
    const oldRow = previous.get(key);
    const newRow = current.get(key);
    if (oldRow?.digest === newRow?.digest) continue;
    const status = !oldRow ? "added" : !newRow ? "deleted" : "modified";
    const row = newRow || oldRow;
    changed.push({
      path: row.path,
      absolutePath: row.absolutePath || path.resolve(projectDir, row.path),
      kind: status,
      status,
      exists: status !== "deleted",
      readable: status !== "deleted" && newRow?.content !== null,
      diff: bounded(textFileDiff(oldRow, newRow, status))
    });
  }
  return changed;
}

function verifiedWorkspaceDelta(before, after, projectDir) {
  if (before.kind === "git" && after.kind === "git") return actualChangeDelta(before.rows, after.rows);
  const baseline = before.kind === "files" ? before.rows : fileWorkspaceSnapshot(projectDir);
  const current = after.kind === "files" ? after.rows : fileWorkspaceSnapshot(projectDir);
  return fileSnapshotDelta(baseline, current, projectDir);
}

function normalizedUsage(usage, model) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens || usage.inputTokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || usage.outputTokens || 0);
  return { provider: "claude-code", model: model || "Claude Code", input, output, estimated: false };
}

function actualChangeDelta(before = [], after = []) {
  const baseline = changesMap(before);
  return after.filter((row) => baseline.get(String(row.path || "").toLowerCase()) !== `${row.status}\n${row.diff || ""}`)
    .map((row) => ({
      path: row.path,
      absolutePath: row.absolutePath || "",
      kind: row.status === "untracked" ? "added" : row.status === "deleted" ? "deleted" : "modified",
      status: row.status === "untracked" ? "added" : row.status,
      exists: row.status !== "deleted",
      readable: row.status !== "deleted" && !!row.absolutePath,
      diff: row.diff || ""
    }));
}

function promptWithChanges(input, changes = []) {
  if (!changes.length) return input;
  const rows = changes.slice(0, 12).map((row) => `- ${row.status}: ${row.absolutePath || row.path}\n${String(row.diff || "").slice(0, 3000)}`);
  return `${input}\n\n<verified_workspace_changes>\nThese are the exact current changes verified by Boolean. You may inspect them before continuing.\n${rows.join("\n")}\n</verified_workspace_changes>`;
}

export async function runClaudeCodeTurn({
  command = "claude", input = "", projectDir = "", workspaceChanges = [], mapping = {}, model = "",
  accessMode = "ask", maxTurns = 30, signal, onStatus = () => {}, onToken = () => {},
  onUsage = () => {}, onStep = () => {}, onMapping = () => {}, spawnImpl = spawn, spawnSyncImpl = spawnSync, env = process.env
} = {}) {
  const launch = resolveClaudeCodeLaunch(command, { env, spawnSyncImpl });
  if (!launch.ready) throw new Error(launch.error);
  const cwd = path.resolve(String(projectDir || ""));
  if (!projectDir || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Claude Code needs a selected project folder before it can run.");
  const before = captureWorkspace(cwd);
  const prompt = promptWithChanges(String(input || ""), workspaceChanges);
  const args = ["-p", prompt, "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--max-turns", String(Math.max(1, Math.min(100, Number(maxTurns) || 30)))];
  if (model) args.push("--model", String(model).slice(0, 200));
  if (mapping?.sessionId) args.push("--resume", String(mapping.sessionId).slice(0, 200));
  if (accessMode === "read_only") args.push("--permission-mode", "plan", "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash", "PowerShell");
  else if (accessMode === "full_access") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits", "--allowedTools", ...SAFE_TOOLS);

  onStatus("Starting Claude Code...");
  const child = spawnImpl(launch.command, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let answer = "";
  let sessionId = String(mapping?.sessionId || "");
  let usage = null;
  const tools = new Map();
  const parseLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    sessionId = String(event.session_id || event.sessionId || sessionId || "");
    if (event.type === "result") {
      if (typeof event.result === "string") answer = event.result;
      usage = event.usage || usage;
      return;
    }
    const content = event?.message?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      const texts = content.filter((block) => block?.type === "text").map((block) => String(block.text || "")).filter(Boolean);
      if (texts.length) answer = texts.join("\n");
      for (const block of content.filter((block) => block?.type === "tool_use")) {
        tools.set(block.id || `${block.name}-${tools.size}`, block);
        onStatus(`${block.name || "Claude Code"}...`);
      }
    }
    const delta = event?.event?.delta;
    if (event.type === "stream_event" && delta?.type === "text_delta" && delta.text) onToken(delta.text);
  };
  const consume = (chunk) => {
    stdout += String(chunk || "");
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || "";
    for (const line of lines) parseLine(line);
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", (chunk) => { stderr = bounded(stderr + String(chunk || "")); });
  const abort = () => { try { child.kill(); } catch {} };
  signal?.addEventListener("abort", abort, { once: true });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => signal?.removeEventListener("abort", abort));
  if (stdout.trim()) parseLine(stdout);
  if (signal?.aborted) throw Object.assign(new Error("Claude Code was stopped."), { code: "ABORT_ERR" });
  if (code !== 0) throw new Error(bounded(stderr || `Claude Code exited with code ${code}.`, 4000));
  const after = captureWorkspace(cwd);
  const verifiedChanges = verifiedWorkspaceDelta(before, after, cwd);
  if (verifiedChanges.length) onStep({ name: "apply_patch", args: { changes: verifiedChanges }, result: "verified on disk", verified: true });
  for (const block of tools.values()) {
    if (["Bash", "PowerShell"].includes(block.name)) onStep({ name: "run_command", args: { command: block.input?.command || "", cwd }, result: "Claude Code command completed" });
  }
  const publicUsage = normalizedUsage(usage, model);
  if (publicUsage) onUsage(publicUsage);
  const nextMapping = { sessionId, model: model || mapping?.model || "", status: "completed", updatedAt: Date.now() };
  onMapping(nextMapping);
  return { answer: answer || "Claude Code completed the task.", mapping: nextMapping, usage: publicUsage, changes: verifiedChanges, status: "completed" };
}
