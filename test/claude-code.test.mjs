import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  installClaudeCode, readClaudeCodeStatus, resolveClaudeCodeLaunch,
  runClaudeCodeTurn, startClaudeCodeLogin
} from "../src/claude-code.js";
import { gitDiffFiles } from "../src/git-review.js";

function versionSpawn(command, args) {
  if (args[0] === "--version") return { status: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" };
  if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ loggedIn: true, email: "person@example.com", authMethod: "claude.ai" }), stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

function fakeChild(onStart = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 130);
  child.unref = () => {};
  queueMicrotask(() => onStart(child));
  return child;
}

function successfulClaudeSpawn({ cwd, mutate = () => {}, capture = () => {} } = {}) {
  return (command, args, options) => fakeChild((child) => {
    capture({ command, args, options });
    mutate(options?.cwd || cwd);
    child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" }) + "\n");
    child.stdout.write(JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "Completed and verified." }] } }) + "\n");
    child.stdout.write(JSON.stringify({ type: "result", session_id: "claude-session-1", result: "Completed and verified.", usage: { input_tokens: 12, output_tokens: 4 } }) + "\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
  });
}

function tempGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-claude-code-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("Claude Code discovery and auth status use the verified CLI", () => {
  const launch = resolveClaudeCodeLaunch("claude", { platform: "linux", spawnSyncImpl: versionSpawn });
  assert.equal(launch.ready, true);
  assert.match(launch.version, /Claude Code/);
  const status = readClaudeCodeStatus("claude", { platform: "linux", spawnSyncImpl: versionSpawn });
  assert.equal(status.installed, true);
  assert.equal(status.signedIn, true);
  assert.equal(status.account.email, "person@example.com");
});

test("Claude Code discovery finds the official WinGet package when its PATH link is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-claude-winget-"));
  try {
    const localAppData = path.join(root, "Local");
    const executable = path.join(localAppData, "Microsoft", "WinGet", "Packages", "Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe", "claude.exe");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "test");
    const launch = resolveClaudeCodeLaunch("claude", {
      platform: "win32",
      env: { USERPROFILE: root, LOCALAPPDATA: localAppData, APPDATA: path.join(root, "Roaming") },
      spawnSyncImpl: (command, args) => command === executable && args[0] === "--version"
        ? { status: 0, stdout: "2.1.220 (Claude Code)\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "" }
    });
    assert.equal(launch.ready, true);
    assert.equal(launch.command, executable);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code setup uses Anthropic's recommended native installer and opens sign-in", async () => {
  let installCommand = "";
  const spawnImpl = (command, args) => fakeChild((child) => {
    if (command === "powershell.exe") installCommand = args.join(" ");
    child.emit("close", 0);
  });
  const installed = await installClaudeCode({ platform: "win32", spawnImpl, spawnSyncImpl: versionSpawn });
  assert.equal(installed.ok, true);
  assert.equal(installed.method, "native");
  assert.match(installCommand, /https:\/\/claude\.ai\/install\.ps1/);
  let loginCommand = "";
  let loginArgs = [];
  let loginOptions = {};
  const login = startClaudeCodeLogin("claude", {
    platform: "win32", spawnSyncImpl: versionSpawn,
    env: { Path: "C:\\Windows", PATH: "C:\\Program Files\\nodejs" },
    spawnImpl: (command, args, options) => { loginCommand = command; loginArgs = args; loginOptions = options; return { pid: 42, unref() {} }; }
  });
  assert.equal(login.ok, true);
  assert.equal(loginCommand, "powershell.exe");
  assert.deepEqual(loginArgs.slice(0, 4), ["-NoLogo", "-NoExit", "-NoProfile", "-EncodedCommand"]);
  const encodedLogin = loginArgs.at(-1);
  const decodedLogin = Buffer.from(encodedLogin, "base64").toString("utf16le");
  assert.match(decodedLogin, /auth login --claudeai/);
  assert.doesNotMatch(decodedLogin, /Start-Process/);
  assert.equal(loginOptions.detached, true);
  assert.equal(loginOptions.windowsHide, false);
  assert.equal(loginOptions.env.Path, "C:\\Windows");
  assert.equal(loginOptions.env.PATH, "C:\\Program Files\\nodejs");
});

test("Claude Code setup falls back to the official WinGet package", async () => {
  let wingetArgs = [];
  const spawnImpl = (command, args) => fakeChild((child) => {
    if (command === "winget.exe") wingetArgs = args;
    child.emit("close", command === "powershell.exe" ? 1 : 0);
  });
  const installed = await installClaudeCode({ platform: "win32", spawnImpl, spawnSyncImpl: versionSpawn });
  assert.equal(installed.ok, true);
  assert.equal(installed.method, "winget");
  assert.deepEqual(wingetArgs.slice(0, 4), ["install", "--id", "Anthropic.ClaudeCode", "--exact"]);
});

test("Claude Code creates a file only when the exact disk diff exists", async () => {
  const root = tempGitRepo();
  try {
    const steps = [];
    let launch = null;
    const result = await runClaudeCodeTurn({
      command: "claude", input: "Create codex-edit-test.txt", projectDir: root,
      workspaceChanges: [{ path: "existing.txt", absolutePath: path.join(root, "existing.txt"), status: "modified", diff: "+existing" }],
      accessMode: "ask", spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({
        cwd: root,
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "codex-edit-test.txt"), "verified Claude content\n"),
        capture: (value) => { launch = value; }
      }),
      onStep: (step) => steps.push(step)
    });
    assert.equal(result.mapping.sessionId, "claude-session-1");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, "codex-edit-test.txt");
    assert.equal(path.resolve(result.changes[0].absolutePath), path.resolve(root, "codex-edit-test.txt"));
    assert.match(result.changes[0].diff, /verified Claude content/);
    assert.equal(steps.filter((step) => step.name === "apply_patch").length, 1);
    assert.ok(launch.args.includes("acceptEdits"));
    assert.match(launch.args[1], /verified_workspace_changes/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code strips null bytes from prompt and verified workspace changes", async () => {
  const root = tempGitRepo();
  try {
    let launch = null;
    await runClaudeCodeTurn({
      command: "claude", input: "prosta\0titis", projectDir: root,
      workspaceChanges: [{ path: "document.docx", status: "untracked", diff: "PK\0binary" }],
      spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ capture: (value) => { launch = value; } })
    });
    assert.equal(launch.args.some((arg) => String(arg).includes("\0")), false);
    assert.match(launch.args[1], /prostatitis/);
    assert.match(launch.args[1], /PKbinary/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code receives Boollm image attachments as readable temporary files", async () => {
  const root = tempGitRepo();
  try {
    let launch = null;
    let imageBytes = null;
    await runClaudeCodeTurn({
      command: "claude", input: "Describe the picture", projectDir: root,
      images: ["data:image/png;base64,aGVsbG8="], spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ capture: (value) => {
        launch = value;
        const imagePath = value.args[1].match(/- (.+attachment-1\.png)/)?.[1];
        imageBytes = imagePath ? fs.readFileSync(imagePath, "utf8") : null;
      } })
    });
    assert.match(launch.args[1], /Attached images/);
    assert.ok(launch.args.includes("--add-dir"));
    assert.equal(imageBytes, "hello");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code receives a token-protected Boollm browser MCP bridge", async () => {
  const root = tempGitRepo();
  try {
    let launch = null;
    let mcp = null;
    await runClaudeCodeTurn({
      command: "claude", input: "Read the open browser page", projectDir: root,
      browserBridge: { url: "http://127.0.0.1:8765/api/claude/mcp?id=test", token: "secret" },
      spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ capture: (value) => {
        launch = value;
        const configPath = value.args[value.args.indexOf("--mcp-config") + 1];
        mcp = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } })
    });
    assert.ok(launch.args.includes("--strict-mcp-config"));
    assert.ok(launch.args.includes("mcp__boollm__browser_read"));
    assert.ok(launch.args.includes("mcp__boollm__browser_control"));
    assert.equal(mcp.mcpServers.boollm.type, "http");
    assert.equal(mcp.mcpServers.boollm.url, "http://127.0.0.1:8765/api/claude/mcp?id=test");
    assert.equal(mcp.mcpServers.boollm.headers["x-saz"], "secret");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code cannot claim a change when no file content changed", async () => {
  const root = tempGitRepo();
  try {
    const steps = [];
    const result = await runClaudeCodeTurn({
      command: "claude", input: "Create a file", projectDir: root, accessMode: "full_access",
      spawnSyncImpl: versionSpawn, spawnImpl: successfulClaudeSpawn(), onStep: (step) => steps.push(step)
    });
    assert.deepEqual(result.changes, []);
    assert.equal(steps.filter((step) => step.name === "apply_patch").length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code verifies edits in an ordinary folder without Git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-claude-code-no-git-"));
  try {
    const usageRows = [];
    const result = await runClaudeCodeTurn({
      command: "claude", input: "Create hello.txt", projectDir: root, accessMode: "ask",
      spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ mutate: (cwd) => fs.writeFileSync(path.join(cwd, "hello.txt"), "hello from Claude\n") }),
      onUsage: (usage) => usageRows.push(usage)
    });
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, "hello.txt");
    assert.equal(result.changes[0].status, "added");
    assert.match(result.changes[0].diff, /hello from Claude/);
    assert.deepEqual(usageRows, [{ provider: "claude-code", model: "Claude Code", input: 12, output: 4, estimated: false }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code create then delete returns the Changes count to zero", async () => {
  const root = tempGitRepo();
  try {
    await runClaudeCodeTurn({
      command: "claude", input: "Create codex-edit-test.txt", projectDir: root,
      spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ mutate: (cwd) => fs.writeFileSync(path.join(cwd, "codex-edit-test.txt"), "temporary\n") })
    });
    assert.equal(gitDiffFiles(root).files.length, 1);
    await runClaudeCodeTurn({
      command: "claude", input: "Delete codex-edit-test.txt", projectDir: root,
      mapping: { sessionId: "claude-session-1" }, spawnSyncImpl: versionSpawn,
      spawnImpl: successfulClaudeSpawn({ mutate: (cwd) => fs.rmSync(path.join(cwd, "codex-edit-test.txt")) })
    });
    assert.equal(gitDiffFiles(root).files.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude Code access modes map to read-only, accept-edits, and explicit full access", async () => {
  for (const [mode, expected] of [["read_only", "plan"], ["ask", "acceptEdits"], ["full_access", "--dangerously-skip-permissions"]]) {
    const root = tempGitRepo();
    try {
      let args = [];
      await runClaudeCodeTurn({
        command: "claude", input: "Inspect", projectDir: root, accessMode: mode,
        spawnSyncImpl: versionSpawn,
        spawnImpl: successfulClaudeSpawn({ capture: (launch) => { args = launch.args; } })
      });
      assert.ok(args.includes(expected), `${mode} should include ${expected}`);
      assert.equal(args[0], "-p");
      assert.equal(args[1], "Inspect");
      if (mode === "ask") {
        assert.ok(args.includes("Bash(node --check *)"));
        assert.ok(args.includes("PowerShell(Test-Path *)"));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
