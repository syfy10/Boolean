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
import { systemPrompt, runTurn, estimateContext } from "./agent.js";
import { resolveTarget, chatCompletion, listProviderModels, backendUp } from "./providers.js";
import * as engine from "./engine.js";
import { recordUsage, resetUsage, summarizeUsage } from "./usage.js";
import { saveThreads, loadThreads, clearThreads } from "./store.js";
import { handleBrowse, clearCookies } from "./browse.js";
import { learnFromUserText, publicPreferences, deletePreference, clearPreferences } from "./preferences.js";

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
  if (!res.ok) throw new Error(data.message || data.error || `Cloud backend error ${res.status}`);
  return data;
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
    mcp: Array.isArray(c.mcp) ? c.mcp.map((x) => ({
      id: x.id, name: x.name, type: x.type || (x.url ? "remote" : "local"),
      url: x.url, command: x.command, args: x.args, enabled: x.enabled !== false
    })) : [],
    agents: Array.isArray(c.agents) ? c.agents.map((x) => ({
      id: x.id, name: x.name, url: x.url, enabled: x.enabled !== false, hasKey: !!x.apiKey
    })) : []
  };
}

function cleanConnectorName(s) {
  return String(s || "").replace(/[^\w .:-]/g, "").trim().slice(0, 80);
}

function mergeConnectors(current, incoming) {
  const prevAgents = new Map((current?.agents || []).map((a) => [a.id, a]));
  const next = { mcp: [], agents: [] };
  if (Array.isArray(incoming?.mcp)) {
    next.mcp = incoming.mcp.slice(0, 30).map((x) => {
      const url = String(x.url || "").trim().slice(0, 1000);
      const command = String(x.command || "").trim().slice(0, 500);
      const type = /^https?:\/\//i.test(url) || x.type === "remote" ? "remote" : "local";
      return {
        id: String(x.id || crypto.randomUUID()),
        name: cleanConnectorName(x.name) || "MCP server",
        type,
        url: type === "remote" ? url : "",
        command: type === "local" ? command : "",
        args: type === "local" ? String(x.args || "").trim().slice(0, 1000) : "",
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
  if (/glm|zai|z\.ai/.test(value) || provider === "glm" || provider === "boolean") return "GLM";
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
      createdAt: Date.now(), updatedAt: Date.now(), abort: null
    };
    threads.set(id, t);
    activeThreadId = id;
    return t;
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
        kind: isProjectThread(t) ? "project" : "chat", projectDir: t.projectDir || "" }));
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
      threads.set(t.id, { ...t, abort: null });
    }
    activeThreadId = restored.sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    if (repairedTitles) persist();
  } else {
    newThread();
  }

  // ── auto-exit when the app window closes ───────────────────────
  let lastPing = Date.now();
  let activeChats = 0;
  let byeTimer = null;
  const syncWarmEnv = () => { process.env.BOOLEAN_KEEP_ENGINE_WARM = config.ui?.keepLocalWarm !== false ? "1" : ""; };
  syncWarmEnv();
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
          cloud: CLOUD,
          keys: Object.fromEntries(Object.keys(CLOUD).map((k) => [k, !!config[k].apiKey])),
          projectsDir: config.projectsDir,
          referenceModel: config.referenceModel,
          connectors: publicConnectors(config),
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

      if (req.method === "POST" && p === "/api/cloud/logout") {
        try { await cloudRequest(config, "/auth/logout", { method: "POST", body: JSON.stringify({}) }); } catch { /* clear local session anyway */ }
        config.cloudBackend = { ...(config.cloudBackend || {}), sessionToken: "", user: null, tokens: null };
        saveConfig(config);
        json({ ok: true, cloudBackend: publicCloudBackend(config) });
        return;
      }

      if (req.method === "GET" && p === "/api/thread") {
        const t = threads.get(url.searchParams.get("id"));
        if (!t) return json({ error: "no such thread" }, 404);
        activeThreadId = t.id;
        json({ id: t.id, title: t.title, kind: isProjectThread(t) ? "project" : "chat",
          projectDir: t.projectDir || "", log: renderThread(t) });
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
        // remove a saved API key: { clearKey: "openai" }
        if (typeof body.clearKey === "string" && CLOUD[body.clearKey]) {
          config[body.clearKey].apiKey = "";
          if (config.provider === body.clearKey) config.provider = "local";
        }
        if (typeof body.projectsDir === "string" && body.projectsDir.trim()) config.projectsDir = body.projectsDir.trim();
        if (typeof body.referenceModel === "string" && body.referenceModel) config.referenceModel = body.referenceModel;
        if (body.connectors && typeof body.connectors === "object") config.connectors = mergeConnectors(config.connectors, body.connectors);
        if (body.ui && typeof body.ui === "object") { config.ui = { ...config.ui, ...body.ui }; syncWarmEnv(); }
        if (body.acceptEula === true) config.eulaAccepted = "1.0";
        saveConfig(config);
        json({ ok: true });
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
        persist();
        return streamRun(t, res);
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

      // ask the model to continue where it left off (context limit / stop / error)
      if (req.method === "POST" && p === "/api/continue") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        const content = "Continue exactly where you left off. Do not repeat work already done.";
        t.messages.push({ role: "user", content });
        t.log.push({ t: "user", text: "▸ continue", images: [] });
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
        const allowed = new Set(["boolean", ...Object.keys(CLOUD)]);
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
        t.messages.push({ role: "user", content });
        t.log.push({ t: "user", text: userTextOnly(content), images: imagesOf(content), at: Date.now() });
        if (config.ui?.learnedMemory !== false) learnFromUserText(userTextOnly(content));
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
          t.messages[0] = { role: "system", content: systemPrompt(runConfig.projectsDir, config.autoApprove, runConfig) };
        }

        const abort = new AbortController();
        t.abort = abort;
        let runIn = 0, runOut = 0, runEst = false;
        const ctx = {
          config: runConfig,
          browserUrl,
          signal: abort.signal,
          onStatus: (text) => send({ type: "status", text }),
          onToken: (text) => send({ type: "token", text }),
          onUsage: (u) => {
            runIn += u.input || 0; runOut += u.output || 0; runEst = runEst || !!u.estimated;
            if (u.model) replyModel = u.model;
            recordUsage(u.provider, u.model, u.input || 0, u.output || 0);
            send({ type: "tokens", input: runIn, output: runOut, estimated: runEst });
          },
          onStep: (step) => {
            const entry = { t: "tool", name: step.name, summary: stepSummary(step.name, step.args), result: step.result };
            t.log.push(entry);
            send({ type: "step", entry });
            if (step.name === "read_page") send({ type: "browser", action: "read", url: step.args?.url || browserUrl });
          },
          onOptimize: (o) => send({ type: "optimized", ...o }),
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

        activeChats++;
        lastPing = Date.now();
        try {
          const answer = await runTurn(ctx, t.messages);
          if (String(answer || "").trim()) {
            const aiLabel = shortAiName(replyProvider, replyModel);
            t.log.push({ t: "ai", text: answer, at: Date.now(), provider: replyProvider, model: replyModel, aiLabel });
            send({ type: "answer", text: answer, provider: replyProvider, model: replyModel, aiLabel });
          }
          if (runIn || runOut) {
            const usage = { t: "usage", input: runIn, output: runOut, estimated: runEst };
            t.log.push(usage);
            send({ type: "usage", ...usage });
          }
        } catch (err) {
          // translate the raw engine error into a clear vision hint
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
          if (provider === "boolean") {
            target.onCloudTokens = (tokens) => {
              config.cloudBackend = { ...(config.cloudBackend || {}), tokens };
              saveConfig(config);
            };
          }
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
    if (!fs.existsSync(icon)) icon = path.join(dir, "saz.exe"); // fall back to exe icon
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
