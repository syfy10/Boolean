import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const APPROVAL_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "decline",
  "cancel"
]);

function commandParts(command, args) {
  if (Array.isArray(command)) {
    if (!command.length) throw new TypeError("command must not be empty");
    return { command: String(command[0]), args: command.slice(1).map(String) };
  }
  if (command && typeof command === "object") {
    const executable = command.command || command.executable;
    if (!executable) throw new TypeError("command.command is required");
    return {
      command: String(executable),
      args: Array.isArray(command.args) ? command.args.map(String) : []
    };
  }
  if (!command) throw new TypeError("command is required");
  return { command: String(command), args: Array.isArray(args) ? args.map(String) : [] };
}

function pathEntries(env, platform) {
  const value = String(env?.PATH || env?.Path || env?.path || "");
  return value.split(platform === "win32" ? ";" : path.delimiter).map((entry) => entry.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

function windowsExtensions(env) {
  const value = String(env?.PATHEXT || ".COM;.EXE;.BAT;.CMD");
  return value.split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function executableCandidates(command, { env, platform, existsSync }) {
  const value = String(command || "");
  if (!value) return [];
  const extension = path.extname(value).toLowerCase();
  const names = extension ? [value] : [value, ...windowsExtensions(env).map((suffix) => `${value}${suffix}`)];
  const hasDirectory = path.isAbsolute(value) || /[\\/]/.test(value);
  const directories = hasDirectory ? [""] : pathEntries(env, platform);
  const candidates = [];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.join(directory, name) : path.resolve(name);
      try { if (existsSync(candidate)) candidates.push(candidate); } catch {}
    }
  }
  return [...new Set(candidates)];
}

function npmShimTarget(shimPath, { existsSync, readFileSync }) {
  let source = "";
  try { source = readFileSync(shimPath, "utf8"); } catch { return ""; }
  const directory = path.dirname(shimPath);
  // npm's Windows shim invokes a JavaScript entry relative to `%dp0%` (or
  // `%~dp0`). Resolve that data reference; never execute or interpolate the
  // batch source itself.
  const matches = [...source.matchAll(/%~?dp0%?[\\/]?([^"\r\n%]+?\.(?:c|m)?js)\b/gi)];
  matches.sort((left, right) => Number(/node_modules/i.test(right[1])) - Number(/node_modules/i.test(left[1])));
  for (const match of matches) {
    const relative = String(match[1] || "").trim().replace(/[\\/]+/g, path.sep);
    if (!relative) continue;
    const target = path.resolve(directory, relative);
    const outside = path.relative(directory, target);
    if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) continue;
    try { if (existsSync(target)) return target; } catch {}
  }
  return "";
}

function nodeExecutable({ env, platform, execPath, shimPath, existsSync }) {
  const besideShim = path.join(path.dirname(shimPath), platform === "win32" ? "node.exe" : "node");
  try { if (existsSync(besideShim)) return besideShim; } catch {}
  const processNode = String(execPath || "");
  if (/^node(?:\.exe)?$/i.test(path.basename(processNode))) {
    try { if (!path.isAbsolute(processNode) || existsSync(processNode)) return processNode; } catch {}
  }
  const found = executableCandidates(platform === "win32" ? "node.exe" : "node", { env, platform, existsSync });
  return found[0] || "";
}

/**
 * Resolve a launch without `shell: true`. On Windows, npm exposes Codex as a
 * `.cmd` shim, which CreateProcess cannot execute directly. We read only the
 * shim's relative JavaScript target and invoke it with Node, avoiding command
 * string interpolation and preserving every argument as a separate argv item.
 */
export function resolveCodexLaunch(command, args = [], {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const original = { command: String(command || ""), args: Array.isArray(args) ? args.map(String) : [] };
  if (platform !== "win32" || !original.command) return { ...original, kind: "direct", requestedCommand: original.command };
  const candidates = executableCandidates(original.command, { env, platform, existsSync });
  const shimLaunch = (candidate) => {
    if (![".cmd", ".bat"].includes(path.extname(candidate).toLowerCase())) return null;
    const target = npmShimTarget(candidate, { existsSync, readFileSync });
    if (!target) return null;
    const node = nodeExecutable({ env, platform, execPath, shimPath: candidate, existsSync });
    if (!node) return null;
    return {
      command: node,
      args: [target, ...original.args],
      kind: "npm-shim",
      requestedCommand: original.command,
      shimPath: candidate,
      scriptPath: target
    };
  };
  const first = candidates[0] || "";
  const firstShim = first && shimLaunch(first);
  if (firstShim) return firstShim;
  const firstIsBatch = [".cmd", ".bat"].includes(path.extname(first).toLowerCase());
  const inaccessibleStoreApp = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]resources[\\/]codex(?:\.exe)?$/i.test(first);
  if (first && !firstIsBatch && !inaccessibleStoreApp) {
    return { command: first, args: original.args, kind: "direct", requestedCommand: original.command };
  }
  // The Microsoft Store desktop bundle can be visible on PATH while denying
  // child-process execution. Prefer a later official npm CLI shim in that
  // specific case, without generally reordering the user's PATH.
  for (const candidate of candidates.slice(first ? 1 : 0)) {
    if (![".cmd", ".bat"].includes(path.extname(candidate).toLowerCase())) continue;
    const launch = shimLaunch(candidate);
    if (launch && /[\\/]node_modules[\\/]@openai[\\/]codex[\\/]/i.test(launch.scriptPath)) return launch;
  }
  const direct = candidates.find((candidate) => ![".cmd", ".bat"].includes(path.extname(candidate).toLowerCase()));
  if (direct) return { command: direct, args: original.args, kind: "direct", requestedCommand: original.command };
  // Leave unresolved commands untouched so injected test launchers and normal
  // CreateProcess errors retain their existing behavior. An explicit unknown
  // batch file is never passed to a shell by this client.
  return { ...original, kind: "direct", requestedCommand: original.command };
}

function requestId(value) {
  if (value && typeof value === "object") return value.id;
  return value;
}

function inputItems(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return [input];
  return [{ type: "text", text: String(input ?? "") }];
}

function rpcError(error, fallbackCode = -32000) {
  if (error && typeof error === "object" && Number.isFinite(error.code) && error.message) {
    return { code: error.code, message: String(error.message), ...(error.data === undefined ? {} : { data: error.data }) };
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error || "Request failed") };
}

export class CodexAppServerError extends Error {
  constructor(message, { code = null, data, method = "", cause } = {}) {
    super(String(message || "Codex app-server request failed"), cause ? { cause } : undefined);
    this.name = "CodexAppServerError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

/**
 * Dependency-free stdio client for the public `codex app-server` protocol.
 * Messages intentionally omit the JSON-RPC `jsonrpc` field, matching Codex's
 * newline-delimited wire format.
 */
export class CodexAppServer extends EventEmitter {
  constructor({
    spawn = nodeSpawn,
    command = "codex",
    args = ["app-server", "--stdio"],
    cwd,
    env,
    clientInfo = { name: "boolean", title: "Boolean", version: "0.1.0" },
    capabilities = {},
    requestTimeoutMs = 30000,
    stopTimeoutMs = 2000,
    onEvent,
    onServerRequest,
    onStatus,
    onStderr,
    onProtocolError,
    launchPlatform = process.platform,
    launchExecPath = process.execPath,
    resolveLaunch = resolveCodexLaunch
  } = {}) {
    super();
    const executable = commandParts(command, args);
    if (typeof spawn !== "function") throw new TypeError("spawn must be a function");
    if (typeof resolveLaunch !== "function") throw new TypeError("resolveLaunch must be a function");
    const launch = resolveLaunch(executable.command, executable.args, {
      platform: launchPlatform,
      env: env || process.env,
      execPath: launchExecPath
    });
    this.spawnProcess = spawn;
    this.command = launch.command;
    this.args = launch.args;
    this.requestedCommand = launch.requestedCommand || executable.command;
    this.launchKind = launch.kind || "direct";
    this.launchDetails = launch;
    this.cwd = cwd;
    this.env = env;
    this.clientInfo = { ...clientInfo };
    this.capabilities = { ...capabilities };
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 30000);
    this.stopTimeoutMs = Math.max(1, Number(stopTimeoutMs) || 2000);
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.onServerRequest = typeof onServerRequest === "function" ? onServerRequest : null;
    this.onStatus = typeof onStatus === "function" ? onStatus : null;
    this.onStderr = typeof onStderr === "function" ? onStderr : null;
    this.onProtocolError = typeof onProtocolError === "function" ? onProtocolError : null;
    this.child = null;
    this.state = "stopped";
    this.initialization = null;
    this.lastError = "";
    this.lastStderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.startPromise = null;
    this.stopPromise = null;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
  }

  get status() { return this.getStatus(); }

  getStatus() {
    return {
      state: this.state,
      running: !!this.child,
      ready: this.state === "ready",
      initialized: !!this.initialization,
      pid: Number(this.child?.pid) || null,
      command: this.command,
      args: [...this.args],
      requestedCommand: this.requestedCommand,
      launchKind: this.launchKind,
      pendingRequests: this.pending.size,
      pendingServerRequests: this.serverRequests.size,
      lastError: this.lastError,
      lastStderr: this.lastStderr
    };
  }

  async start(overrides = {}) {
    if (this.state === "ready") return this.initialization;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    this.state = "starting";
    this.lastError = "";
    this.#statusChanged();
    this.startPromise = this.#start(overrides).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start(overrides) {
    let child;
    try {
      child = this.spawnProcess(this.command, this.args, {
        cwd: overrides.cwd ?? this.cwd,
        env: overrides.env ?? this.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (cause) {
      this.state = "error";
      this.lastError = cause?.message || String(cause);
      this.#statusChanged();
      throw new CodexAppServerError(`Could not start Codex app-server: ${this.lastError}`, { cause });
    }
    if (!child?.stdin || !child?.stdout) {
      this.state = "error";
      this.lastError = "spawn did not return piped stdin and stdout";
      this.#statusChanged();
      throw new CodexAppServerError(`Could not start Codex app-server: ${this.lastError}`);
    }
    this.child = child;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.#attach(child);
    try {
      const params = {
        clientInfo: { ...this.clientInfo, ...(overrides.clientInfo || {}) },
        capabilities: { ...this.capabilities, ...(overrides.capabilities || {}) }
      };
      const result = await this.request("initialize", params, { timeoutMs: overrides.timeoutMs });
      this.notify("initialized", {});
      this.initialization = result;
      this.state = "ready";
      this.#statusChanged();
      return result;
    } catch (cause) {
      this.lastError = cause?.message || String(cause);
      await this.stop().catch(() => {});
      this.state = "error";
      this.#statusChanged();
      throw cause;
    }
  }

  #attach(child) {
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stdoutBuffer += this.stdoutDecoder.write(chunk);
      this.#drainLines();
    });
    child.stdout.on("end", () => {
      if (this.child !== child) return;
      this.stdoutBuffer += this.stdoutDecoder.end();
      this.#drainLines(true);
    });
    child.stderr?.on("data", (chunk) => {
      if (this.child !== child) return;
      const text = String(chunk);
      this.lastStderr = `${this.lastStderr}${text}`.slice(-8000);
      try { this.onStderr?.(text); } catch {}
      this.emit("stderr", text);
      this.#statusChanged();
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.lastError = error?.message || String(error);
      this.emit("processError", error);
      this.#finishChild(child, new CodexAppServerError(`Codex app-server process error: ${this.lastError}`, { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      const expected = this.state === "stopping";
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      const error = expected ? null : new CodexAppServerError(`Codex app-server stopped unexpectedly (${detail})`);
      if (error) this.lastError = error.message;
      this.#finishChild(child, error);
      this.emit("exit", { code, signal, expected });
    });
  }

  #drainLines(flush = false) {
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.#receive(line);
    }
    if (flush && this.stdoutBuffer.trim()) {
      const line = this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.#receive(line);
    }
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch (cause) {
      const error = new CodexAppServerError("Codex app-server sent invalid JSONL", { cause, data: line.slice(0, 500) });
      try { this.onProtocolError?.(error, line); } catch {}
      this.emit("protocolError", error, line);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      const error = new CodexAppServerError("Codex app-server sent a non-object message", { data: message });
      try { this.onProtocolError?.(error, line); } catch {}
      this.emit("protocolError", error, line);
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      this.#resolveResponse(message);
      return;
    }
    if (message.method && Object.hasOwn(message, "id")) {
      this.#serverRequest(message);
      return;
    }
    if (message.method) {
      if (message.method === "serverRequest/resolved" && message.params?.requestId !== undefined) {
        this.serverRequests.delete(message.params.requestId);
      }
      try { this.onEvent?.(message); } catch {}
      this.emit("event", message);
      // EventEmitter reserves `error` for thrown process errors, while Codex
      // also has an ordinary mid-turn notification named `error`.
      this.emit(`notification:${message.method}`, message.params, message);
      if (message.method === "error") this.emit("codexError", message.params, message);
      else this.emit(message.method, message.params, message);
      this.#statusChanged();
      return;
    }
    const error = new CodexAppServerError("Codex app-server sent an unknown message", { data: message });
    try { this.onProtocolError?.(error, line); } catch {}
    this.emit("protocolError", error, line);
  }

  #resolveResponse(message) {
    const entry = this.pending.get(message.id);
    if (!entry) {
      const error = new CodexAppServerError(`Received a response for unknown request ${message.id}`, { data: message });
      try { this.onProtocolError?.(error, JSON.stringify(message)); } catch {}
      this.emit("protocolError", error, JSON.stringify(message));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    this.#statusChanged();
    if (message.error) {
      entry.reject(new CodexAppServerError(message.error.message, {
        code: message.error.code,
        data: message.error.data,
        method: entry.method
      }));
    } else {
      entry.resolve(message.result);
    }
  }

  #serverRequest(message) {
    this.serverRequests.set(message.id, message);
    const respond = (result) => this.respond(message.id, result);
    const respondError = (error) => this.respondError(message.id, error);
    this.emit("serverRequest", message, respond, respondError);
    this.#statusChanged();
    if (!this.onServerRequest) return;
    let result;
    try { result = this.onServerRequest(message, respond, respondError); }
    catch (error) { respondError(error); return; }
    Promise.resolve(result).then((value) => {
      if (value !== undefined && this.serverRequests.has(message.id)) respond(value);
    }, (error) => {
      if (this.serverRequests.has(message.id)) respondError(error);
    });
  }

  #write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || this.state === "stopping") {
      throw new CodexAppServerError("Codex app-server is not running");
    }
    const line = `${JSON.stringify(message)}\n`;
    try { this.child.stdin.write(line); }
    catch (cause) { throw new CodexAppServerError("Could not write to Codex app-server", { cause }); }
    this.emit("sent", message);
  }

  request(method, params = {}, { timeoutMs } = {}) {
    if (!method) return Promise.reject(new TypeError("method is required"));
    const id = this.nextId++;
    const duration = Math.max(1, Number(timeoutMs) || this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.#statusChanged();
        reject(new CodexAppServerError(`Codex app-server request timed out after ${duration}ms`, { code: -32098, method }));
      }, duration);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.#statusChanged();
      try { this.#write({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#statusChanged();
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!method) throw new TypeError("method is required");
    this.#write({ method, params });
  }

  respond(idOrRequest, result = {}) {
    const id = requestId(idOrRequest);
    if (id === undefined || id === null) throw new TypeError("server request id is required");
    this.#write({ id, result });
    this.serverRequests.delete(id);
    this.#statusChanged();
  }

  respondError(idOrRequest, error) {
    const id = requestId(idOrRequest);
    if (id === undefined || id === null) throw new TypeError("server request id is required");
    this.#write({ id, error: rpcError(error) });
    this.serverRequests.delete(id);
    this.#statusChanged();
  }

  respondApproval(idOrRequest, decision = "accept") {
    const validObject = decision && typeof decision === "object" && (
      Object.hasOwn(decision, "acceptWithExecpolicyAmendment") ||
      Object.hasOwn(decision, "applyNetworkPolicyAmendment")
    );
    if (!APPROVAL_DECISIONS.has(decision) && !validObject) throw new TypeError("invalid Codex approval decision");
    this.respond(idOrRequest, { decision });
  }

  approve(idOrRequest) { this.respondApproval(idOrRequest, "accept"); }
  approveForSession(idOrRequest) { this.respondApproval(idOrRequest, "acceptForSession"); }
  decline(idOrRequest) { this.respondApproval(idOrRequest, "decline"); }
  cancelApproval(idOrRequest) { this.respondApproval(idOrRequest, "cancel"); }

  approveWithExecpolicyAmendment(idOrRequest, amendment) {
    this.respondApproval(idOrRequest, { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } });
  }

  applyNetworkPolicyAmendment(idOrRequest, amendment) {
    this.respondApproval(idOrRequest, { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }

  accountRead({ refreshToken = false } = {}) {
    return this.request("account/read", { refreshToken: !!refreshToken });
  }

  modelList(options = {}) { return this.request("model/list", { ...options }); }

  threadStart(options = {}) { return this.request("thread/start", { ...options }); }

  threadResume(threadId, options = {}) {
    if (threadId && typeof threadId === "object") return this.request("thread/resume", { ...threadId });
    return this.request("thread/resume", { threadId, ...options });
  }

  turnStart(threadId, input, options = {}) {
    if (threadId && typeof threadId === "object") return this.request("turn/start", { ...threadId });
    return this.request("turn/start", { threadId, input: inputItems(input), ...options });
  }

  turnSteer(threadId, turnId, input, options = {}) {
    if (threadId && typeof threadId === "object") return this.request("turn/steer", { ...threadId });
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: inputItems(input),
      ...options
    });
  }

  turnInterrupt(threadId, turnId) {
    if (threadId && typeof threadId === "object") return this.request("turn/interrupt", { ...threadId });
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async stop({ timeoutMs = this.stopTimeoutMs } = {}) {
    if (!this.child) {
      this.state = "stopped";
      this.initialization = null;
      this.#statusChanged();
      return;
    }
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    this.state = "stopping";
    this.#statusChanged();
    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) this.#finishChild(child, null);
        resolve();
      };
      child.once("close", finish);
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        setTimeout(finish, 50).unref?.();
      }, Math.max(1, Number(timeoutMs) || this.stopTimeoutMs));
      timer.unref?.();
      try { child.stdin.end(); } catch { finish(); }
      if (child.exitCode !== null && child.exitCode !== undefined) finish();
    }).finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async restart(options = {}) {
    await this.stop(options);
    return this.start(options);
  }

  #finishChild(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.initialization = null;
    this.serverRequests.clear();
    const failure = error || new CodexAppServerError("Codex app-server stopped");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    this.pending.clear();
    this.state = error ? "error" : "stopped";
    this.#statusChanged();
  }

  #statusChanged() {
    const status = this.getStatus();
    try { this.onStatus?.(status); } catch {}
    this.emit("status", status);
  }
}

export function createCodexAppServer(options) { return new CodexAppServer(options); }
