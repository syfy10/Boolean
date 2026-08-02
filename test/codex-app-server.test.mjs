import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServer,
  CodexAppServerError,
  codexWindowsSandboxStatus,
  installCodexStandaloneCli,
  resolveCodexLaunch,
  standaloneCodexPath
} from "../src/codex-app-server.js";

function fakeProcess(onMessage) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let buffer = "";
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onMessage?.(JSON.parse(line), child);
    }
  });
  child.stdin.on("finish", () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("close", 0, null));
  });
  child.kill = () => {
    child.exitCode = 1;
    queueMicrotask(() => child.emit("close", 1, "SIGTERM"));
    return true;
  };
  return child;
}

function harness(handler, options = {}) {
  const calls = [];
  const children = [];
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const child = fakeProcess((message, process) => {
      if (message.method === "initialize" && message.id !== undefined) {
        process.send({ id: message.id, result: { userAgent: "codex-test", codexHome: "C:/codex" } });
      } else handler?.(message, process);
    });
    children.push(child);
    return child;
  };
  return {
    calls,
    children,
    client: new CodexAppServer({ spawn, command: ["fake-codex", "app-server"], requestTimeoutMs: 100, ...options })
  };
}

test("starts codex app-server and performs the required initialize handshake", async () => {
  const received = [];
  const { client, calls } = harness((message) => received.push(message));
  const initialized = await client.start({ capabilities: { experimentalApi: true } });
  assert.equal(initialized.userAgent, "codex-test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fake-codex");
  assert.deepEqual(calls[0].args, ["app-server"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(received[0], { method: "initialized", params: {} });
  assert.equal(client.status.ready, true);
  assert.equal(client.status.pid, 4242);
  await client.stop();
  assert.equal(client.status.state, "stopped");
});

test("correlates requests, exposes protocol helpers, and converts text input", async () => {
  const requests = [];
  const { client } = harness((message, child) => {
    if (message.id === undefined) return;
    requests.push(message);
    child.send({ id: message.id, result: { method: message.method, params: message.params } });
  });
  await client.start();
  const account = await client.accountRead({ refreshToken: true });
  const models = await client.modelList({ includeHidden: true });
  const started = await client.threadStart({ cwd: "C:/project", model: "gpt-test" });
  const resumed = await client.threadResume("thr_1", { model: "gpt-test" });
  const turn = await client.turnStart("thr_1", "Fix the failing test.", { cwd: "C:/project" });
  const steered = await client.turnSteer("thr_1", "turn_1", "Focus on the parser.");
  const interrupted = await client.turnInterrupt("thr_1", "turn_1");
  assert.deepEqual(account.params, { refreshToken: true });
  assert.deepEqual(models.params, { includeHidden: true });
  assert.equal(started.method, "thread/start");
  assert.equal(resumed.params.threadId, "thr_1");
  assert.deepEqual(turn.params.input, [{ type: "text", text: "Fix the failing test." }]);
  assert.equal(steered.params.expectedTurnId, "turn_1");
  assert.deepEqual(steered.params.input, [{ type: "text", text: "Focus on the parser." }]);
  assert.deepEqual(interrupted.params, { threadId: "thr_1", turnId: "turn_1" });
  assert.deepEqual(requests.map((entry) => entry.method), [
    "account/read", "model/list", "thread/start", "thread/resume",
    "turn/start", "turn/steer", "turn/interrupt"
  ]);
  await client.stop();
});

test("streams notifications and lets the client resolve server approval requests", async () => {
  const events = [];
  const requests = [];
  const sent = [];
  const { client, children } = harness((message) => sent.push(message), {
    onEvent: (message) => events.push(message),
    onServerRequest: (message) => { requests.push(message); }
  });
  await client.start();
  const child = children[0];
  child.send({ method: "item/agentMessage/delta", params: { delta: "Working" } });
  child.send({
    id: "approval_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", command: "node --version" }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].method, "item/agentMessage/delta");
  assert.equal(requests[0].id, "approval_1");
  assert.equal(client.status.pendingServerRequests, 1);
  client.approveForSession(requests[0]);
  assert.deepEqual(sent.at(-1), { id: "approval_1", result: { decision: "acceptForSession" } });
  assert.equal(client.status.pendingServerRequests, 0);
  await client.stop();
});

test("supports approval amendments, rejection helpers, and async callback responses", async () => {
  const sent = [];
  const { client, children } = harness((message) => sent.push(message), {
    onServerRequest: async (message) => message.method === "item/tool/requestUserInput"
      ? { answers: { choice: { answers: ["Continue"] } } }
      : undefined
  });
  await client.start();
  const child = children[0];
  child.send({ id: 90, method: "item/tool/requestUserInput", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.at(-1), { id: 90, result: { answers: { choice: { answers: ["Continue"] } } } });
  child.send({ id: 91, method: "item/fileChange/requestApproval", params: {} });
  client.approveWithExecpolicyAmendment(91, ["node", "--version"]);
  assert.deepEqual(sent.at(-1).result.decision, {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] }
  });
  child.send({ id: 92, method: "item/commandExecution/requestApproval", params: {} });
  client.applyNetworkPolicyAmendment(92, { host: "example.com", action: "allow" });
  assert.deepEqual(sent.at(-1).result.decision, {
    applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } }
  });
  child.send({ id: 93, method: "item/fileChange/requestApproval", params: {} });
  client.decline(93);
  assert.equal(sent.at(-1).result.decision, "decline");
  await client.stop();
});

test("reports request errors and timeouts without losing later responses", async () => {
  const { client } = harness((message, child) => {
    if (message.method === "broken") child.send({ id: message.id, error: { code: -32602, message: "Bad params", data: { field: "cwd" } } });
    if (message.method === "healthy") child.send({ id: message.id, result: { ok: true } });
  }, { requestTimeoutMs: 20 });
  await client.start();
  await assert.rejects(client.request("broken"), (error) => {
    assert.ok(error instanceof CodexAppServerError);
    assert.equal(error.code, -32602);
    assert.equal(error.method, "broken");
    return true;
  });
  await assert.rejects(client.request("never-responds"), /timed out/);
  assert.deepEqual(await client.request("healthy"), { ok: true });
  assert.equal(client.status.pendingRequests, 0);
  await client.stop();
});

test("restart gracefully closes the old process and initializes a replacement", async () => {
  const { client, calls, children } = harness();
  await client.start();
  const first = children[0];
  await client.restart();
  assert.equal(first.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(client.status.ready, true);
  assert.notEqual(children[0], children[1]);
  await client.stop();
});

test("surfaces malformed JSON without breaking the stream", async () => {
  const protocolErrors = [];
  const { client, children } = harness(null, { onProtocolError: (error) => protocolErrors.push(error) });
  await client.start();
  children[0].stdout.write("not-json\n");
  children[0].send({ method: "thread/started", params: { thread: { id: "thr_1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /invalid JSONL/);
  assert.equal(client.status.ready, true);
  await client.stop();
});

test("treats the Codex error notification as data rather than an EventEmitter crash", async () => {
  const events = [];
  const { client, children } = harness(null, { onEvent: (message) => events.push(message) });
  await client.start();
  children[0].send({ method: "error", params: { error: { message: "Usage limit reached" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0].method, "error");
  assert.equal(events[0].params.error.message, "Usage limit reached");
  assert.equal(client.status.ready, true);
  await client.stop();
});

test("resolves an npm-installed codex.cmd shim to its JavaScript entry without a shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-shim-"));
  try {
    const npmDir = path.join(root, "npm");
    const nodeDir = path.join(root, "nodejs");
    const script = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(npmDir, "codex.cmd");
    const node = path.join(nodeDir, "node.exe");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(script, "console.log('codex');\n");
    fs.writeFileSync(node, "");
    fs.writeFileSync(shim, [
      "@ECHO off",
      "SETLOCAL",
      "\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*"
    ].join("\r\n"));
    const launch = resolveCodexLaunch(shim, ["app-server", "--stdio"], {
      platform: "win32",
      env: { PATH: `${npmDir};${nodeDir}`, PATHEXT: ".EXE;.CMD" },
      execPath: path.join(root, "Boolean-core.exe")
    });
    assert.equal(launch.kind, "npm-shim");
    assert.equal(path.resolve(launch.command), path.resolve(node));
    assert.deepEqual(launch.args.map((entry) => path.normalize(entry)), [
      path.normalize(script),
      "app-server",
      "--stdio"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CodexAppServer spawns the npm shim target with shell false semantics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-launch-"));
  try {
    const npmDir = path.join(root, "npm");
    const script = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(npmDir, "codex.cmd");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.writeFileSync(shim, "@ECHO off\r\n\"%_prog%\" \"%~dp0node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
    const launches = [];
    const client = new CodexAppServer({
      command: shim,
      args: ["app-server"],
      launchPlatform: "win32",
      launchExecPath: process.execPath,
      spawn(command, args, options) {
        launches.push({ command, args, options });
        return fakeProcess((message, child) => {
          if (message.method === "initialize") child.send({ id: message.id, result: { userAgent: "test" } });
        });
      }
    });
    await client.start();
    assert.equal(path.resolve(launches[0].command), path.resolve(process.execPath));
    assert.equal(path.resolve(launches[0].args[0]), path.resolve(script));
    assert.deepEqual(launches[0].args.slice(1), ["app-server"]);
    assert.equal(launches[0].options.shell, undefined);
    assert.equal(client.status.launchKind, "npm-shim");
    await client.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers the runnable npm CLI when the Microsoft Store desktop binary is first on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-store-"));
  try {
    const storeDir = path.join(root, "WindowsApps", "OpenAI.Codex_1.0_x64__test", "app", "resources");
    const npmDir = path.join(root, "npm");
    const nodeDir = path.join(root, "nodejs");
    const storeBinary = path.join(storeDir, "codex.exe");
    const storeBinaryWithoutExtension = path.join(storeDir, "codex");
    const script = path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(npmDir, "codex.cmd");
    const node = path.join(nodeDir, "node.exe");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(storeBinary, "");
    fs.writeFileSync(storeBinaryWithoutExtension, "");
    fs.writeFileSync(script, "");
    fs.writeFileSync(node, "");
    fs.writeFileSync(shim, "@ECHO off\r\n\"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
    const launch = resolveCodexLaunch("codex", ["app-server"], {
      platform: "win32",
      env: { PATH: `${storeDir};${npmDir};${nodeDir}`, PATHEXT: ".EXE;.CMD" },
      execPath: path.join(root, "Boolean-core.exe")
    });
    assert.equal(launch.kind, "npm-shim");
    assert.equal(path.resolve(launch.command), path.resolve(node));
    assert.equal(path.resolve(launch.args[0]), path.resolve(script));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovers an invalid saved Microsoft Store command with the standalone CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-standalone-"));
  try {
    const storeBinary = path.join(root, "WindowsApps", "OpenAI.Codex_1.0_x64__test", "app", "resources", "codex.exe");
    const standalone = path.join(root, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    fs.mkdirSync(path.dirname(storeBinary), { recursive: true });
    fs.mkdirSync(path.dirname(standalone), { recursive: true });
    fs.writeFileSync(storeBinary, "");
    fs.writeFileSync(standalone, "");
    const launch = resolveCodexLaunch(storeBinary, ["app-server", "--stdio"], {
      platform: "win32",
      env: { LOCALAPPDATA: root, PATH: path.dirname(storeBinary), PATHEXT: ".EXE;.CMD" },
      execPath: path.join(root, "Boolean-core.exe")
    });
    assert.equal(path.resolve(launch.command), path.resolve(standalone));
    assert.equal(launch.kind, "standalone");
    assert.equal(launch.requestedCommand, storeBinary);
    assert.deepEqual(launch.args, ["app-server", "--stdio"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finds the documented standalone CLI when a plain codex command is not on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-standalone-no-path-"));
  try {
    const standalone = path.join(root, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    fs.mkdirSync(path.dirname(standalone), { recursive: true });
    fs.writeFileSync(standalone, "");
    const launch = resolveCodexLaunch("codex", ["app-server", "--stdio"], {
      platform: "win32",
      env: { LOCALAPPDATA: root, PATH: "", PATHEXT: ".EXE;.CMD" },
      execPath: path.join(root, "Boolean-core.exe")
    });
    assert.equal(path.resolve(launch.command), path.resolve(standalone));
    assert.equal(launch.kind, "standalone");
    assert.deepEqual(launch.args, ["app-server", "--stdio"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovers an invalid saved Microsoft Store command with a runnable CLI on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-path-recovery-"));
  try {
    const storeBinary = path.join(root, "WindowsApps", "OpenAI.Codex_1.0_x64__test", "app", "resources", "codex.exe");
    const cli = path.join(root, "cli", "codex.exe");
    fs.mkdirSync(path.dirname(storeBinary), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(storeBinary, "");
    fs.writeFileSync(cli, "");
    const launch = resolveCodexLaunch(storeBinary, ["app-server"], {
      platform: "win32",
      env: { LOCALAPPDATA: path.join(root, "missing-local"), PATH: `${path.dirname(storeBinary)};${path.dirname(cli)}`, PATHEXT: ".EXE;.CMD" },
      execPath: path.join(root, "Boolean-core.exe")
    });
    assert.equal(path.resolve(launch.command), path.resolve(cli));
    assert.equal(launch.kind, "direct");
    assert.notEqual(path.resolve(launch.command), path.resolve(storeBinary));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("never returns an invalid Microsoft Store command as a direct executable", () => {
  const storeBinary = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__test\\app\\resources\\codex.exe";
  const localAppData = "C:\\Users\\Test\\AppData\\Local";
  const launch = resolveCodexLaunch(storeBinary, ["app-server"], {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, PATH: "", PATHEXT: ".EXE;.CMD" },
    execPath: "C:\\Boolean\\Boolean-core.exe",
    existsSync: () => false
  });
  assert.equal(launch.kind, "standalone-missing");
  assert.notEqual(launch.command.toLowerCase(), storeBinary.toLowerCase());
  assert.equal(launch.command, standaloneCodexPath({ platform: "win32", env: { LOCALAPPDATA: localAppData } }));
});

test("runs the fixed official standalone installer with bounded output", async () => {
  const calls = [];
  const localAppData = "C:\\Users\\Test\\AppData\\Local";
  const installed = standaloneCodexPath({ platform: "win32", env: { LOCALAPPDATA: localAppData } });
  const sandboxHelper = path.join(path.dirname(path.dirname(installed)), "codex-resources", "codex-windows-sandbox-setup.exe");
  const result = await installCodexStandaloneCli({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, PATH: "", SystemRoot: "C:\\Windows", OS: "Windows_NT", BOOLEAN_SECRET: "do-not-inherit" },
    maxOutputBytes: 1000,
    existsSync: (candidate) => candidate === installed || candidate === sandboxHelper,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.write(calls.length === 1 ? `\u001b[32m${"x".repeat(1400)}\u001b[0m` : "codex-cli 1.2.3\n");
        if (calls.length === 1) child.stderr.write("installed\n");
        child.emit("close", 0, null);
      });
      return child;
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 6), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"
  ]);
  assert.equal(calls[0].args[6], "$ErrorActionPreference='Stop'; $env:CODEX_NON_INTERACTIVE='1'; irm 'https://chatgpt.com/codex/install.ps1' | iex");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CODEX_NON_INTERACTIVE, "1");
  assert.equal(calls[0].options.env.CODEX_INSTALL_DIR, path.dirname(installed));
  assert.equal(calls[0].options.env.OS, "Windows_NT");
  assert.equal(calls[0].options.env.BOOLEAN_SECRET, undefined);
  assert.equal(calls[1].command, installed);
  assert.deepEqual(calls[1].args, ["--version"]);
  assert.equal(result.ok, true);
  assert.equal(result.command, installed);
  assert.equal(result.sandboxReady, true);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.output.length <= 1000);
});

test("prefers a complete official package when the copied standalone exe has no sandbox helper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-complete-"));
  try {
    const localAppData = path.join(root, "local");
    const userProfile = path.join(root, "profile");
    const standalone = standaloneCodexPath({ platform: "win32", env: { LOCALAPPDATA: localAppData } });
    const release = path.join(userProfile, ".codex", "packages", "standalone", "releases", "0.146.0-x86_64-pc-windows-msvc");
    const packaged = path.join(release, "bin", "codex.exe");
    const helper = path.join(release, "codex-resources", "codex-windows-sandbox-setup.exe");
    fs.mkdirSync(path.dirname(standalone), { recursive: true });
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(standalone, "incomplete");
    fs.writeFileSync(packaged, "complete");
    fs.writeFileSync(helper, "helper");
    const launch = resolveCodexLaunch(standalone, ["app-server", "--stdio"], {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, USERPROFILE: userProfile, PATH: "", PATHEXT: ".EXE;.CMD" }
    });
    assert.equal(path.resolve(launch.command), path.resolve(packaged));
    assert.equal(launch.kind, "standalone-package");
    assert.equal(launch.sandboxReady, true);
    assert.equal(path.resolve(launch.sandboxHelper), path.resolve(helper));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails before spawning when a Windows Codex exe has no sandbox helper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-no-helper-"));
  try {
    const executable = path.join(root, "codex.exe");
    fs.writeFileSync(executable, "incomplete");
    let spawned = false;
    const client = new CodexAppServer({
      command: executable,
      launchPlatform: "win32",
      spawn() { spawned = true; throw new Error("must not spawn"); }
    });
    await assert.rejects(() => client.start(), /codex-windows-sandbox-setup\.exe/);
    assert.equal(spawned, false);
    assert.equal(client.status.sandboxReady, false);
    assert.match(client.status.sandboxError, /Reinstall Codex/);
    assert.equal(codexWindowsSandboxStatus(executable, { platform: "win32" }).ready, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automatic standalone setup is Windows-only without spawning a process", async () => {
  let spawned = false;
  const result = await installCodexStandaloneCli({
    platform: "linux",
    spawn() { spawned = true; throw new Error("must not run"); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_platform");
  assert.equal(spawned, false);
});

test("non-Windows launch resolution preserves the executable and argv", () => {
  assert.deepEqual(resolveCodexLaunch("/usr/local/bin/codex", ["app-server"], {
    platform: "linux",
    env: {},
    execPath: "/usr/bin/node"
  }), {
    command: "/usr/local/bin/codex",
    args: ["app-server"],
    kind: "direct",
    requestedCommand: "/usr/local/bin/codex"
  });
});
