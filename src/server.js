// Local HTTP server hosting the Boolean UI and bridging it to the agent loop.
// NDJSON streaming for chat; approvals round-trip to the browser as events.
// Multi-thread conversation store, per-thread stop/abort, image attachments.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as sea from "node:sea";
import {
  saveConfig, currentModel, setCurrentModel, PROVIDERS, CLOUD,
  APP_VERSION, APP_DISPLAY_VERSION, APP_NAME, APP_TAGLINE, CLOUD_BACKEND_URL
} from "./config.js";
import { systemPrompt, projectBrief, runTurn, runSubagent, estimateContext } from "./agent.js";
import { resolveTarget, chatCompletion, listProviderModels, backendUp } from "./providers.js";
import * as engine from "./engine.js";
import { recordUsage, resetUsage, summarizeUsage } from "./usage.js";
import { saveThreads, loadThreads, clearThreads } from "./store.js";
import { handleBrowse, clearCookies } from "./browse.js";
import { learnFromUserText, publicPreferences, deletePreference, clearPreferences } from "./preferences.js";
import {
  McpHttpError,
  mcpTestConnection as testMcpConnector,
  discoverMcpOAuth,
  createPkce,
  registerMcpOAuthClient,
  buildMcpAuthorizationUrl,
  exchangeMcpAuthorizationCode,
  classifyMcpError,
  mcpStatusPayload,
  MCP_STATUS
} from "./mcp.js";
import {
  createEmailOAuth,
  exchangeEmailCode,
  getEmailAccount,
  publicEmailConnections
} from "./email.js";
import { manageAutomation, setAutomationActionHandler, startAutomationScheduler } from "./platform.js";

function loadAsset(name, devPath) {
  if (sea.isSea && sea.isSea()) {
    return Buffer.from(sea.getAsset(name));
  }
  return fs.readFileSync(new URL(devPath, import.meta.url));
}

const IS_SEA = !!(sea.isSea && sea.isSea());
const loadUiHtml = () => loadAsset("ui.html", "./ui.html").toString("utf8");
function loadLegalText(file) {
  if (IS_SEA) return fs.readFileSync(path.join(path.dirname(process.execPath), file), "utf8");
  return fs.readFileSync(new URL(`../assets/${file}`, import.meta.url), "utf8");
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function publicCloudBackend(config) {
  const c = config.cloudBackend || {};
  return {
    url: c.url || "",
    signedIn: !!c.sessionToken,
    user: c.user || null,
    tokens: c.tokens || null
  };
}

function normalizeCloudBackendUrl(url) {
  const raw = String(url || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  const parsed = new URL(raw);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Cloud backend URL must start with http:// or https://");
  return parsed.toString().replace(/\/+$/, "");
}

async function cloudRequest(config, endpoint, options = {}) {
  const c = config.cloudBackend || {};
  const base = normalizeCloudBackendUrl(c.url || "");
  if (!base) throw new Error("Cloud backend URL is not set.");
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (options.auth !== false && c.sessionToken) headers.authorization = `Bearer ${c.sessionToken}`;
  const requestOptions = { ...options, headers };
  let res;
  try {
    res = await fetch(base + endpoint, requestOptions);
  } catch (err) {
    const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base);
    if (!isLocalDev || base === CLOUD_BACKEND_URL) throw err;
    config.cloudBackend = { ...c, url: CLOUD_BACKEND_URL, sessionToken: "", user: null, tokens: null };
    saveConfig(config);
    const fallbackHeaders = { ...headers };
    delete fallbackHeaders.authorization;
    res = await fetch(CLOUD_BACKEND_URL + endpoint, { ...requestOptions, headers: fallbackHeaders });
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  if (!res.ok) {
    if (res.status === 401 && options.auth !== false) {
      config.cloudBackend = { ...(config.cloudBackend || {}), sessionToken: "", user: null, tokens: null };
      saveConfig(config);
      const err = new Error("Your Boolean account session expired. Sign in again to continue.");
      err.status = 401;
      err.code = "cloud_auth_required";
      throw err;
    }
    const err = new Error(data.message || data.error || `Cloud backend error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function clearExpiredCloudSession(config, err) {
  if (err?.code !== "cloud_auth_required") return false;
  config.cloudBackend = { ...(config.cloudBackend || {}), sessionToken: "", user: null, tokens: null };
  saveConfig(config);
  return true;
}

// pull the plain-text part out of a message content (string or content array)
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  }
  return "";
}
function imagesOf(content) {
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  }
  return [];
}

function userTextOnly(content) {
  return textOf(content).split(/\n\nCURRENT APP CONTEXT\b/)[0].trim();
}

function shortThreadTitle(content) {
  const text = userTextOnly(content);
  const clean = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\w\s$%.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const low = clean.toLowerCase();
  if (!clean && imagesOf(content).length) return "Image question";
  const under = clean.match(/\b(tv|television|laptop|monitor|phone|tablet|headphones|camera)\b.*?\bunder\s+\$?(\d{2,5})/i);
  if (under) return `${cap(under[1] === "television" ? "TV" : under[1])} under $${under[2]}`;
  if (/\b(power\s*bi|powerbi)\b/.test(low)) return /recap|summar|report/.test(low) ? "PowerBI recap" : "PowerBI review";
  if (/\b(weather|forecast|temperature)\b/.test(low)) return "Weather";
  if (/\b(news|headlines|latest)\b/.test(low)) return "News search";
  if (/\b(email|reply|respond|outlook|gmail)\b/.test(low)) return "Email draft";
  if (/\bnotepad|notes?\b/.test(low)) return "Notepad";
  if (/\bsnip|screenshot|ocr|vision\b/.test(low)) return "Screen OCR";
  if (/\bsettings?\b/.test(low)) return "Settings";
  if (/\bbrowser\b/.test(low)) return "Browser";
  if (/\bpackage|deploy|installer|install\b/.test(low)) return "Package build";
  if (/\bfix|bug|error|issue\b/.test(low)) return "Fix " + firstTopic(clean.replace(/\b(can you|please|fix|bug|error|issue|this|it|the)\b/gi, ""));
  if (/\bbuild|create|make|app|project\b/.test(low)) return "Build " + firstTopic(clean.replace(/\b(can you|please|build|create|make|me|a|an|the)\b/gi, ""));
  if (/\bfind|search|look up|buy|best|compare|under\s+\$?\d+/i.test(clean)) return firstTopic(clean, 4) || "Search";
  return firstTopic(clean, 4) || "New chat";
}

function firstUserContent(t) {
  return (t?.messages || []).find((m) => m?.role === "user")?.content || "";
}

function repairAutoNotepadTitle(t) {
  if (t?.title !== "Notepad") return false;
  const next = shortThreadTitle(firstUserContent(t)).slice(0, 42);
  if (!next || next === "New chat" || next === "Notepad") return false;
  t.title = next;
  return true;
}

function cap(s) {
  s = String(s || "");
  return s.toUpperCase() === "TV" ? "TV" : s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

function firstTopic(s, max = 3) {
  const stop = new Set("can you could would please me my i need want give tell what whats what's how do does is are the a an to for of on in with and or this that it about".split(" "));
  const words = String(s || "").split(/\s+/).filter(Boolean).filter(w => !stop.has(w.toLowerCase()));
  return words.slice(0, max).map(w => /^\$?\d/.test(w) ? w : cap(w)).join(" ").slice(0, 36);
}

function publicConnectors(config) {
  const c = config.connectors || {};
  return {
    apis: Array.isArray(c.apis) ? c.apis.map((x) => ({
      id: x.id, name: x.name, baseUrl: x.baseUrl, model: x.model,
      enabled: x.enabled !== false, hasKey: !!x.apiKey, approvedUse: !!x.approvedUse,
      selected: config.provider === "customApi" && config.customApi?.connectionId === x.id
    })) : [],
    mcp: Array.isArray(c.mcp) ? c.mcp.map((x) => ({
      id: x.id, name: x.name, type: x.type || (x.url ? "remote" : "local"),
      url: x.url, command: x.command, args: x.args, enabled: x.enabled !== false,
      hasKey: !!(x.token || x.oauth?.accessToken), auth: x.oauth ? "oauth" : (x.token ? "bearer" : "none"),
      toolCount: Number.isFinite(Number(x.toolCount)) ? Number(x.toolCount) : undefined,
      tools: Array.isArray(x.tools) ? x.tools.slice(0, 20) : []
    })) : [],
    agents: Array.isArray(c.agents) ? c.agents.map((x) => ({
      id: x.id, name: x.name, url: x.url, enabled: x.enabled !== false, hasKey: !!x.apiKey
    })) : [],
    email: publicEmailConnections(config)
  };
}

function publicImageGeneration(config) {
  const providers = [];
  if (config.openai?.apiKey) providers.push({ id: "openai", name: "OpenAI" });
  if (config.customApi?.apiKey) providers.push({ id: "customApi", name: config.customApi.name || "Custom API" });
  for (const item of config.connectors?.apis || []) {
    if (item.enabled !== false && item.apiKey && !providers.some((entry) => entry.id === item.id)) {
      providers.push({ id: item.id, name: item.name || "API connection" });
    }
  }
  return {
    provider: config.imageGeneration?.provider || "openai",
    model: config.imageGeneration?.model || "gpt-image-1",
    size: config.imageGeneration?.size || "1024x1024",
    providers
  };
}

function cleanConnectorName(s) {
  return String(s || "").replace(/[^\w .:-]/g, "").trim().slice(0, 80);
}

function mergeConnectors(current, incoming) {
  const prevApis = new Map((current?.apis || []).map((a) => [a.id, a]));
  const prevAgents = new Map((current?.agents || []).map((a) => [a.id, a]));
  const prevMcp = new Map((current?.mcp || []).map((m) => [m.id, m]));
  const next = { apis: Array.isArray(current?.apis) ? current.apis : [], mcp: [], agents: [], email: current?.email || {} };
  if (Array.isArray(incoming?.apis)) {
    next.apis = incoming.apis.slice(0, 30).map((x) => {
      const id = String(x.id || crypto.randomUUID());
      const old = prevApis.get(id);
      const key = typeof x.apiKey === "string" && x.apiKey !== "__keep__" ? x.apiKey.trim() : (old?.apiKey || "");
      return {
        id,
        name: cleanConnectorName(x.name) || "API connection",
        baseUrl: String(x.baseUrl || "").trim().replace(/\/+$/, "").slice(0, 1000),
        model: String(x.model || "").trim().slice(0, 200),
        apiKey: key,
        approvedUse: !!x.approvedUse,
        enabled: x.enabled !== false
      };
    }).filter((x) => /^https?:\/\//i.test(x.baseUrl) && x.model);
  }
  if (Array.isArray(incoming?.mcp)) {
    next.mcp = incoming.mcp.slice(0, 30).map((x) => {
      const id = String(x.id || crypto.randomUUID());
      const old = prevMcp.get(id);
      const url = String(x.url || "").trim().slice(0, 1000);
      const command = String(x.command || "").trim().slice(0, 500);
      const type = /^https?:\/\//i.test(url) || x.type === "remote" ? "remote" : "local";
      // bearer token for remote servers; "__keep__" preserves the saved one
      const token = typeof x.token === "string" && x.token !== "__keep__" ? x.token.trim().slice(0, 4000) : (old?.token || "");
      return {
        id,
        name: cleanConnectorName(x.name) || "MCP server",
        type,
        url: type === "remote" ? url : "",
        command: type === "local" ? command : "",
        args: type === "local" ? String(x.args || "").trim().slice(0, 1000) : "",
        token: type === "remote" ? token : "",
        oauth: type === "remote" ? (old?.oauth || null) : null,
        enabled: x.enabled !== false
      };
    }).filter((x) => x.type === "remote" ? /^https?:\/\//i.test(x.url) : x.command);
  }
  if (Array.isArray(incoming?.agents)) {
    next.agents = incoming.agents.slice(0, 30).map((x) => {
      const id = String(x.id || crypto.randomUUID());
      const old = prevAgents.get(id);
      const key = typeof x.apiKey === "string" && x.apiKey !== "__keep__" ? x.apiKey.trim() : (old?.apiKey || "");
      return {
        id,
        name: cleanConnectorName(x.name) || "Agent",
        url: String(x.url || "").trim().slice(0, 1000),
        apiKey: key,
        enabled: x.enabled !== false
      };
    }).filter((x) => /^https?:\/\//i.test(x.url));
  }
  return next;
}

// short human label for a tool step shown in the chat log
function stepSummary(name, args) {
  args = args || {};
  if (name === "run_command") return `${args.shell || "powershell"} ▸ ${args.command || ""}`;
  if (name === "write_file") return `write ${args.path || ""}`;
  if (name === "read_file") return `read ${args.path || ""}`;
  if (name === "list_dir") return `list ${args.path || "."}`;
  if (name === "create_project") return `create ${args.template || ""} project ▸ ${args.name || ""}`;
  if (name === "run_project") return `run & test project ▸ ${args.name || ""}`;
  if (name === "read_page") return `read page ▸ ${args.url || "(open browser page)"}`;
  if (name === "web_search") return `web search ▸ ${args.query || ""}`;
  if (name === "browser_open") return `open ▸ ${args.url || ""}`;
  if (name === "browser_click") return `click link ▸ ${args.link || args.number || ""}`;
  if (name === "browser_form") return `submit form`;
  if (name === "visible_browser_draft_email") return `insert email draft`;
  if (name === "notepad_read") return `read notepad`;
  if (name === "notepad_write") return `write notepad`;
  if (name === "browser_download") return `download ▸ ${args.url || ""}`;
  if (name === "windows_system_info") return `inspect Windows ▸ ${args.scope || "overview"}`;
  if (name === "windows_settings_open") return `open Windows Settings ▸ ${args.page || ""}`;
  if (name === "windows_app_search") return `search Windows apps ▸ ${args.query || ""}`;
  if (name === "windows_app_install") return `install Windows app ▸ ${args.id || ""}`;
  if (name === "windows_network_setup") return `Windows network ▸ ${args.action || ""}`;
  return name;
}

function shortAiName(provider, model = "") {
  const value = String(model || "").toLowerCase();
  if (/\b(gpt|o[1345](?:\b|-))/.test(value) || provider === "openai") return "GPT";
  if (/claude/.test(value) || provider === "claude") return "Claude";
  if (/glm|zai|z\.ai/.test(value) || provider === "glm" || provider === "zaiCoding") return "GLM";
  if (/qwen/.test(value)) return "Qwen";
  if (/gemma/.test(value)) return "Gemma";
  if (/llama/.test(value)) return "Llama";
  if (/mistral|mixtral/.test(value)) return "Mistral";
  if (/phi/.test(value)) return "Phi";
  if (/smollm/.test(value)) return "SmolLM";
  return provider === "local" ? "Local AI" : "AI";
}

// 1x1 red PNG used by the vision self-test
const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function startServer(config, { port = 0, autoExit = false } = {}) {
  const uiHtml = loadUiHtml();
  const icon32 = loadAsset("icon-32.png", "../assets/saz-32.png");
  const icon256 = loadAsset("icon-256.png", "../assets/saz-256.png");
  let favicon;
  try { favicon = loadAsset("saz.ico", "../assets/saz.ico"); } catch { favicon = icon32; }

  const pendingApprovals = new Map(); // id -> resolve(boolean)
  const pendingMcpOAuth = new Map(); // state -> short-lived OAuth transaction
  const pendingEmailOAuth = new Map(); // state -> short-lived mailbox OAuth transaction
  const pendingBrowserControls = new Map(); // id -> resolve(result)
  const pendingNotepadControls = new Map(); // id -> resolve(result)
  let browserUrl = ""; // the page currently open in the in-app browser
  let browseBase = ""; // origin of the isolated browser-proxy server (set on listen)

  // ── thread store ───────────────────────────────────────────────
  const threads = new Map(); // id -> { id, title, messages, createdAt, updatedAt, abort }
  function newThread({ kind = "chat", title = "New chat", projectDir = "" } = {}) {
    const id = crypto.randomUUID();
    const workDir = kind === "project" && projectDir ? projectDir : config.projectsDir;
    const t = {
      id, title, kind, projectDir,
      messages: [{ role: "system", content: systemPrompt(workDir, config.autoApprove, config) }],
      log: [], // display entries: {t:'user'|'ai'|'tool', ...}
      createdAt: Date.now(), updatedAt: Date.now(), abort: null, pendingTask: null
    };
    threads.set(id, t);
    activeThreadId = id;
    return t;
  }
  function recentTaskContext(messages) {
    const userMessages = (messages || [])
      .filter((message) => message?.role === "user")
      .map((message) => userTextOnly(message.content).trim())
      .filter((text) => text && !text.startsWith("RESUME INTERRUPTED TASK:"))
      .slice(-8);
    return userMessages.join("\n\n--- next user message ---\n\n").slice(-24000);
  }
  function beginPendingTask(t, content) {
    t.pendingTask = {
      objective: userTextOnly(content).trim(),
      context: recentTaskContext(t.messages),
      state: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      controller: null
    };
  }
  function activeTaskPrompt(task) {
    if (!task || !["running", "interrupted"].includes(task.state)) return "";
    return [
      "ACTIVE TASK (keep working until it is genuinely complete):",
      task.context || task.objective,
      "Do not lose the user's folder restrictions, safety constraints, or requested deliverable. Review existing tool results before repeating work.",
      "If the newest user message only asks whether you are working, why the run stopped, or says to continue, do not replace this objective with that message. Briefly acknowledge if needed, then resume this active task from the checkpoint."
    ].join("\n");
  }
  function isTaskResumeOrStatusText(text) {
    const s = String(text || "").trim().toLowerCase();
    if (!s) return false;
    if (/^(continue|resume|keep going|go on|finish|finish it|try again|retry|go ahead|carry on|keep working|move forward|do it|yes do it|ok do it|okay do it)\b/i.test(s)) return true;
    if (/\b(are you|r u|you)\s+(still\s+)?(checking|working|running|doing|stuck|stopped)\b/i.test(s)) return true;
    if (/\b(what happened|why did (it|you) stop|did (it|you) stop|what are you doing|where are we|status update|give me status|can move forward)\b/i.test(s)) return true;
    if (/^(check now|try again|please continue|continue where you left off)\b/i.test(s)) return true;
    return false;
  }
  function resumeTaskMessage(task, latestUserText = "") {
    if (!task) return "Continue exactly where you left off. Do not repeat work already done.";
    const lines = [
      "RESUME INTERRUPTED TASK:",
      `Original objective: ${task.objective || "Finish the prior request."}`,
      "Relevant user instructions and constraints:",
      task.context || task.objective || "",
      "Continue from the existing messages and tool results. Do not restart, switch projects, or claim the context is missing. Finish the task and report the files changed."
    ];
    const latest = String(latestUserText || "").trim();
    if (latest) {
      lines.push(
        "",
        `Latest user message: ${latest}`,
        "Treat the latest user message as a status/resume instruction, not as a replacement objective."
      );
    }
    return lines.join("\n");
  }
  function isBlankNewThread(t) {
    if (!t || t.kind === "project" || t.title !== "New chat" || t.pinned) return false;
    if (Array.isArray(t.log) && t.log.length) return false;
    const messages = Array.isArray(t.messages) ? t.messages : [];
    return messages.every((m) => m?.role === "system");
  }
  function reuseOrNewThread() {
    const existing = [...threads.values()]
      .filter(isBlankNewThread)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) {
      existing.updatedAt = Date.now();
      activeThreadId = existing.id;
      return existing;
    }
    return newThread();
  }
  const isProjectThread = (t) => t?.kind === "project" ||
    Array.isArray(t.log) && t.log.some((e) => e.t === "tool" && (e.name === "create_project" || e.name === "run_project")) ||
    /^Build\b/i.test(t?.title || "") ||
    /\b(build|create|make)\b.*\b(app|project|website|api|desktop|window|windows)\b/i.test(userTextOnly(firstUserContent(t)));
  function threadList() {
    return [...threads.values()]
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, pinned: !!t.pinned,
        kind: isProjectThread(t) ? "project" : "chat", projectDir: t.projectDir || "",
        pendingTask: t.pendingTask ? {
          state: t.pendingTask.state || "",
          updatedAt: t.pendingTask.updatedAt || 0
        } : null }));
  }
  const renderThread = (t) => t.log; // display log = full history incl. tool steps
  let activeThreadId = null;

  // persist chats to disk (workspace recovery), unless privacy mode is on
  const persist = () => {
    if (config.ui?.autoSave === false) return;
    saveThreads([...threads.values()]);
  };

  // restore previous session's chats on startup
  const restored = config.ui?.autoSave === false ? [] : loadThreads();
  if (restored.length) {
    let repairedTitles = false;
    for (const t of restored) {
      if (repairAutoNotepadTitle(t)) repairedTitles = true;
      if (!t.kind && isProjectThread(t)) { t.kind = "project"; repairedTitles = true; }
      if (t.kind !== "project") { t.kind = "chat"; t.projectDir = ""; }
      if (t.pendingTask?.state === "running") {
        t.pendingTask.state = "interrupted";
        t.pendingTask.updatedAt = Date.now();
        repairedTitles = true;
      }
      threads.set(t.id, { ...t, abort: null });
    }
    activeThreadId = restored.sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    if (repairedTitles) persist();
  } else {
    newThread();
  }

  // Scheduled prompts remain answer-only. A separate, explicit agent action
  // can use tools unattended when Auto-approve was enabled at schedule time.
  setAutomationActionHandler(async (item) => {
    if (item.actionType === "reminder") return { code: 0, output: item.text || item.name };
    if (item.actionType === "open_url") return { code: 0, output: `Ready to open ${item.url}`, url: item.url };
    if (!["prompt", "agent"].includes(item.actionType)) return { code: 1, output: `Unsupported scheduled action: ${item.actionType}` };

    const t = threads.get(item.threadId) || reuseOrNewThread();
    const text = String(item.text || "").trim();
    if (!text) return { code: 1, output: "The scheduled AI prompt is empty.", threadId: t.id };
    const content = `Scheduled task: ${text}`;
    const provider = item.provider && config[item.provider] ? item.provider : config.provider;
    const runConfig = {
      ...config,
      provider,
      projectsDir: t.projectDir || item.cwd || config.projectsDir,
      [provider]: { ...(config[provider] || {}), ...(item.model ? { model: item.model } : {}) }
    };
    t.messages.push({ role: "user", content });
    t.log.push({ t: "user", text: content, at: Date.now(), scheduled: true });
    beginPendingTask(t, content);
    if (t.title === "New chat") t.title = String(item.name || shortThreadTitle(text)).slice(0, 42);
    t.updatedAt = Date.now();
    persist();

    try {
      if (item.actionType === "agent") {
        if (!item.autoApprove) throw new Error("This scheduled AI task needs Auto-approve. Edit the task while Auto-approve is enabled, or use Ask AI (answer only).");
        const taskPrompt = activeTaskPrompt(t.pendingTask);
        const brief = t.kind === "project" && t.projectDir ? projectBrief(t.projectDir) : "";
        if (t.messages[0]?.role === "system") {
          t.messages[0] = { role: "system", content: systemPrompt(runConfig.projectsDir, true, runConfig) + brief + (taskPrompt ? `\n\n${taskPrompt}` : "") };
        }
        const abort = new AbortController();
        let replyModel = currentModel(runConfig);
        let runIn = 0, runOut = 0, runEst = false, runCalls = 0;
        const ctx = {
          config: runConfig,
          projectDir: t.kind === "project" ? t.projectDir || "" : "",
          signal: abort.signal,
          objective: t.pendingTask?.objective || text,
          taskContext: t.pendingTask?.context || "",
          controllerState: t.pendingTask?.controller || null,
          approve: async () => true,
          approveAlways: async () => true,
          onStatus: () => {},
          onToken: () => {},
          onOptimize: () => {},
          onUsage: (usage) => {
            runIn += usage.input || 0; runOut += usage.output || 0; runEst = runEst || !!usage.estimated;
            if ((usage.input || 0) || (usage.output || 0)) runCalls++;
            if (usage.model) replyModel = usage.model;
            recordUsage(usage.provider, usage.model, usage.input || 0, usage.output || 0);
          },
          onStep: (step) => t.log.push({ t: "tool", name: step.name, summary: stepSummary(step.name, step.args), result: step.result, scheduled: true }),
          onImage: (src, caption) => t.log.push({ t: "image", src, caption: caption || "", at: Date.now(), scheduled: true }),
          onController: (controller) => { if (t.pendingTask) t.pendingTask.controller = controller; },
          onCheckpoint: () => { t.updatedAt = Date.now(); persist(); },
          onBrowse: () => {},
          visibleBrowser: async () => "The visible browser is unavailable during an unattended scheduled task. Use background web tools instead.",
          captureScreenshot: async () => ({ ok: false, error: "Visible screenshots are unavailable during an unattended scheduled task." }),
          notepad: async () => "The visible notepad is unavailable during an unattended scheduled task."
        };
        ctx.runSubagent = (task, options) => runSubagent(ctx, task, options);
        const answer = String(await runTurn(ctx, t.messages) || "").trim();
        if (!answer) throw new Error("The selected model returned an empty response.");
        const aiLabel = shortAiName(provider, replyModel);
        t.log.push({ t: "ai", text: answer, at: Date.now(), provider, model: replyModel, aiLabel, scheduled: true });
        if (runIn || runOut) t.log.push({ t: "usage", input: runIn, output: runOut, estimated: runEst, calls: runCalls });
        if (t.pendingTask) { t.pendingTask.state = "completed"; t.pendingTask.updatedAt = Date.now(); }
        t.updatedAt = Date.now();
        persist();
        return { code: 0, output: answer, threadId: t.id };
      }

      const target = await resolveTarget(runConfig);
      const recent = t.messages
        .filter((message) => (message.role === "user" || message.role === "assistant") && message.content && !message.tool_calls?.length)
        .slice(-18)
        .map((message) => ({ role: message.role, content: message.content }));
      const prompt = [
        { role: "system", content: "Answer the scheduled request directly. Use recent chat context when useful. This is an unattended, answer-only run: do not call tools, modify files, open pages, send messages, or claim that you performed an action." },
        ...recent
      ];
      const answerMessage = await chatCompletion(target, prompt);
      const answer = String(answerMessage?.content || "").trim();
      if (!answer) throw new Error("The selected model returned an empty response.");
      const model = target.model || currentModel(runConfig);
      const aiLabel = shortAiName(provider, model);
      t.messages.push({ role: "assistant", content: answer });
      t.log.push({ t: "ai", text: answer, at: Date.now(), provider, model, aiLabel, scheduled: true });
      const usage = answerMessage?.usage || {};
      if (usage.input || usage.output) {
        recordUsage(provider, model, usage.input || 0, usage.output || 0);
        t.log.push({ t: "usage", input: usage.input || 0, output: usage.output || 0, estimated: !!usage.estimated });
      }
      t.updatedAt = Date.now();
      persist();
      return { code: 0, output: answer, threadId: t.id };
    } catch (error) {
      const message = String(error?.message || error);
      if (t.pendingTask) { t.pendingTask.state = "interrupted"; t.pendingTask.updatedAt = Date.now(); }
      t.log.push({ t: "error", text: `Scheduled task failed: ${message}`, scheduled: true });
      t.updatedAt = Date.now();
      persist();
      return { code: 1, output: message, threadId: t.id };
    }
  });
  startAutomationScheduler();

  // ── auto-exit when the app window closes ───────────────────────
  let lastPing = Date.now();
  let activeChats = 0;
  let byeTimer = null;
  const syncWarmEnv = () => { process.env.BOOLEAN_KEEP_ENGINE_WARM = config.ui?.keepLocalWarm !== false ? "1" : ""; };
  syncWarmEnv();
  const saveMcpConnector = (connector) => {
    config.connectors = config.connectors || { mcp: [], agents: [] };
    config.connectors.mcp = Array.isArray(config.connectors.mcp) ? config.connectors.mcp : [];
    const index = config.connectors.mcp.findIndex((item) => item.id === connector.id || item.url === connector.url);
    if (index >= 0) config.connectors.mcp[index] = { ...config.connectors.mcp[index], ...connector };
    else config.connectors.mcp.push(connector);
    saveConfig(config);
  };
  const oauthResultPage = (title, message, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <style>body{font:15px Segoe UI,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f6;color:#171918}.box{width:min(380px,calc(100vw - 48px));padding:28px;border:1px solid #ddd;border-radius:8px;background:#fff}h1{font-size:22px;margin:0 0 10px}.ok{color:#13a84a}.bad{color:#cf3e3e}</style>
    <div class="box"><h1 class="${ok ? "ok" : "bad"}">${title}</h1><div>${message}</div></div>
    <script>try{if(window.opener)window.opener.postMessage({type:"boolean-mcp-oauth",ok:${ok}},location.origin);setTimeout(()=>window.close(),900)}catch{}</script>`;
  function shutdown() {
    if (activeChats > 0) return;
    if (config.ui?.keepLocalWarm !== false) {
      try { engine.keepEngineAliveOnExit(); } catch { /* keep normal shutdown */ }
    }
    process.exit(0);
  }
  if (autoExit) {
    setInterval(() => {
      if (Date.now() - lastPing > 90000) shutdown();
    }, 15000).unref();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const json = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // block DNS-rebinding: only accept requests addressed to localhost
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    // CSRF guard: state-changing API calls must carry the app's header.
    // (Proxied web pages run in a sandboxed frame and can never add it.)
    if (p.startsWith("/api/") && req.method === "POST" && p !== "/api/bye" && req.headers["x-saz"] !== "1") {
      res.writeHead(403); res.end("forbidden"); return;
    }
    try {
      if (req.method === "POST" && p === "/api/browse/clear") {
        clearCookies();
        json({ ok: true });
        return;
      }
      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        // in dev (running from source) re-read the file each load, so editing
        // ui.html + refreshing the browser shows changes with no restart
        res.end(IS_SEA ? uiHtml : loadUiHtml());
        return;
      }
      if (req.method === "GET" && p === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/x-icon" });
        res.end(favicon);
        return;
      }
      if (req.method === "GET" && p === "/icon-32.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(icon32);
        return;
      }
      if (req.method === "GET" && p === "/icon-256.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(icon256);
        return;
      }
      if (req.method === "GET" && p === "/manifest.json") {
        res.writeHead(200, { "content-type": "application/manifest+json" });
        res.end(JSON.stringify({
          name: APP_NAME, short_name: "Boolean", description: APP_TAGLINE,
          start_url: "/", display: "standalone",
          background_color: "#17181a", theme_color: "#17181a",
          icons: [
            { src: "/icon-32.png", sizes: "32x32", type: "image/png" },
            { src: "/icon-256.png", sizes: "256x256", type: "image/png" }
          ]
        }));
        return;
      }
      if (req.method === "GET" && p.startsWith("/api/legal/")) {
        const kind = p.endsWith("/privacy") ? "privacy" : p.endsWith("/policy") ? "policy" : "";
        if (!kind) return json({ error: "not found" }, 404);
        const file = kind === "privacy" ? "PRIVACY.txt" : "LICENSE.txt";
        const text = loadLegalText(file);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
        return;
      }

      if (req.method === "POST" && p === "/api/bye") {
        res.writeHead(200); res.end("bye");
        if (autoExit && !byeTimer) byeTimer = setTimeout(shutdown, 8000);
        return;
      }

      if (req.method === "GET" && p === "/api/state") {
        lastPing = Date.now();
        if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
        let models = [];
        try { models = await listProviderModels(config); } catch { /* backend down */ }
        json({
          appName: APP_NAME, version: APP_VERSION, displayVersion: APP_DISPLAY_VERSION, tagline: APP_TAGLINE,
          provider: config.provider, providers: PROVIDERS, models,
          providerModels: Object.fromEntries(PROVIDERS.map((p) => [p, config[p]?.model || ""])),
          model: currentModel(config), autoApprove: config.autoApprove,
          local: { ctx: config.local.ctx },
          backendUp: await backendUp(config),
          cloud: { ...CLOUD, customApi: config.customApi?.name || CLOUD.customApi },
          keys: Object.fromEntries(Object.keys(CLOUD).map((k) => [k, !!config[k]?.apiKey])),
          userApi: {
            name: config.customApi?.name || "Custom API",
            baseUrl: config.customApi?.baseUrl || "",
            model: config.customApi?.model || "",
            hasKey: !!config.customApi?.apiKey
          },
          thirdParty: {
            zaiCoding: {
              endpoint: "https://api.z.ai/api/coding/paas/v4",
              model: config.zaiCoding?.model || "GLM-4.7",
              approvedUse: !!config.zaiCoding?.approvedUse
            }
          },
          projectsDir: config.projectsDir,
          referenceModel: config.referenceModel,
          connectors: publicConnectors(config),
          imageGeneration: publicImageGeneration(config),
          cloudBackend: publicCloudBackend(config),
          browseBase,
          vision: config.provider === "local"
            ? (() => { try { return engine.visionState(config); } catch { return { supported: false, reason: "unknown" }; } })()
            : { supported: true, cloud: true },
          ui: config.ui,
          eulaAccepted: !!config.eulaAccepted,
          threads: threadList(), activeThreadId
        });
        return;
      }

      if (req.method === "GET" && p === "/api/provider-models") {
        const provider = String(url.searchParams.get("provider") || "").trim();
        if (!CLOUD[provider]) return json({ error: "invalid_provider" }, 400);
        if (!config[provider]?.apiKey) return json({ error: "api_key_required" }, 401);
        const providerConfig = { ...config, provider };
        const models = await listProviderModels(providerConfig);
        json({ ok: true, provider, models });
        return;
      }

      if (req.method === "POST" && p === "/api/provider-test") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim();
        if (!CLOUD[provider]) return json({ error: "invalid_provider" }, 400);
        if (!config[provider]?.apiKey) return json({ error: "api_key_required" }, 401);
        try {
          const target = await resolveTarget({ ...config, provider });
          const reply = await chatCompletion(target, [
            { role: "user", content: "Reply with exactly: Connected" }
          ], null, AbortSignal.timeout(20000));
          json({ ok: true, message: String(reply?.content || "Connected").trim() || "Connected" });
        } catch (err) {
          json({ error: "connection_failed", message: String(err?.message || err) }, 502);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/url") {
        const body = await readBody(req);
        const c = config.cloudBackend || {};
        c.url = normalizeCloudBackendUrl(body.url || "");
        if (!c.url) { c.sessionToken = ""; c.user = null; c.tokens = null; }
        config.cloudBackend = c;
        saveConfig(config);
        json({ ok: true, cloudBackend: publicCloudBackend(config) });
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/login/start") {
        const data = await cloudRequest(config, "/auth/device/start", {
          method: "POST",
          auth: false,
          body: JSON.stringify({})
        });
        json(data);
        return;
      }

      if (req.method === "GET" && p === "/api/cloud/login/status") {
        const deviceId = url.searchParams.get("device_id") || "";
        if (!deviceId) return json({ error: "missing device_id" }, 400);
        const data = await cloudRequest(config, `/auth/device/status?device_id=${encodeURIComponent(deviceId)}`, {
          method: "GET",
          auth: false
        });
        if (data.status === "complete" && data.session_token) {
          config.cloudBackend = {
            ...(config.cloudBackend || {}),
            sessionToken: data.session_token,
            user: data.user || null,
            tokens: data.tokens || null
          };
          saveConfig(config);
        }
        json({ ...data, session_token: data.session_token ? "__saved__" : undefined });
        return;
      }

      if (req.method === "GET" && p === "/api/cloud/me") {
        const data = await cloudRequest(config, "/me", { method: "GET" });
        config.cloudBackend = { ...(config.cloudBackend || {}), user: data.user || null, tokens: data.tokens || null };
        saveConfig(config);
        json({ ok: true, cloudBackend: publicCloudBackend(config) });
        return;
      }

      if (req.method === "GET" && p === "/api/cloud/notes") {
        try {
          const data = await cloudRequest(config, "/notes", { method: "GET" });
          json(data);
        } catch (err) {
          json({ error: err?.data?.error || "cloud_notes_unavailable", message: err.message }, err.status || 502);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/notes") {
        const body = await readBody(req);
        try {
          const data = await cloudRequest(config, "/notes", {
            method: "PUT",
            body: JSON.stringify(body)
          });
          json(data);
        } catch (err) {
          json(err?.data || { error: "cloud_notes_unavailable", message: err.message }, err.status || 502);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/logout") {
        try { await cloudRequest(config, "/auth/logout", { method: "POST", body: JSON.stringify({}) }); } catch { /* clear local session anyway */ }
        config.cloudBackend = { ...(config.cloudBackend || {}), sessionToken: "", user: null, tokens: null };
        saveConfig(config);
        json({ ok: true, cloudBackend: publicCloudBackend(config) });
        return;
      }

      if (req.method === "GET" && p === "/api/automations") {
        const result = await manageAutomation({ operation: "list" }, {
          projectDir: config.projectsDir,
          config,
          approve: async () => true
        });
        json(JSON.parse(result));
        return;
      }

      if (req.method === "POST" && p === "/api/automations") {
        const body = await readBody(req);
        const operation = String(body.operation || "");
        if (!["create", "update", "run", "pause", "resume", "remove"].includes(operation)) {
          return json({ error: "Unsupported scheduled-task operation." }, 400);
        }
        const result = await manageAutomation(body, {
          projectDir: config.projectsDir,
          config,
          approve: async () => true
        });
        try { json(JSON.parse(result)); }
        catch { json({ ok: true, message: result }); }
        return;
      }

      if (req.method === "GET" && p === "/api/thread") {
        const t = threads.get(url.searchParams.get("id"));
        if (!t) return json({ error: "no such thread" }, 404);
        activeThreadId = t.id;
        json({ id: t.id, title: t.title, kind: isProjectThread(t) ? "project" : "chat",
          projectDir: t.projectDir || "", log: renderThread(t),
          pendingTask: t.pendingTask ? {
            state: t.pendingTask.state || "",
            updatedAt: t.pendingTask.updatedAt || 0
          } : null });
        return;
      }

      if (req.method === "POST" && p === "/api/thread/new") {
        const t = reuseOrNewThread();
        persist();
        json({ id: t.id });
        return;
      }

      if (req.method === "POST" && p === "/api/project/new") {
        const body = await readBody(req);
        const name = String(body.name || "").trim().replace(/[. ]+$/g, "");
        const parentDir = path.resolve(String(body.parentDir || config.projectsDir || ""));
        if (!name || name.length > 80 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
          return json({ error: "Use a valid Windows folder name (1-80 characters)." }, 400);
        }
        if (!fs.existsSync(parentDir) && parentDir === path.resolve(config.projectsDir)) fs.mkdirSync(parentDir, { recursive: true });
        if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return json({ error: "Choose an existing folder location." }, 400);
        const projectDir = path.resolve(parentDir, name);
        const relativeProject = path.relative(parentDir, projectDir);
        if (!relativeProject || relativeProject.startsWith("..") || path.isAbsolute(relativeProject)) {
          return json({ error: "Invalid project location." }, 400);
        }
        if (fs.existsSync(projectDir)) return json({ error: "A folder with that project name already exists." }, 409);
        fs.mkdirSync(projectDir);
        const t = newThread({ kind: "project", title: name, projectDir });
        persist();
        json({ id: t.id, name, projectDir });
        return;
      }

      if (req.method === "POST" && p === "/api/project/open") {
        const body = await readBody(req);
        const t = threads.get(body.id);
        if (!t || t.kind !== "project" || !t.projectDir) return json({ error: "This project has no saved folder." }, 404);
        fs.mkdirSync(t.projectDir, { recursive: true });
        spawn("explorer.exe", [t.projectDir], { detached: true, stdio: "ignore" }).unref();
        json({ ok: true, projectDir: t.projectDir });
        return;
      }

      // adopt an EXISTING folder as a project — creates (or reuses) a project
      // chat bound to that folder so the AI works on the files already there
      if (req.method === "POST" && p === "/api/project/adopt") {
        const body = await readBody(req);
        const dir = path.resolve(String(body.dir || "").trim());
        if (!body.dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return json({ error: "That folder could not be found." }, 400);
        }
        const root = path.parse(dir).root;
        if (dir === root) return json({ error: "Choose a project folder, not a whole drive." }, 400);
        const existing = [...threads.values()].find((x) =>
          x.kind === "project" && x.projectDir && path.resolve(x.projectDir) === dir);
        if (existing) {
          activeThreadId = existing.id;
          return json({ id: existing.id, name: existing.title, projectDir: dir, existing: true });
        }
        const t = newThread({ kind: "project", title: path.basename(dir), projectDir: dir });
        persist();
        json({ id: t.id, name: t.title, projectDir: dir });
        return;
      }

      if (req.method === "POST" && p === "/api/thread/rename") {
        const body = await readBody(req);
        const t = threads.get(body.id);
        if (!t) return json({ error: "no such thread" }, 404);
        const title = String(body.title || "").trim().slice(0, 80);
        if (title) { t.title = title; t.updatedAt = Date.now(); persist(); }
        json({ ok: true, title: t.title });
        return;
      }

      if (req.method === "POST" && p === "/api/thread/pin") {
        const body = await readBody(req);
        const t = threads.get(body.id);
        if (!t) return json({ error: "no such thread" }, 404);
        t.pinned = body.pinned !== undefined ? !!body.pinned : !t.pinned;
        persist();
        json({ ok: true, pinned: t.pinned, threads: threadList() });
        return;
      }

      if (req.method === "POST" && p === "/api/thread/delete") {
        const body = await readBody(req);
        const t = threads.get(body.id);
        if (t?.abort) t.abort.abort();
        threads.delete(body.id);
        if (threads.size === 0) newThread();
        if (!threads.has(activeThreadId)) activeThreadId = threadList()[0].id;
        persist();
        json({ ok: true, activeThreadId });
        return;
      }

      // privacy: wipe all saved chats from disk and memory
      if (req.method === "POST" && p === "/api/clear-history") {
        threads.clear();
        clearThreads();
        newThread();
        json({ ok: true, activeThreadId });
        return;
      }

      if (req.method === "POST" && p === "/api/config") {
        const body = await readBody(req);
        if (typeof body.provider === "string" && PROVIDERS.includes(body.provider)) config.provider = body.provider;
        if (typeof body.model === "string" && body.model) setCurrentModel(config, body.model);
        if (typeof body.autoApprove === "boolean") config.autoApprove = body.autoApprove;
        if (Number.isFinite(body.localCtx)) {
          const ctx = Math.max(4096, Math.min(262144, Math.round(body.localCtx)));
          if (config.local.ctx !== ctx) {
            config.local.ctx = ctx;
            try { engine.stopEngine(); } catch { /* reload with new context next request */ }
          }
        }
        // set an API key: { setKey: { provider, key } }
        if (body.setKey && CLOUD[body.setKey.provider] && typeof body.setKey.key === "string") {
          config[body.setKey.provider].apiKey = body.setKey.key.trim();
        }
        if (typeof body.zaiCodingApproved === "boolean") config.zaiCoding.approvedUse = body.zaiCodingApproved;
        if (body.customApi && typeof body.customApi === "object") {
          const old = config.customApi || {};
          const baseUrl = String(body.customApi.baseUrl || old.baseUrl || "").trim().replace(/\/+$/, "");
          const model = String(body.customApi.model || old.model || "").trim();
          if (!/^https?:\/\//i.test(baseUrl)) return json({ error: "invalid_api_endpoint" }, 400);
          if (!model) return json({ error: "model_required" }, 400);
          const apiKey = body.customApi.apiKey === "__keep__" ? (old.apiKey || "") : String(body.customApi.apiKey || "").trim();
          config.customApi = {
            connectionId: String(body.customApi.id || old.connectionId || crypto.randomUUID()),
            name: cleanConnectorName(body.customApi.name) || "Custom API",
            baseUrl, model, apiKey, approvedUse: !!body.customApi.approvedUse
          };
          if (body.customApi.use !== false) config.provider = "customApi";
        }
        if (typeof body.selectApiConnector === "string") {
          const item = (config.connectors?.apis || []).find((x) => x.id === body.selectApiConnector && x.enabled !== false);
          if (!item) return json({ error: "api_connection_not_found" }, 404);
          config.customApi = { connectionId: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model, apiKey: item.apiKey || "", approvedUse: !!item.approvedUse };
          config.provider = "customApi";
        }
        // remove a saved API key: { clearKey: "openai" }
        if (typeof body.clearKey === "string" && CLOUD[body.clearKey]) {
          config[body.clearKey].apiKey = "";
          if (config.provider === body.clearKey) config.provider = "local";
        }
        if (typeof body.projectsDir === "string" && body.projectsDir.trim()) config.projectsDir = body.projectsDir.trim();
        if (typeof body.referenceModel === "string" && body.referenceModel) config.referenceModel = body.referenceModel;
        if (body.imageGeneration && typeof body.imageGeneration === "object") {
          const old = config.imageGeneration || {};
          const provider = String(body.imageGeneration.provider || old.provider || "openai").trim();
          const allowed = provider === "openai" || provider === "customApi" || (config.connectors?.apis || []).some((item) => item.id === provider);
          if (!allowed) return json({ error: "image_provider_not_found" }, 404);
          const size = String(body.imageGeneration.size || old.size || "1024x1024");
          if (!/^\d{2,5}x\d{2,5}$/.test(size)) return json({ error: "invalid_image_size" }, 400);
          config.imageGeneration = {
            provider,
            model: String(body.imageGeneration.model || old.model || "gpt-image-1").trim() || "gpt-image-1",
            size
          };
        }
        if (body.connectors && typeof body.connectors === "object") config.connectors = mergeConnectors(config.connectors, body.connectors);
        if (typeof body.removeApiConnector === "string") {
          config.connectors.apis = (config.connectors?.apis || []).filter((x) => x.id !== body.removeApiConnector);
          if (config.customApi?.connectionId === body.removeApiConnector) {
            config.customApi = { connectionId: "", name: "Custom API", baseUrl: "", model: "", apiKey: "", approvedUse: false };
            if (config.provider === "customApi") config.provider = "local";
          }
        }
        if (body.ui && typeof body.ui === "object") { config.ui = { ...config.ui, ...body.ui }; syncWarmEnv(); }
        if (body.acceptEula === true) config.eulaAccepted = "1.0";
        saveConfig(config);
        json({ ok: true });
        return;
      }

      // read a file for the "open in notepad" chat-link action; scoped to the
      // projects folder and any project chat's own folder for safety
      if (req.method === "GET" && p === "/api/file-content") {
        const raw = url.searchParams.get("path") || "";
        if (!raw) return json({ error: "missing path" }, 400);
        const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(config.projectsDir, raw);
        const roots = [path.resolve(config.projectsDir)];
        for (const t of threads.values()) if (t.projectDir) roots.push(path.resolve(t.projectDir));
        const allowed = roots.some((r) => target === r || target.startsWith(r + path.sep));
        if (!allowed) return json({ error: "That file is outside your project folders." }, 403);
        try {
          const st = fs.statSync(target);
          if (!st.isFile()) return json({ error: "Not a file." }, 400);
          if (st.size > 2_000_000) return json({ error: "File is too large to open in the notepad." }, 413);
          return json({ name: path.basename(target), path: target, content: fs.readFileSync(target, "utf8") });
        } catch {
          return json({ error: "File not found." }, 404);
        }
      }

      if (req.method === "POST" && p === "/api/mcp/connect") {
        const body = await readBody(req);
        const mcpUrl = String(body.url || "").trim();
        const name = cleanConnectorName(body.name) || (mcpUrl.includes("robinhood.com") ? "Robinhood Trading" : "MCP server");
        const token = typeof body.token === "string" ? body.token.trim() : "";
        if (!/^https?:\/\//i.test(mcpUrl)) return json({ ok: false, error: "Enter a valid http(s) MCP URL" }, 400);
        const connector = { id: crypto.randomUUID(), name, type: "remote", url: mcpUrl, token, oauth: null, enabled: true };
        try {
          const result = await testMcpConnector(connector);
          saveMcpConnector({
            ...connector,
            toolCount: result.toolCount,
            tools: result.tools.map((tool) => tool.name).filter(Boolean).slice(0, 50),
            lastTestedAt: Date.now()
          });
          return json({ ok: true, connected: true, connectorId: connector.id, ...result,
            tools: result.tools.map((tool) => tool.name).filter(Boolean) });
        } catch (err) {
          if (!(err instanceof McpHttpError) || err.status !== 401 || token) {
            return json({ ok: false, error: err.message || "connection failed",
              ...mcpStatusPayload(err?.mcpStatus || classifyMcpError(err, connector)) });
          }
          try {
            const metadata = await discoverMcpOAuth(mcpUrl, err.authHeader);
            const requestOrigin = `http://${req.headers.host}`;
            const redirectUri = `${requestOrigin}/mcp/oauth/callback`;
            const client = await registerMcpOAuthClient(metadata.registrationEndpoint, redirectUri);
            const state = crypto.randomBytes(24).toString("base64url");
            const pkce = createPkce();
            pendingMcpOAuth.set(state, {
              state, status: "pending", createdAt: Date.now(), connector, redirectUri,
              verifier: pkce.verifier, clientId: client.client_id, clientSecret: client.client_secret || "",
              authorizationEndpoint: metadata.authorizationEndpoint,
              tokenEndpoint: metadata.tokenEndpoint, resource: metadata.resource || mcpUrl, scope: metadata.scope || ""
            });
            for (const [key, value] of pendingMcpOAuth) {
              if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingMcpOAuth.delete(key);
            }
            return json({
              ok: true,
              authorizationRequired: true,
              ...mcpStatusPayload(MCP_STATUS.TOKEN_MISSING),
              state,
              authorizationUrl: buildMcpAuthorizationUrl(metadata, client, redirectUri, state, pkce.challenge)
            });
          } catch (oauthError) {
            return json({ ok: false, error: oauthError.message || "could not start authorization",
              ...mcpStatusPayload(classifyMcpError(oauthError, connector)) });
          }
        }
      }

      if (req.method === "GET" && p === "/api/mcp/oauth/status") {
        const state = url.searchParams.get("state") || "";
        const transaction = pendingMcpOAuth.get(state);
        if (!transaction) return json({ status: "expired" }, 404);
        return json({
          status: transaction.status,
          error: transaction.error || "",
          connectorId: transaction.connectorId || "",
          serverName: transaction.serverName || "",
          toolCount: transaction.toolCount || 0,
          tools: transaction.tools || []
        });
      }

      if (req.method === "GET" && p === "/mcp/oauth/callback") {
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const oauthError = url.searchParams.get("error") || "";
        const transaction = pendingMcpOAuth.get(state);
        if (!transaction || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization expired", "Return to Boolean and try connecting again.", false));
          return;
        }
        if (oauthError || !code) {
          transaction.status = "error";
          transaction.error = oauthError || "Robinhood did not return an authorization code.";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization canceled", "No changes were made. You can return to Boolean.", false));
          return;
        }
        try {
          const tokens = await exchangeMcpAuthorizationCode(transaction, code);
          const connector = {
            ...transaction.connector,
            token: "",
            oauth: {
              clientId: transaction.clientId,
              clientSecret: transaction.clientSecret,
              authorizationEndpoint: transaction.authorizationEndpoint,
              tokenEndpoint: transaction.tokenEndpoint,
              resource: transaction.resource,
              scope: tokens.scope || transaction.scope,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token || "",
              expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : 0
            }
          };
          const result = await testMcpConnector(connector);
          saveMcpConnector({
            ...connector,
            toolCount: result.toolCount,
            tools: result.tools.map((tool) => tool.name).filter(Boolean).slice(0, 50),
            lastTestedAt: Date.now()
          });
          transaction.status = "complete";
          transaction.connectorId = connector.id;
          transaction.serverName = result.serverName || connector.name;
          transaction.toolCount = result.toolCount;
          transaction.tools = result.tools.map((tool) => tool.name).filter(Boolean);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Connected", `${connector.name} is ready in Boolean. This window will close.`, true));
        } catch (err) {
          transaction.status = "error";
          transaction.error = err.message || "authorization failed";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Could not connect", "Return to Boolean and try again.", false));
        }
        return;
      }

      if (req.method === "POST" && p === "/api/email/oauth/start") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!['gmail', 'outlook'].includes(provider)) return json({ error: "unsupported email provider" }, 400);
        const clientId = String(body.clientId || config.connectors?.email?.[provider]?.clientId || "").trim();
        if (!clientId) return json({ error: `Enter the ${provider === 'gmail' ? 'Google' : 'Microsoft'} OAuth client ID first.` }, 400);
        const requestOrigin = `http://${req.headers.host}`;
        const redirectUri = `${requestOrigin}/email/oauth/callback`;
        const transaction = createEmailOAuth(provider, clientId, redirectUri);
        pendingEmailOAuth.set(transaction.state, { ...transaction, clientId, status: "pending" });
        for (const [key, value] of pendingEmailOAuth) {
          if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingEmailOAuth.delete(key);
        }
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        config.connectors.email[provider] = {
          ...(config.connectors.email[provider] || {}), clientId
        };
        saveConfig(config);
        return json({ ok: true, state: transaction.state, authorizationUrl: transaction.authorizationUrl, redirectUri });
      }

      if (req.method === "GET" && p === "/api/email/oauth/status") {
        const state = url.searchParams.get("state") || "";
        const transaction = pendingEmailOAuth.get(state);
        if (!transaction) return json({ status: "expired" }, 404);
        return json({ status: transaction.status, provider: transaction.provider, account: transaction.account || "", error: transaction.error || "" });
      }

      if (req.method === "GET" && p === "/email/oauth/callback") {
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const oauthError = url.searchParams.get("error") || "";
        const transaction = pendingEmailOAuth.get(state);
        if (!transaction || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization expired", "Return to Boolean and connect the email account again.", false));
          return;
        }
        if (oauthError || !code) {
          transaction.status = "error";
          transaction.error = oauthError || "The provider did not return an authorization code.";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization canceled", "No email access was saved.", false));
          return;
        }
        try {
          const oauth = await exchangeEmailCode(transaction, code, transaction.clientId);
          config.connectors = config.connectors || {};
          config.connectors.email = config.connectors.email || {};
          const connection = {
            ...(config.connectors.email[transaction.provider] || {}),
            clientId: transaction.clientId, connected: true, oauth
          };
          config.connectors.email[transaction.provider] = connection;
          connection.account = await getEmailAccount(transaction.provider, connection, () => saveConfig(config));
          saveConfig(config);
          transaction.status = "complete";
          transaction.account = connection.account;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Email connected", `${connection.account} is ready in Boolean. This window will close.`, true));
        } catch (err) {
          transaction.status = "error";
          transaction.error = err.message || "authorization failed";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Could not connect email", "Return to Boolean and check the OAuth client settings.", false));
        }
        return;
      }

      if (req.method === "POST" && p === "/api/email/disconnect") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!['gmail', 'outlook'].includes(provider)) return json({ error: "unsupported email provider" }, 400);
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        const clientId = config.connectors.email[provider]?.clientId || "";
        config.connectors.email[provider] = { clientId, connected: false, account: "", oauth: null };
        saveConfig(config);
        return json({ ok: true, email: publicEmailConnections(config) });
      }

      if (req.method === "POST" && p === "/api/email/settings") {
        const body = await readBody(req);
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        config.connectors.email.draftOnly = body.draftOnly !== false;
        config.connectors.email.confirmBeforeSend = true;
        saveConfig(config);
        return json({ ok: true, email: publicEmailConnections(config) });
      }

      if (req.method === "POST" && p === "/api/mcp/test") {
        const body = await readBody(req);
        let url = String(body.url || "").trim();
        let token = typeof body.token === "string" ? body.token.trim() : "";
        let connector = { url, token };
        // testing a saved server by id: fall back to its stored url/token
        if (body.id) {
          const saved = (config.connectors?.mcp || []).find((x) => x.id === body.id);
          if (saved) connector = saved;
        }
        try {
          const result = await testMcpConnector(connector, { onRefresh: () => saveConfig(config) });
          json({ ok: true, ...result, tools: result.tools.map((tool) => tool.name).filter(Boolean) });
        } catch (err) {
          json({ ok: false, error: err.message || "connection failed",
            ...mcpStatusPayload(err?.mcpStatus || classifyMcpError(err, connector)) });
        }
        return;
      }

      if (req.method === "POST" && p === "/api/pull") {
        const body = await readBody(req);
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
        const send = (o) => res.write(JSON.stringify(o) + "\n");
        try {
          if (body.force) engine.stopEngine();
          let last = 0;
          const file = await engine.downloadModel(body.id, (pct, mb) => {
            const now = Date.now();
            if (now - last > 400 || pct === 100) { last = now; send({ type: "progress", pct, mb }); }
          }, { force: body.force === true });
          if (config.provider === "local" && !config.local.model) { config.local.model = file; saveConfig(config); }
          send({ type: "done", file });
        } catch (err) { send({ type: "error", text: err.message }); }
        res.end();
        return;
      }

      if (req.method === "POST" && p === "/api/models/remove") {
        const body = await readBody(req);
        try {
          const result = engine.removeLocalModel(body.file || body.id);
          if (config.local.model === result.file) config.local.model = engine.listLocalModels()[0] || "";
          if (config.local.mmprojMap) delete config.local.mmprojMap[result.file];
          if (config.local.visionTestMap) {
            for (const key of Object.keys(config.local.visionTestMap)) {
              if (key.startsWith(result.file + "|")) delete config.local.visionTestMap[key];
            }
          }
          saveConfig(config);
          json({ ok: true, file: result.file, removed: result.removed, nextModel: config.local.model });
        } catch (err) {
          json({ error: err.message || "could not remove model" }, 400);
        }
        return;
      }

      // ── vision (.mmproj) management ──
      // choose the projector for the current local model: filename, "" = none, null = auto
      if (req.method === "POST" && p === "/api/vision/set") {
        const body = await readBody(req);
        const model = config.local.model || engine.listLocalModels()[0] || "";
        if (!model) return json({ error: "no local model selected" }, 400);
        config.local.mmprojMap = config.local.mmprojMap || {};
        if (body.mmproj === null || body.mmproj === undefined) delete config.local.mmprojMap[model]; // back to auto
        else config.local.mmprojMap[model] = String(body.mmproj);
        saveConfig(config);
        engine.stopEngine(); // next request reloads with the new projector
        json({ ok: true, vision: engine.visionState(config) });
        return;
      }
      // confirm image input actually works: load the engine and send a test image
      if (req.method === "POST" && p === "/api/vision/test") {
        try {
          const v = engine.visionState(config);
          if (!v.mmproj || v.compatible === false) return json({ ok: false, message: v.reason || engine.TEXT_ONLY_MSG });
          const { base, model } = await engine.ensureRunning(config, () => {});
          const key = engine.visionTestKey(model, v.mmproj);
          const remember = (ok, message) => {
            config.local.visionTestMap = config.local.visionTestMap || {};
            config.local.visionTestMap[key] = { ok, message, at: Date.now() };
            saveConfig(config);
          };
          const r = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer local" },
            body: JSON.stringify({
              model, max_tokens: 24,
              messages: [{
                role: "user",
                content: [
                  { type: "text", text: "What color is this image? Answer in one word." },
                  { type: "image_url", image_url: { url: TEST_IMAGE } }
                ]
              }]
            }),
            signal: AbortSignal.timeout(180000)
          });
          if (!r.ok) {
            const t = await r.text();
            const friendly = /image input is not supported|mmproj/i.test(t)
              ? "the engine rejected image input - the projector likely does not match this model"
              : t.slice(0, 200);
            const message = `image test failed (HTTP ${r.status}): ${friendly}`;
            remember(false, message);
            return json({ ok: false, message });
          }
          const d = await r.json();
          const ans = (d.choices?.[0]?.message?.content || "").trim().slice(0, 80);
          const message = `image input works - the model replied: "${ans}"`;
          remember(true, message);
          json({ ok: true, message });
        } catch (err) {
          const message = `image test failed: ${err.message}`;
          try {
            const v = engine.visionState(config);
            if (v.model && v.mmproj) {
              config.local.visionTestMap = config.local.visionTestMap || {};
              config.local.visionTestMap[engine.visionTestKey(v.model, v.mmproj)] = { ok: false, message, at: Date.now() };
              saveConfig(config);
            }
          } catch { /* ignore */ }
          json({ ok: false, message });
        }
        return;
      }

      if (req.method === "POST" && p === "/api/open-models") {
        fs.mkdirSync(engine.MODELS_DIR, { recursive: true });
        spawn("explorer.exe", [engine.MODELS_DIR], { detached: true, stdio: "ignore" }).unref();
        json({ ok: true });
        return;
      }

      // the UI reports which page the in-app browser is showing (for read_page)
      if (req.method === "POST" && p === "/api/browser/url") {
        const body = await readBody(req);
        browserUrl = typeof body.url === "string" ? body.url : "";
        json({ ok: true });
        return;
      }
      if (req.method === "POST" && p === "/api/browser/control-result") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        const resolve = pendingBrowserControls.get(id);
        if (resolve) {
          pendingBrowserControls.delete(id);
          resolve(body);
        }
        json({ ok: true });
        return;
      }
      if (req.method === "POST" && p === "/api/notepad/control-result") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        const resolve = pendingNotepadControls.get(id);
        if (resolve) {
          pendingNotepadControls.delete(id);
          resolve(body);
        }
        json({ ok: true });
        return;
      }
      // open a URL in the user's real external browser
      if (req.method === "POST" && p === "/api/open-url") {
        const body = await readBody(req);
        if (typeof body.url === "string" && /^https?:\/\//i.test(body.url)) {
          spawn("cmd", ["/c", "start", "", body.url], { detached: true, stdio: "ignore" }).unref();
        }
        json({ ok: true });
        return;
      }

      if (req.method === "POST" && p === "/api/open-projects") {
        fs.mkdirSync(config.projectsDir, { recursive: true });
        spawn("explorer.exe", [config.projectsDir], { detached: true, stdio: "ignore" }).unref();
        json({ ok: true });
        return;
      }

      // native "choose folder" dialog for the projects location
      if (req.method === "POST" && p === "/api/pick-folder") {
        const psScript = "Add-Type -AssemblyName System.Windows.Forms; " +
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          "$initial = $env:BOOLEAN_PICK_FOLDER; if ($initial -and (Test-Path -LiteralPath $initial)) { $d.SelectedPath = $initial }; " +
          "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
        const ps = spawn("powershell", ["-NoProfile", "-STA", "-Command", psScript], {
          windowsHide: true,
          env: { ...process.env, BOOLEAN_PICK_FOLDER: config.projectsDir }
        });
        let out = "";
        ps.stdout.on("data", (d) => (out += d.toString()));
        ps.on("close", () => {
          const picked = out.trim();
          if (picked && url.searchParams.get("save") !== "0") { config.projectsDir = picked; saveConfig(config); }
          json({ path: picked || null });
        });
        ps.on("error", () => json({ path: null }));
        return;
      }

      if (req.method === "GET" && p === "/api/usage") {
        json(summarizeUsage(config.referenceModel));
        return;
      }

      if (req.method === "GET" && p === "/api/preferences") {
        json(publicPreferences());
        return;
      }

      if (req.method === "POST" && p === "/api/preferences/delete") {
        const body = await readBody(req);
        json({ ok: deletePreference(String(body.id || "")) });
        return;
      }

      if (req.method === "POST" && p === "/api/preferences/clear") {
        clearPreferences();
        json({ ok: true });
        return;
      }

      // Context Optimizer: estimate tokens for a draft before sending
      if (req.method === "POST" && p === "/api/estimate") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        const budget = config.provider === "local" ? (config.local.ctx || 32768) : 128000;
        const hypothetical = [...t.messages];
        if (body.draft) hypothetical.push({ role: "user", content: body.draft });
        json(estimateContext(hypothetical, budget, config.ui?.contextMode || "balanced"));
        return;
      }
      if (req.method === "POST" && p === "/api/usage/reset") {
        resetUsage();
        json({ ok: true });
        return;
      }

      if (req.method === "POST" && p === "/api/approve") {
        const body = await readBody(req);
        const resolve = pendingApprovals.get(body.id);
        if (resolve) { pendingApprovals.delete(body.id); resolve(!!body.approved); }
        json({ ok: true });
        return;
      }

      if (req.method === "POST" && p === "/api/stop") {
        const body = await readBody(req);
        const t = threads.get(body.threadId);
        if (t?.abort) {
          // interrupt-for-edit: the question returns to the composer, so the
          // stored turn is removed once the aborted run finishes unwinding
          if (body.rollback) t.rollbackToUser = true;
          if (t.pendingTask) {
            t.pendingTask.state = "interrupted";
            t.pendingTask.updatedAt = Date.now();
            persist();
          }
          t.abort.abort();
        }
        json({ ok: true });
        return;
      }

      // roll a thread back to just after its last user message (for Retry)
      if (req.method === "POST" && p === "/api/retry") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        for (let i = t.messages.length - 1; i >= 0; i--) {
          if (t.messages[i].role === "user") { t.messages.length = i + 1; break; }
        }
        for (let i = t.log.length - 1; i >= 0; i--) {
          if (t.log[i].t === "user") { t.log.length = i + 1; break; }
        }
        const retryUser = [...t.messages].reverse().find((message) => message?.role === "user");
        if (retryUser) beginPendingTask(t, retryUser.content);
        persist();
        return streamRun(t, res);
      }

      // rewind: truncate the thread to just before the Nth user message and
      // return its text so the composer can be repopulated for editing/resending
      if (req.method === "POST" && p === "/api/thread/rewind") {
        const body = await readBody(req);
        // destructive op — never fall back to the active thread on a bad id
        const t = body.threadId ? threads.get(body.threadId) : threads.get(activeThreadId);
        if (!t) return json({ error: "no such thread" }, 404);
        if (t.abort) t.abort.abort();
        const idx = Math.max(0, Number(body.index) || 0);
        let seen = -1, cutMsg = -1, text = "";
        for (let i = 0; i < t.messages.length; i++) {
          if (t.messages[i].role === "user") { seen++; if (seen === idx) { cutMsg = i; text = userTextOnly(t.messages[i].content); break; } }
        }
        seen = -1; let cutLog = -1;
        for (let i = 0; i < t.log.length; i++) {
          if (t.log[i].t === "user") { seen++; if (seen === idx) { cutLog = i; if (!text) text = t.log[i].text || ""; break; } }
        }
        if (cutMsg >= 0) t.messages.length = cutMsg;
        if (cutLog >= 0) t.log.length = cutLog;
        t.pendingTask = null;
        t.updatedAt = Date.now();
        persist();
        return json({ ok: true, text });
      }

      if (req.method === "POST" && p === "/api/compare/retry") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        const targets = Array.isArray(body.targets) ? body.targets.slice(0, 2) : [];
        for (let i = t.messages.length - 1; i >= 0; i--) {
          if (t.messages[i].role === "user") { t.messages.length = i + 1; break; }
        }
        for (let i = t.log.length - 1; i >= 0; i--) {
          if (t.log[i].t === "user") { t.log.length = i + 1; break; }
        }
        persist();
        return streamCompare(t, targets, res);
      }

      // Resume the saved task, including its original objective and constraints.
      if (req.method === "POST" && p === "/api/continue") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        if (!t) return json({ error: "No active chat to continue." }, 404);
        const savedTask = t.pendingTask;
        if (t.abort) {
          return json({ error: "A response is already running in this chat. Stop it before continuing." }, 409);
        }
        if (!savedTask || savedTask.state === "completed") {
          return json({ error: "There is no interrupted task to continue in this chat." }, 409);
        }
        const content = resumeTaskMessage(savedTask);
        t.messages.push({ role: "user", content });
        t.log.push({ t: "user", text: "Continue", images: [], at: Date.now() });
        savedTask.state = "running";
        savedTask.updatedAt = Date.now();
        t.updatedAt = Date.now();
        persist();
        return streamRun(t, res);
      }

      // export a chat as plain text or markdown
      if (req.method === "GET" && p === "/api/export") {
        const t = threads.get(url.searchParams.get("id"));
        if (!t) return json({ error: "no such thread" }, 404);
        const md = url.searchParams.get("format") === "md";
        const lines = [];
        for (const e of t.log) {
          if (e.t === "user") lines.push((md ? "**You:** " : "You: ") + e.text);
          else if (e.t === "ai") {
            const label = e.aiLabel || shortAiName(e.provider, e.model);
            lines.push((md ? `**${label}:** ` : `${label}: `) + e.text);
          }
          else if (e.t === "tool") lines.push((md ? "> `" : "  [tool] ") + e.summary + (md ? "`" : ""));
        }
        const out = `# ${t.title}\n\n` + lines.join("\n\n");
        res.writeHead(200, {
          "content-type": md ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${t.title.replace(/[^\w -]/g, "_").slice(0, 40) || "chat"}.${md ? "md" : "txt"}"`
        });
        res.end(out);
        return;
      }

      if (req.method === "POST" && p === "/api/compare") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        const targets = Array.isArray(body.targets) ? body.targets.slice(0, 2) : [];
        const identities = new Set(targets.map((x) => `${x?.provider || ""}:${x?.model || ""}`));
        if (!t || targets.length !== 2 || identities.size !== 2) {
          res.writeHead(400, { "content-type": "application/x-ndjson; charset=utf-8" });
          res.end(JSON.stringify({ type: "error", text: "Choose two different cloud models to compare." }) + "\n");
          return;
        }
        const allowed = new Set(Object.keys(CLOUD));
        if (targets.some((x) => !allowed.has(x?.provider) || !String(x?.model || "").trim())) {
          res.writeHead(400, { "content-type": "application/x-ndjson; charset=utf-8" });
          res.end(JSON.stringify({ type: "error", text: "Compare is available for cloud models only." }) + "\n");
          return;
        }

        const text = String(body.message || "").trim();
        const images = Array.isArray(body.images) ? body.images : [];
        const content = images.length
          ? [{ type: "text", text }, ...images.map((image) => ({ type: "image_url", image_url: { url: typeof image === "string" ? image : (image.dataURL || image.url) } }))]
          : text;
        t.messages.push({ role: "user", content });
        t.log.push({ t: "user", text: userTextOnly(content), images: imagesOf(content), at: Date.now(), compareTargets: targets });
        if (config.ui?.learnedMemory !== false) learnFromUserText(userTextOnly(content));
        if (t.title === "New chat") t.title = shortThreadTitle(content).slice(0, 42);
        t.updatedAt = Date.now();
        persist();
        return streamCompare(t, targets, res);
      }

      if (req.method === "POST" && p === "/api/chat") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);

        // block image sends when the local model has no vision projector
        if (Array.isArray(body.images) && body.images.length && config.provider === "local") {
          let v; try { v = engine.visionState(config); } catch { v = { supported: false }; }
          if (!v.supported) {
            res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
            res.write(JSON.stringify({ type: "error", text: v.reason || engine.TEXT_ONLY_MSG }) + "\n");
            res.write(JSON.stringify({ type: "done" }) + "\n");
            res.end();
            return;
          }
        }

        // build user message (text + optional images)
        let content = body.message ?? "";
        if (Array.isArray(body.images) && body.images.length) {
          content = [
            { type: "text", text: body.message ?? "" },
            ...body.images.map((u) => ({ type: "image_url", image_url: { url: u } }))
          ];
        }
        const visibleUserText = userTextOnly(content);
        const savedTask = t.pendingTask && ["running", "interrupted"].includes(t.pendingTask.state) ? t.pendingTask : null;
        const shouldResumeSavedTask = savedTask && isTaskResumeOrStatusText(visibleUserText);
        if (shouldResumeSavedTask) {
          t.messages.push({ role: "user", content: resumeTaskMessage(savedTask, visibleUserText) });
          savedTask.state = "running";
          savedTask.updatedAt = Date.now();
        } else {
          t.messages.push({ role: "user", content });
          beginPendingTask(t, content);
        }
        t.log.push({ t: "user", text: visibleUserText, images: imagesOf(content), at: Date.now() });
        if (config.ui?.learnedMemory !== false) learnFromUserText(visibleUserText);
        if (t.title === "New chat") t.title = shortThreadTitle(content).slice(0, 42);
        t.updatedAt = Date.now();
        persist();
        return streamRun(t, res);
      }

      res.writeHead(404); res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }

    // drop the interrupted user turn (and everything after it) so an
    // interrupt-for-edit does not leave a duplicate question in the thread
    function rollbackLastUserTurn(t) {
      for (let i = t.messages.length - 1; i >= 0; i--) {
        if (t.messages[i].role === "user") { t.messages.length = i; break; }
      }
      for (let i = t.log.length - 1; i >= 0; i--) {
        if (t.log[i].t === "user") { t.log.length = i; break; }
      }
      t.pendingTask = null;
      t.updatedAt = Date.now();
      persist();
    }

    // ── shared streaming runner for chat / retry / continue ──
    async function streamRun(t, res) {
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
        const send = (o) => res.write(JSON.stringify(o) + "\n");
        const replyProvider = config.provider || "local";
        const runConfig = t.projectDir ? { ...config, projectsDir: t.projectDir } : config;
        let replyModel = currentModel(runConfig);

        // keep the system prompt current — restored sessions may predate newer
        // tools/workflow (e.g. create_project), so refresh it every run
        if (t.messages[0]?.role === "system") {
          const taskPrompt = activeTaskPrompt(t.pendingTask);
          // project chats also get a fresh file map so the model starts oriented
          const brief = t.kind === "project" && t.projectDir ? projectBrief(t.projectDir) : "";
          t.messages[0] = { role: "system", content: systemPrompt(runConfig.projectsDir, config.autoApprove, runConfig) + brief + (taskPrompt ? `\n\n${taskPrompt}` : "") };
        }

        const abort = new AbortController();
        t.abort = abort;
        let runIn = 0, runOut = 0, runEst = false, runCalls = 0;
        const ctx = {
          config: runConfig,
          projectDir: t.kind === "project" ? t.projectDir || "" : "",
          browserUrl,
          signal: abort.signal,
          objective: t.pendingTask?.objective || "",
          taskContext: t.pendingTask?.context || "",
          controllerState: t.pendingTask?.controller || null,
          onStatus: (text) => send({ type: "status", text }),
          onToken: (text) => send({ type: "token", text }),
          onUsage: (u) => {
            runIn += u.input || 0; runOut += u.output || 0; runEst = runEst || !!u.estimated;
            if ((u.input || 0) || (u.output || 0)) runCalls++;
            if (u.model) replyModel = u.model;
            recordUsage(u.provider, u.model, u.input || 0, u.output || 0);
            send({ type: "tokens", input: runIn, output: runOut, estimated: runEst, calls: runCalls });
          },
          onStep: (step) => {
            const entry = { t: "tool", name: step.name, summary: stepSummary(step.name, step.args), result: step.result };
            t.log.push(entry);
            send({ type: "step", entry });
            if (step.name === "read_page") send({ type: "browser", action: "read", url: step.args?.url || browserUrl });
          },
          onOptimize: (o) => send({ type: "optimized", ...o }),
          onController: (controller) => {
            if (t.pendingTask) {
              t.pendingTask.controller = controller;
              t.pendingTask.updatedAt = Date.now();
            }
            send({ type: "controller", controller });
          },
          // an image the AI produced (e.g. a screenshot) — show it in the
          // transcript and persist it in the thread log
          onImage: (src, caption) => {
            if (!src) return;
            const entry = { t: "image", src, caption: caption || "", at: Date.now() };
            t.log.push(entry);
            send({ type: "image", src, caption: entry.caption });
          },
          onCheckpoint: () => {
            if (t.pendingTask) t.pendingTask.updatedAt = Date.now();
            t.updatedAt = Date.now();
            persist();
          },
          // the AI opened a page — mirror it in the UI browser panel
          onBrowse: (u) => send({ type: "browser", action: "open", url: u }),
          visibleBrowser: (command) => {
            const id = crypto.randomUUID();
            send({ type: "browserControl", id, command });
            return new Promise((resolve) => {
              pendingBrowserControls.set(id, (body) => {
                if (body && body.url) browserUrl = String(body.url);
                resolve(body?.ok === false
                  ? `visible browser error: ${body.error || "unknown error"}`
                  : String(body?.result || ""));
              });
              abort.signal.addEventListener("abort", () => {
                if (pendingBrowserControls.has(id)) {
                  pendingBrowserControls.delete(id);
                  resolve("visible browser control was cancelled");
                }
              });
              setTimeout(() => {
                if (pendingBrowserControls.has(id)) {
                  pendingBrowserControls.delete(id);
                  resolve("visible browser control timed out");
                }
              }, 30000);
            });
          },
          // capture the rendered page as a PNG for visual review; resolves the
          // full result body ({ ok, image, result, url }) rather than a string
          captureScreenshot: (opts = {}) => {
            const id = crypto.randomUUID();
            send({ type: "browserControl", id, command: { action: "capture", ...(opts.url ? { url: String(opts.url) } : {}) } });
            return new Promise((resolve) => {
              pendingBrowserControls.set(id, (body) => {
                if (body && body.url) browserUrl = String(body.url);
                resolve(body || { ok: false, error: "no response" });
              });
              abort.signal.addEventListener("abort", () => {
                if (pendingBrowserControls.has(id)) { pendingBrowserControls.delete(id); resolve({ ok: false, error: "cancelled" }); }
              });
              setTimeout(() => {
                if (pendingBrowserControls.has(id)) { pendingBrowserControls.delete(id); resolve({ ok: false, error: "timed out" }); }
              }, 30000);
            });
          },
          notepad: (command) => {
            const id = crypto.randomUUID();
            send({ type: "notepadControl", id, command });
            return new Promise((resolve) => {
              pendingNotepadControls.set(id, (body) => {
                resolve(body?.ok === false
                  ? `notepad error: ${body.error || "unknown error"}`
                  : String(body?.result || ""));
              });
              abort.signal.addEventListener("abort", () => {
                if (pendingNotepadControls.has(id)) {
                  pendingNotepadControls.delete(id);
                  resolve("notepad control was cancelled");
                }
              });
              setTimeout(() => {
                if (pendingNotepadControls.has(id)) {
                  pendingNotepadControls.delete(id);
                  resolve("notepad control timed out");
                }
              }, 10000);
            });
          },
          approve: (summary) => {
            if (config.autoApprove) { send({ type: "status", text: `auto-approved: ${summary}` }); return Promise.resolve(true); }
            const id = crypto.randomUUID();
            send({ type: "approval", id, summary });
            return new Promise((resolve) => {
              pendingApprovals.set(id, resolve);
              abort.signal.addEventListener("abort", () => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              });
              setTimeout(() => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              }, 600000);
            });
          },
          approveAlways: (summary) => {
            const id = crypto.randomUUID();
            send({ type: "approval", id, summary });
            return new Promise((resolve) => {
              pendingApprovals.set(id, resolve);
              abort.signal.addEventListener("abort", () => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              });
              setTimeout(() => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              }, 600000);
            });
          }
        };
        // let the agent delegate focused work to bounded sub-agents
        ctx.runSubagent = (task, options) => runSubagent(ctx, task, options);

        activeChats++;
        lastPing = Date.now();
        try {
          const answer = await runTurn(ctx, t.messages);
          if (String(answer || "").trim()) {
            const aiLabel = shortAiName(replyProvider, replyModel);
            t.log.push({ t: "ai", text: answer, at: Date.now(), provider: replyProvider, model: replyModel, aiLabel });
            send({ type: "answer", text: answer, provider: replyProvider, model: replyModel, aiLabel });
          }
          if (t.pendingTask) {
            if (/^\(stopped by user\)/i.test(String(answer || "").trim())) {
              t.pendingTask.state = "interrupted";
              t.pendingTask.updatedAt = Date.now();
            } else if (String(answer || "").trim() && ctx.controllerResult?.phase === "completed") {
              // Keep the last objective available for the Continue button even
              // when the model ended with a normal-looking, but partial, answer.
              t.pendingTask.state = "completed";
              t.pendingTask.updatedAt = Date.now();
            } else {
              t.pendingTask.state = "interrupted";
              t.pendingTask.updatedAt = Date.now();
            }
          }
          if (runIn || runOut) {
            const usage = { t: "usage", input: runIn, output: runOut, estimated: runEst, calls: runCalls };
            t.log.push(usage);
            send({ type: "usage", ...usage });
          }
        } catch (err) {
          if (t.pendingTask) {
            t.pendingTask.state = "interrupted";
            t.pendingTask.updatedAt = Date.now();
          }
          // translate the raw engine error into a clear vision hint
          clearExpiredCloudSession(config, err);
          const msg = /image input is not supported|mmproj/i.test(err.message || "")
            ? engine.TEXT_ONLY_MSG + " (Settings → Models → Vision projector)"
            : err.message;
          const selectedModel = config.provider === "local" ? config.local.model : "";
          const recovery = selectedModel && /engine exited while loading|model file (?:is |failed|missing)|downloaded model failed validation/i.test(msg || "")
            ? { model: selectedModel, redownload: engine.CATALOG.some((m) => m.file === selectedModel), remove: true }
            : null;
          const errorEntry = { t: "error", text: msg, ...(recovery ? { modelRecovery: recovery } : {}) };
          t.log.push(errorEntry);
          send({ type: "error", text: msg, ...(recovery ? { modelRecovery: recovery } : {}) });
        } finally {
          activeChats--;
          t.abort = null;
          if (t.rollbackToUser) { t.rollbackToUser = false; if (abort.signal.aborted) rollbackLastUserTurn(t); }
          t.updatedAt = Date.now();
          lastPing = Date.now();
        }
        persist();
        send({ type: "done" });
        res.end();
    }

    async function streamCompare(t, targets, res) {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(JSON.stringify(o) + "\n");
      const abort = new AbortController();
      t.abort = abort;
      activeChats++;
      lastPing = Date.now();

      // Compare is deliberately answer-only: two models must never duplicate
      // browser, file, email, or Windows actions from one prompt.
      const recent = t.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content && !m.tool_calls?.length)
        .slice(-18)
        .map((m) => ({ role: m.role, content: m.content }));
      const prompt = [
        { role: "system", content: "Answer the user's request directly and concisely. Use the recent conversation for context. Do not claim to run tools or take actions." },
        ...recent
      ];
      const results = new Array(2);

      const runOne = async (choice, slot) => {
        const provider = choice.provider;
        const model = String(choice.model).trim();
        const runConfig = {
          ...config,
          provider,
          [provider]: { ...(config[provider] || {}), model },
          cloudBackend: { ...(config.cloudBackend || {}) }
        };
        send({ type: "compareStart", slot, provider, model, aiLabel: shortAiName(provider, model) });
        try {
          const target = await resolveTarget(runConfig);
          target.model = model;
          const answerMessage = await chatCompletion(target, prompt, undefined, abort.signal,
            (text) => send({ type: "compareToken", slot, text }));
          const answer = String(answerMessage?.content || "").trim();
          const usage = answerMessage?.usage || {};
          if (usage.input || usage.output) {
            recordUsage(provider, model, usage.input || 0, usage.output || 0);
            send({ type: "compareUsage", slot, input: usage.input || 0, output: usage.output || 0, estimated: !!usage.estimated });
          }
          const aiLabel = shortAiName(provider, model);
          results[slot] = { ok: true, answer, provider, model, aiLabel };
          t.log.push({ t: "ai", text: answer, at: Date.now(), provider, model, aiLabel, compare: true, compareSlot: slot });
          if (usage.input || usage.output) t.log.push({ t: "usage", input: usage.input || 0, output: usage.output || 0, estimated: !!usage.estimated, compareSlot: slot });
          send({ type: "compareAnswer", slot, text: answer, provider, model, aiLabel });
        } catch (err) {
          clearExpiredCloudSession(config, err);
          if (err?.name === "AbortError" || abort.signal.aborted) {
            results[slot] = { ok: false, error: "stopped" };
            send({ type: "compareError", slot, text: "stopped" });
          } else {
            const message = String(err?.message || err);
            results[slot] = { ok: false, error: message };
            t.log.push({ t: "error", text: `${shortAiName(provider, model)}: ${message}`, compareSlot: slot });
            send({ type: "compareError", slot, text: message });
          }
        }
      };

      try {
        await Promise.allSettled(targets.map(runOne));
        const combined = results.map((result, slot) => result?.ok
          ? `[${result.aiLabel}]\n${result.answer}`
          : `[${shortAiName(targets[slot].provider, targets[slot].model)} unavailable]\n${result?.error || "No response"}`
        ).join("\n\n");
        t.messages.push({ role: "assistant", content: combined });
        t.updatedAt = Date.now();
        persist();
        send({ type: "done" });
      } finally {
        activeChats = Math.max(0, activeChats - 1);
        t.abort = null;
        if (t.rollbackToUser) { t.rollbackToUser = false; if (abort.signal.aborted) rollbackLastUserTurn(t); }
        res.end();
      }
    }
  });

  // Isolated browser-proxy server on its OWN port. Proxied web pages render
  // from this origin (a different port = a different origin than the app), so
  // they can safely get sandbox `allow-same-origin` — cookies/storage work and
  // sites render normally — yet can never reach the app's /api (cross-origin +
  // the x-saz CSRF guard). Only /browse is served here; nothing sensitive.
  const proxyServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) { res.writeHead(403); res.end("forbidden"); return; }
    if (u.pathname === "/browse" && (req.method === "GET" || req.method === "POST")) {
      try { await handleBrowse(req, res, u, config); }
      catch (err) { res.writeHead(502); res.end(err.message); }
      return;
    }
    res.writeHead(404); res.end("not found");
  });

  // try the requested port; if taken, fall back to a random free one
  return new Promise((resolve) => {
    function listen(tryPort, allowFallback) {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && allowFallback) listen(0, false);
        else throw err;
      });
      server.listen(tryPort, "127.0.0.1", () => {
        proxyServer.listen(0, "127.0.0.1", () => {
          browseBase = `http://127.0.0.1:${proxyServer.address().port}`;
          resolve({ server, port: server.address().port });
        });
      });
    }
    listen(port, port !== 0);
  });
}

export function openAppWindow(url) {
  // Edge "app mode" with a dedicated profile dir so the window gets its own
  // taskbar identity (and uses our favicon) instead of grouping under Edge.
  const profile = `${process.env.LOCALAPPDATA}\\saz3\\profile`;
  const args = `--user-data-dir=${profile} --app=${url}`;
  const edge = spawn("cmd", ["/c", "start", "", "msedge", ...args.split(" ")], { detached: true, stdio: "ignore" });
  edge.unref();
  edge.on("error", () => {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  });

  // force our icon onto the Edge app window (Alt+Tab / title bar / taskbar).
  // Runs in both packaged (next to the exe) and dev (assets/) layouts.
  let script, icon;
  if (IS_SEA) {
    const dir = path.dirname(process.execPath);
    script = path.join(dir, "set-window-icon.ps1");
    icon = path.join(dir, "saz.ico");
    if (!fs.existsSync(icon)) icon = path.join(dir, "Boolean.exe"); // fall back to exe icon
  } else {
    const assets = path.resolve(new URL("../assets", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
    script = path.join(assets, "set-window-icon.ps1");
    icon = path.join(assets, "saz.ico");
  }
  if (fs.existsSync(script) && fs.existsSync(icon)) {
    const ps = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", script, "-IconPath", icon], { detached: true, stdio: "ignore" });
    ps.unref();
  }
}
