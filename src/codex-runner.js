import { createCodexAppServer } from "./codex-app-server.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "webSearch",
  "imageView",
  "contextCompaction"
]);
const BOOTSTRAP_MESSAGES = 10;
const BOOTSTRAP_CHARS = 12000;

function asText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return part.text || part.content || "";
  }).filter(Boolean).join("\n");
}

function latestUserInput(messages, explicitInput) {
  const supplied = asText(explicitInput).trim();
  if (supplied) return supplied;
  for (let index = (messages?.length || 0) - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") continue;
    const text = asText(messages[index]?.content).trim();
    if (text) return text;
  }
  return "";
}

/** Build a bounded one-time handoff when a Boolean chat first becomes a Codex thread. */
export function buildCodexBootstrap(messages = [], input = "", {
  maxMessages = BOOTSTRAP_MESSAGES,
  maxChars = BOOTSTRAP_CHARS
} = {}) {
  const current = latestUserInput(messages, input);
  const candidates = [];
  let skippedCurrent = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const text = asText(message.content).trim();
    if (!text) continue;
    if (!skippedCurrent && message.role === "user" && text === current) {
      skippedCurrent = true;
      continue;
    }
    candidates.unshift({ role: message.role, text });
    if (candidates.length >= Math.max(0, Number(maxMessages) || 0)) break;
  }
  let history = candidates.map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`).join("\n\n");
  const limit = Math.max(1000, Number(maxChars) || BOOTSTRAP_CHARS);
  const reserved = Math.min(limit, current.length + 240);
  const historyBudget = Math.max(0, limit - reserved);
  if (history.length > historyBudget) history = historyBudget ? history.slice(-historyBudget) : "";
  if (!history) return current;
  return [
    "Continue this existing Boolean conversation. The excerpt below is context only; follow the current request at the end.",
    "",
    history,
    "",
    "Current request:",
    current
  ].join("\n");
}

function normalizeStatus(value) {
  const compact = String(value || "").replace(/[_ -]/g, "").toLowerCase();
  if (compact === "inprogress") return "in_progress";
  if (compact === "completed") return "completed";
  if (compact === "failed") return "failed";
  if (compact === "interrupted" || compact === "cancelled" || compact === "canceled") return "interrupted";
  return compact || "in_progress";
}

function idFrom(result, kind) {
  if (!result || typeof result !== "object") return "";
  const nested = result[kind];
  return String(nested?.id || result[`${kind}Id`] || result.id || "");
}

function eventIds(message) {
  const params = message?.params || {};
  return {
    threadId: String(params.threadId || params.thread?.id || ""),
    turnId: String(params.turnId || params.turn?.id || "")
  };
}

function missingThread(error) {
  const message = `${error?.message || ""} ${error?.data ? JSON.stringify(error.data) : ""}`;
  return /(?:thread|rollout|conversation).{0,50}(?:not found|does not exist|missing|unknown|unavailable)|(?:not found|missing).{0,50}(?:thread|rollout)/i.test(message);
}

function callback(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  try { return fn(...args); } catch { return undefined; }
}

function errorText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.message || value.error?.message || value.additionalDetails || JSON.stringify(value));
}

function numberAt(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function normalizeUsage(source) {
  if (!source || typeof source !== "object") return null;
  const input = numberAt(source, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]);
  const output = numberAt(source, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]);
  const cachedInput = numberAt(source, ["cachedInputTokens", "cached_input_tokens", "cachedInput", "cached_input"]);
  const reasoningOutput = numberAt(source, ["reasoningOutputTokens", "reasoning_output_tokens", "reasoningOutput"]);
  const total = numberAt(source, ["totalTokens", "total_tokens", "total"]) || input + output;
  if (!input && !output && !cachedInput && !reasoningOutput && !total) return null;
  return { input, output, cachedInput, reasoningOutput, total };
}

function usageFromEvent(params, isNewThread, run) {
  const root = params?.tokenUsage || params?.usage || params;
  const last = normalizeUsage(root?.last || root?.turn || root?.current);
  if (last) return last;
  const total = normalizeUsage(root?.total || root);
  if (!total) return null;
  if (isNewThread) return total;
  if (!run.usageBaseline) {
    run.usageBaseline = total;
    return null;
  }
  return {
    input: Math.max(0, total.input - run.usageBaseline.input),
    output: Math.max(0, total.output - run.usageBaseline.output),
    cachedInput: Math.max(0, total.cachedInput - run.usageBaseline.cachedInput),
    reasoningOutput: Math.max(0, total.reasoningOutput - run.usageBaseline.reasoningOutput),
    total: Math.max(0, total.total - run.usageBaseline.total)
  };
}

function sandboxFor({ sandboxPolicy, projectDir, networkAccess = false }) {
  if (sandboxPolicy && typeof sandboxPolicy === "object") return { ...sandboxPolicy };
  if (projectDir) {
    return {
      type: "workspaceWrite",
      writableRoots: [projectDir],
      networkAccess: !!networkAccess
    };
  }
  return { type: "readOnly", access: { type: "fullAccess" } };
}

function activityLabel(item) {
  switch (item?.type) {
    case "commandExecution": return "Running a command...";
    case "fileChange": return "Editing files...";
    case "mcpToolCall": return `Using ${item.server || "a connected tool"}...`;
    case "dynamicToolCall": return `Using ${item.tool || "a tool"}...`;
    case "collabToolCall": return "Coordinating agent work...";
    case "webSearch": return "Searching the web...";
    case "imageView": return "Inspecting an image...";
    case "contextCompaction": return "Compacting task context...";
    case "reasoning": return "Thinking...";
    case "plan": return "Planning the work...";
    default: return "Working...";
  }
}

function stepFromItem(item) {
  const type = item?.type || "tool";
  if (type === "commandExecution") {
    return {
      name: "run_command",
      args: { command: item.command, cwd: item.cwd || "" },
      result: item.aggregatedOutput || (item.exitCode == null ? "" : `Exit code ${item.exitCode}`),
      item
    };
  }
  if (type === "fileChange") return { name: "apply_patch", args: { changes: item.changes || [] }, result: item.status || "", item };
  if (type === "mcpToolCall") return { name: item.tool || "mcp_tool", args: item.arguments || {}, result: item.result || item.error || "", item };
  if (type === "dynamicToolCall") return { name: item.tool || "dynamic_tool", args: item.arguments || {}, result: item.contentItems || item.success || "", item };
  if (type === "webSearch") return { name: "web_search", args: { query: item.query || "", action: item.action }, result: item.status || "", item };
  if (type === "imageView") return { name: "view_image", args: { path: item.path || "" }, result: item.status || "", item };
  return { name: type, args: {}, result: item.status || "", item };
}

function approvalResult(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, "decision")) return value;
  if (value && typeof value === "object" && value.approved !== undefined) {
    return { decision: value.approved ? (value.session ? "acceptForSession" : "accept") : "decline" };
  }
  if (value === true) return { decision: "accept" };
  if (value === false || value == null) return { decision: "decline" };
  const decision = String(value);
  if (["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return { decision };
  return { decision: "decline" };
}

function userInputResult(value, questions = []) {
  if (value && typeof value === "object" && value.answers && typeof value.answers === "object") return value;
  const answers = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, answer] of Object.entries(value)) {
      const list = Array.isArray(answer) ? answer : [answer];
      answers[key] = { answers: list.filter((entry) => entry != null).map(String) };
    }
  } else if (questions.length) {
    const list = Array.isArray(value) ? value : (value == null ? [] : [value]);
    answers[questions[0].id] = { answers: list.map(String) };
  }
  return { answers };
}

function abortError() {
  const error = new Error("Codex turn was interrupted before it started.");
  error.name = "AbortError";
  return error;
}

export class CodexRunner {
  constructor({ client = null, createClient = createCodexAppServer, clientOptions = {} } = {}) {
    if (client && typeof client.start !== "function") throw new TypeError("client.start is required");
    if (!client && typeof createClient !== "function") throw new TypeError("createClient must be a function");
    this.client = client;
    this.createClient = createClient;
    this.clientOptions = { ...clientOptions };
    this.boundClient = null;
    this.activeRuns = new Set();
    this.pendingServerRequests = new Map();
    this.startPromise = null;
    this.onEvent = (message) => this.#routeEvent(message);
    this.onServerRequest = (message, respond, respondError) => this.#routeServerRequest(message, respond, respondError);
    this.onExit = (info) => this.#failRuns(new Error(`Codex app-server stopped${info?.code == null ? "" : ` with exit code ${info.code}`}.`));
    this.onProcessError = (error) => this.#failRuns(error);
  }

  #getClient() {
    if (!this.client) this.client = this.createClient(this.clientOptions);
    if (this.boundClient !== this.client) {
      if (typeof this.client.on !== "function") throw new TypeError("Codex app-server client must support events");
      this.client.on("event", this.onEvent);
      this.client.on("serverRequest", this.onServerRequest);
      this.client.on("exit", this.onExit);
      this.client.on("processError", this.onProcessError);
      this.boundClient = this.client;
    }
    return this.client;
  }

  getStatus() {
    const client = this.client;
    const status = typeof client?.getStatus === "function" ? client.getStatus() : (client?.status || { state: "stopped", ready: false });
    return {
      ...status,
      activeTurns: [...this.activeRuns].map((run) => ({ threadId: run.threadId, turnId: run.turnId }))
    };
  }

  async ensureReady() {
    const client = this.#getClient();
    const status = typeof client.getStatus === "function" ? client.getStatus() : client.status;
    if (status?.ready) return status;
    if (!this.startPromise) this.startPromise = Promise.resolve(client.start()).finally(() => { this.startPromise = null; });
    await this.startPromise;
    return this.getStatus();
  }

  async stop() {
    if (this.client?.stop) await this.client.stop();
  }

  async interrupt(threadId, turnId) {
    if (!threadId || !turnId || !this.client) return false;
    await this.client.turnInterrupt(threadId, turnId);
    return true;
  }

  async runCodexTurn(options = {}) {
    const {
      messages = [],
      input,
      mapping = {},
      model = "",
      projectDir = "",
      cwd = projectDir || "",
      approvalPolicy = "on-request",
      sandboxPolicy,
      networkAccess = false,
      personality = "friendly",
      effort,
      summary = "concise",
      serviceName = "boolean",
      signal,
      onStatus,
      onToken,
      onPlan,
      onItem,
      onStep,
      onUsage,
      onAnswer,
      onMapping,
      onIds,
      onApproval = options.approve,
      onUserInput = options.requestUserInput,
      onPermissions,
      onRequestResolved
    } = options;
    if (signal?.aborted) throw abortError();
    callback(onStatus, "Starting Codex...");
    const client = this.#getClient();
    await this.ensureReady();
    const currentInput = latestUserInput(messages, input);
    if (!currentInput) throw new TypeError("A user message is required to start a Codex turn");
    const policy = sandboxFor({ sandboxPolicy, projectDir: cwd, networkAccess });
    const commonThread = {
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
      approvalPolicy,
      sandbox: policy.type,
      personality,
      serviceName
    };
    let threadId = String(mapping.threadId || mapping.codexThreadId || "");
    let isNewThread = !threadId;
    let threadResult;
    if (threadId) {
      callback(onStatus, "Resuming the Codex task...");
      try {
        threadResult = await client.threadResume(threadId, commonThread);
      } catch (error) {
        if (!missingThread(error)) throw error;
        callback(onStatus, "The saved Codex task is unavailable - starting a fresh task...");
        threadId = "";
        isNewThread = true;
      }
    }
    if (!threadId) {
      callback(onStatus, "Opening a new Codex task...");
      threadResult = await client.threadStart(commonThread);
      threadId = idFrom(threadResult, "thread");
    } else {
      threadId = idFrom(threadResult, "thread") || threadId;
    }
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    let mapped = {
      ...mapping,
      threadId,
      model: model || mapping.model || "",
      updatedAt: Date.now()
    };
    if (typeof onMapping === "function") await onMapping(mapped);
    callback(onIds, { threadId, turnId: "" });

    let complete;
    let fail;
    const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const run = {
      threadId,
      turnId: "",
      model: model || mapping.model || "",
      isNewThread,
      callbacks: { onStatus, onToken, onPlan, onItem, onStep, onApproval, onUserInput, onPermissions, onRequestResolved },
      items: new Map(),
      finalByItem: new Map(),
      finalText: "",
      lastError: "",
      usage: null,
      usageBaseline: null,
      terminal: null,
      complete,
      fail
    };
    this.activeRuns.add(run);
    let interruptRequested = false;
    let interruptSent = false;
    const requestInterrupt = () => {
      interruptRequested = true;
      if (!run.turnId || interruptSent || run.terminal) return;
      interruptSent = true;
      Promise.resolve(client.turnInterrupt(run.threadId, run.turnId)).catch((error) => {
        if (!run.terminal) callback(onStatus, `Could not interrupt Codex: ${errorText(error)}`);
      });
    };
    signal?.addEventListener("abort", requestInterrupt, { once: true });
    try {
      const turnInput = isNewThread ? buildCodexBootstrap(messages, currentInput) : currentInput;
      callback(onStatus, "Codex is working...");
      const turnOptions = {
        ...(cwd ? { cwd } : {}),
        approvalPolicy,
        sandboxPolicy: policy,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(summary ? { summary } : {}),
        ...(personality ? { personality } : {})
      };
      const turnResult = await client.turnStart(threadId, [{ type: "text", text: turnInput }], turnOptions);
      run.turnId = idFrom(turnResult, "turn") || run.turnId;
      if (!run.turnId) throw new Error("Codex app-server did not return a turn id");
      mapped = { ...mapped, turnId: run.turnId, lastTurnId: run.turnId, updatedAt: Date.now() };
      if (typeof onMapping === "function") await onMapping(mapped);
      callback(onIds, { threadId, turnId: run.turnId });
      if (interruptRequested || signal?.aborted) requestInterrupt();
      const initialStatus = normalizeStatus(turnResult?.turn?.status);
      if (TERMINAL_STATUSES.has(initialStatus) && !run.terminal) {
        this.#finishRun(run, { turn: turnResult.turn });
      }
      const terminal = await completed;
      const status = normalizeStatus(terminal?.turn?.status || run.terminal?.status);
      const terminalError = errorText(terminal?.turn?.error) || run.lastError;
      const terminalUsageSource = terminal?.turn?.usage || terminal?.usage;
      const terminalUsage = normalizeUsage(terminalUsageSource)
        || usageFromEvent(terminalUsageSource, isNewThread, run);
      if (terminalUsage) run.usage = terminalUsage;
      if (run.usage) callback(onUsage, {
        provider: "codex",
        model: run.model,
        input: run.usage.input,
        output: run.usage.output,
        cachedInput: run.usage.cachedInput,
        reasoningOutput: run.usage.reasoningOutput,
        estimated: false
      });
      mapped = { ...mapped, status, updatedAt: Date.now() };
      if (typeof onMapping === "function") await onMapping(mapped);
      if (status === "completed") callback(onStatus, "Codex finished the task.");
      else if (status === "interrupted") callback(onStatus, "Codex stopped safely.");
      else callback(onStatus, terminalError ? `Codex stopped with an error: ${terminalError}` : "Codex stopped with an error.");
      if (run.finalText) callback(onAnswer, run.finalText, { status, threadId, turnId: run.turnId });
      return {
        content: run.finalText,
        status,
        error: terminalError,
        threadId,
        turnId: run.turnId,
        mapping: mapped,
        usage: run.usage ? { ...run.usage } : null
      };
    } finally {
      signal?.removeEventListener?.("abort", requestInterrupt);
      this.activeRuns.delete(run);
    }
  }

  #matchingRun(message) {
    const ids = eventIds(message);
    const candidates = [...this.activeRuns].filter((run) => {
      if (ids.threadId && ids.threadId !== run.threadId) return false;
      if (ids.turnId && run.turnId && ids.turnId !== run.turnId) return false;
      return true;
    });
    if (candidates.length === 1) return candidates[0];
    if (!ids.threadId && !ids.turnId && this.activeRuns.size === 1) return [...this.activeRuns][0];
    return null;
  }

  #routeEvent(message) {
    const method = message.method;
    const params = message.params || {};
    if (method === "serverRequest/resolved") {
      const key = String(params.requestId ?? "");
      const pending = this.pendingServerRequests.get(key);
      if (pending) {
        this.pendingServerRequests.delete(key);
        callback(pending.run.callbacks.onRequestResolved, {
          requestId: params.requestId,
          method: pending.message?.method || "",
          threadId: pending.run.threadId,
          turnId: pending.run.turnId
        });
      }
      return;
    }
    const run = this.#matchingRun(message);
    if (!run) return;
    const ids = eventIds(message);
    if (!run.turnId && ids.turnId) run.turnId = ids.turnId;
    try {
      if (method === "turn/started") {
        callback(run.callbacks.onStatus, "Codex is working...");
        return;
      }
      if (method === "turn/plan/updated") {
        callback(run.callbacks.onPlan, params.plan || [], {
          explanation: params.explanation || "",
          threadId: run.threadId,
          turnId: ids.turnId || run.turnId
        });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = usageFromEvent(params, run.isNewThread, run);
        if (usage) run.usage = usage;
        return;
      }
      if (method === "error") {
        run.lastError = errorText(params.error || params);
        callback(run.callbacks.onStatus, run.lastError ? `Codex error: ${run.lastError}` : "Codex reported an error.");
        return;
      }
      if (method === "warning" || method === "configWarning") {
        callback(run.callbacks.onStatus, params.message || params.summary || "Codex reported a warning.", { warning: true });
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        const item = params.item || {};
        if (item.id) run.items.set(item.id, item);
        callback(run.callbacks.onItem, { method, item, threadId: run.threadId, turnId: ids.turnId || run.turnId });
        if (method === "item/started" && TOOL_ITEM_TYPES.has(item.type)) callback(run.callbacks.onStatus, activityLabel(item));
        if (item.type === "agentMessage") this.#agentItem(run, item, method);
        if (item.type === "reasoning" && method === "item/completed") {
          const summary = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || part).join("\n") : item.summary;
          if (summary) callback(run.callbacks.onStatus, String(summary), { kind: "reasoning" });
        }
        if (method === "item/completed" && TOOL_ITEM_TYPES.has(item.type)) callback(run.callbacks.onStep, stepFromItem(item));
        return;
      }
      if (method === "item/agentMessage/delta") {
        const itemId = String(params.itemId || "agent");
        const item = run.items.get(itemId) || {};
        const phase = params.phase || item.phase || "final_answer";
        const delta = String(params.delta || "");
        if (!delta) return;
        if (phase === "commentary") {
          const existing = run.items.get(itemId) || { id: itemId, type: "agentMessage", phase };
          existing.text = `${existing.text || ""}${delta}`;
          run.items.set(itemId, existing);
        } else {
          const streamed = `${run.finalByItem.get(itemId) || ""}${delta}`;
          run.finalByItem.set(itemId, streamed);
          run.finalText = streamed;
          callback(run.callbacks.onToken, delta);
        }
        return;
      }
      if (method === "item/reasoning/summaryTextDelta") {
        if (params.delta) callback(run.callbacks.onStatus, String(params.delta), { kind: "reasoning_delta" });
        return;
      }
      if (method === "item/plan/delta") {
        callback(run.callbacks.onItem, { method, params, threadId: run.threadId, turnId: ids.turnId || run.turnId });
        return;
      }
      if (method === "item/commandExecution/outputDelta") {
        callback(run.callbacks.onItem, { method, params, threadId: run.threadId, turnId: ids.turnId || run.turnId });
        return;
      }
      if (method === "turn/completed") this.#finishRun(run, params);
    } catch (error) {
      callback(run.callbacks.onStatus, `Could not present a Codex update: ${errorText(error)}`);
    }
  }

  #agentItem(run, item, method) {
    const phase = item.phase || "final_answer";
    const text = String(item.text || "");
    if (phase === "commentary") {
      if (method === "item/completed" && text) callback(run.callbacks.onStatus, text, { kind: "commentary" });
      return;
    }
    if (method !== "item/completed" || !text) return;
    const streamed = run.finalByItem.get(item.id) || "";
    run.finalText = text;
    if (!streamed) callback(run.callbacks.onToken, text);
    else if (text.startsWith(streamed) && text.length > streamed.length) callback(run.callbacks.onToken, text.slice(streamed.length));
    run.finalByItem.set(item.id, text);
  }

  #finishRun(run, params) {
    if (run.terminal) return;
    const status = normalizeStatus(params?.turn?.status);
    if (!TERMINAL_STATUSES.has(status)) return;
    // `turn/completed` carries the final agent message as a summary fallback.
    // Consume it when an item notification or delta was missed so a completed
    // turn never appears as an empty response.
    const fallback = Array.isArray(params?.turn?.items)
      ? [...params.turn.items].reverse().find((item) => item?.type === "agentMessage" && item?.text)
      : null;
    if (fallback) this.#agentItem(run, fallback, "item/completed");
    run.terminal = { status, params };
    run.complete(params);
  }

  async #routeServerRequest(message, respond, respondError) {
    const run = this.#matchingRun(message);
    const method = message?.method || "";
    const params = message?.params || {};
    if (!run) {
      if (APPROVAL_METHODS.has(method)) respond({ decision: "cancel" });
      else if (method === "item/tool/requestUserInput") respond({ answers: {} });
      else if (method === "item/permissions/requestApproval") respond({ permissions: {}, scope: "turn" });
      else respondError({ code: -32601, message: `Boolean does not handle ${method}` });
      return;
    }
    const requestKey = String(message.id);
    const pending = { run, message };
    this.pendingServerRequests.set(requestKey, pending);
    const finish = (value, isError = false) => {
      if (this.pendingServerRequests.get(requestKey) !== pending) return;
      this.pendingServerRequests.delete(requestKey);
      if (isError) respondError(value);
      else respond(value);
    };
    try {
      if (APPROVAL_METHODS.has(method)) {
        const kind = method.includes("commandExecution") ? "command" : "file";
        const result = await run.callbacks.onApproval?.({
          kind,
          method,
          requestId: message.id,
          threadId: run.threadId,
          turnId: run.turnId,
          itemId: params.itemId || "",
          summary: params.reason || (kind === "command" ? String(params.command || "Run this command") : "Apply these file changes"),
          params
        });
        finish(approvalResult(result));
        return;
      }
      if (method === "item/tool/requestUserInput") {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const result = await run.callbacks.onUserInput?.({
          requestId: message.id,
          threadId: run.threadId,
          turnId: run.turnId,
          questions,
          isBlocking: params.isBlocking !== false,
          autoResolutionMs: params.autoResolutionMs ?? null,
          params
        });
        finish(userInputResult(result, questions));
        return;
      }
      if (method === "item/permissions/requestApproval") {
        const result = await run.callbacks.onPermissions?.({
          requestId: message.id,
          threadId: run.threadId,
          turnId: run.turnId,
          params
        });
        finish(result && typeof result === "object" ? result : { permissions: {}, scope: "turn" });
        return;
      }
      finish({ code: -32601, message: `Boolean does not handle ${method}` }, true);
    } catch (error) {
      finish(error, true);
    }
  }

  #failRuns(error) {
    for (const run of this.activeRuns) {
      if (!run.terminal) run.fail(error instanceof Error ? error : new Error(errorText(error)));
    }
  }
}

export function createCodexRunner(options) { return new CodexRunner(options); }

let defaultRunner = null;

/** Convenience API for callers that do not need to manage a runner instance. */
export function runCodexTurn(options = {}) {
  if (options.runner) return options.runner.runCodexTurn(options);
  if (options.client || options.createClient || options.clientOptions) {
    const runner = new CodexRunner({
      client: options.client || null,
      createClient: options.createClient || createCodexAppServer,
      clientOptions: options.clientOptions || {}
    });
    return runner.runCodexTurn(options);
  }
  if (!defaultRunner) defaultRunner = new CodexRunner();
  return defaultRunner.runCodexTurn(options);
}

export async function stopDefaultCodexRunner() {
  if (!defaultRunner) return;
  const runner = defaultRunner;
  defaultRunner = null;
  await runner.stop();
}
