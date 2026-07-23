import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const APP_VERSION = "0.9.48";
export const APP_DISPLAY_VERSION = "v0.09.48";
export const APP_NAME = "Boolean";
export const APP_TAGLINE = "local AI workspace.";
export const CLOUD_BACKEND_URL = "https://boolean-cloud.saz3labs.workers.dev";
export const AI_BEHAVIOR_VERSION = 2;

export const SAZ_DIR = path.join(os.homedir(), ".saz");
const CONFIG_FILE = path.join(SAZ_DIR, "config.json");
const CONFIG_BACKUP_FILE = path.join(SAZ_DIR, "config.json.bak");
// pre-rename location (app used to be called sazcode)
const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".sazcode", "config.json");

export const PROVIDERS = ["local", "openai", "glm", "zaiCoding", "claude", "customApi"];
// providers that need an API key, and the friendly label for each
export const CLOUD = {
  openai: "OpenAI",
  glm: "GLM (Z.ai)",
  zaiCoding: "Z.AI Coding Plan",
  claude: "Claude (Anthropic)",
  customApi: "Custom API"
};

const DEFAULTS = {
  aiBehaviorVersion: AI_BEHAVIOR_VERSION,
  provider: "local",
  cloudFallback: {
    enabled: false,
    provider: "",
    model: ""
  },
  local: {
    model: "",            // gguf filename in ~/.saz/models
    port: 8783,
    ctx: 32768,           // context window; auto-trimmed so prompts never overflow it
    mmprojMap: {},        // model file -> vision projector (.mmproj) file ("" = explicitly none)
    visionTestMap: {}     // "model|mmproj" -> { ok, message, at }
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.1",
    apiKey: ""
  },
  glm: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.6",
    apiKey: ""
  },
  zaiCoding: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    model: "GLM-4.7",
    apiKey: "",
    approvedUse: false
  },
  claude: {
    // Anthropic's OpenAI-compatible endpoint â€” same chat/completions shape
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5",
    apiKey: ""
  },
  customApi: {
    connectionId: "",
    name: "Custom API",
    baseUrl: "",
    model: "",
    apiKey: "",
    approvedUse: false
  },
  imageGeneration: {
    provider: "openai",
    model: "gpt-image-1",
    size: "1024x1024"
  },
  // when true, run_command / write_file execute without asking first
  autoApprove: false,
  // EULA version the user accepted ("" = not yet accepted)
  eulaAccepted: "",
  // where generated projects are saved (user can change)
  projectsDir: path.join(os.homedir(), "Documents", "Boolean"),
  // reference model for the "estimated savings" figure
  referenceModel: "gpt-5.1",
  // monthly cloud spending budget in USD. 0 = no limit. UI warns at 80%+.
  budgetLimit: 0,
  connectors: {
    apis: [],             // [{id,name,baseUrl,model,apiKey,approvedUse,enabled}] OpenAI-compatible APIs
    mcp: [],              // [{id,name,url,token,oauth,enabled}] remote Streamable-HTTP MCP servers
    agents: [],           // [{id,name,url,apiKey,enabled}]
    email: {
      draftOnly: true,
      confirmBeforeSend: true,
      gmail: { clientId: "", manualClientId: "", manualClientSecret: "", clientSource: "", connected: false, account: "", oauth: null },
      outlook: { clientId: "", manualClientId: "", manualClientSecret: "", clientSource: "", connected: false, account: "", oauth: null }
    }
  },
  cloudBackend: {
    url: CLOUD_BACKEND_URL,
    sessionToken: "",
    user: null,
    tokens: null
  },
  // Kept for compatibility with older config files. Agent work now continues
  // until completion, user cancellation, or the repeated-action guard.
  maxToolTurns: 0,
  commandTimeoutMs: 120000,
  // UI/behavior preferences (surfaced in the organized Settings page)
  ui: {
    theme: "system",          // system | light | dark
    composerStyle: "simple",  // pill | simple
    fontSize: "medium",       // small | medium | large
    density: "compact",       // compact is the fixed UI density
    notepadTheme: "yellow",    // Classic | Paper | Slate | Obsidian
    browserSummaryAutoSave: true, // save browser Summarize answers into Notes
    showTimestamps: false,
    showTokens: true,
    showOnboarding: false,    // Settings can show the first-run setup once again
    onboarded: false,         // durable first-run welcome completion
    autoSave: true,           // persist chats to disk (workspace recovery)
    keepLocalWarm: true,      // keep llama-server running after the window closes
    collapseLogs: true,       // auto-collapse tool cards
    referenceChatMemory: true, // compact memory of the open chat for follow-ups
    learnedMemory: true,      // saved safe user preferences/behaviors
    notifications: false,
    autoRouteModels: false,   // automatically select the configured model route for each task type
    modelRouting: { selected: "chat" },
    contextMode: "balanced",  // minimal | balanced | full â€” Context Optimizer
    codingAgent: {
      mode: "quick",          // quick | feature | debug | review | refactor
      autoTest: true,
      stopLoop: false,
      maxRetries: 2,
      budget: "normal",       // small | normal | large
      autoCommit: false
    },
    browserOpen: false,       // in-app browser panel visible
    cleanStartup: true,       // open with sidebar/workspace tabs/panels closed
    browserW: 460,            // browser panel width (px)
    browserTabs: [],          // [{url,title}] restored on launch
    aiBrowser: true,          // allow the AI to browse the web (search/open/click/forms)
    systemActions: true,      // typed Windows inspection/settings/package actions
    searchEngine: "google",   // google | bing | duckduckgo â€” address-bar searches
    researchPolicy: "authoritative",
    browserPerms: { downloads: true, camera: false, mic: false, geo: false },
    browserHistory: [],       // [{url,title,at}] capped at 100
    expandedSections: ["model"], // which Settings sections are open
    // ── Keyboard Shortcuts ──
    shortcuts: {
      custom: {},             // { actionId: "Ctrl+Shift+K" }
      conflicts: []           // detected conflicts
    },
    // ── Voice & Input ──
    voice: {
      enabled: false,
      tts: false,
      autoPunct: true,
      lang: "en-US",
      speed: 1.0
    },
    // ── Notifications & Alerts ──
    notif: {
      inApp: true,
      desktop: false,
      sound: false,
      volume: 50,
      budgetWarn: true,
      errors: true
    },
    // ── Privacy extras ──
    privacy: {
      retention: "local",     // local | cloud | hybrid
      clipboard: true,
      masking: true,
      telemetry: false,
      encryption: false
    },
    // ── Advanced extras ──
    apiOverrides: {},          // { openai: "https://...", claude: "..." }
    proxy: ""                  // "http://127.0.0.1:7890" or ""
  }
};

export function defaultUiSettings() {
  return structuredClone(DEFAULTS.ui);
}

export function defaultConfig() {
  return structuredClone(DEFAULTS);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function preserveApiKey(next, previous, provider) {
  if (!next?.[provider] || !previous?.[provider]) return;
  if (!nonEmptyString(next[provider].apiKey) && nonEmptyString(previous[provider].apiKey)) {
    next[provider].apiKey = previous[provider].apiKey;
  }
}

function preserveKeyedApiKeys(nextItems, previousItems) {
  if (!Array.isArray(nextItems) || !Array.isArray(previousItems)) return;
  const previousById = new Map(previousItems.map((item) => [item?.id, item]).filter(([id]) => id));
  for (const item of nextItems) {
    if (!item?.id) continue;
    const previous = previousById.get(item.id);
    if (!nonEmptyString(item.apiKey) && nonEmptyString(previous?.apiKey)) item.apiKey = previous.apiKey;
  }
}

function preserveMcpCredentials(nextItems, previousItems) {
  if (!Array.isArray(nextItems) || !Array.isArray(previousItems)) return;
  const previousById = new Map(previousItems.map((item) => [item?.id, item]).filter(([id]) => id));
  const previousByUrl = new Map(previousItems.map((item) => [item?.url, item]).filter(([url]) => url));
  for (const item of nextItems) {
    const previous = previousById.get(item?.id) || previousByUrl.get(item?.url);
    if (!previous) continue;
    if (!nonEmptyString(item.token) && nonEmptyString(previous.token)) item.token = previous.token;
    if (!item.oauth && previous.oauth) item.oauth = structuredClone(previous.oauth);
    for (const field of ["toolCount", "tools", "lastTestedAt", "lastTestStatus", "lastError", "needsReconnect"]) {
      if (item[field] === undefined && previous[field] !== undefined) item[field] = structuredClone(previous[field]);
    }
  }
}

function hasSavedEmailCredential(connection) {
  return !!connection?.oauth
    || nonEmptyString(connection?.clientId)
    || nonEmptyString(connection?.manualClientId)
    || nonEmptyString(connection?.manualClientSecret)
    || nonEmptyString(connection?.account)
    || connection?.connected === true;
}

function restoreEmailConnection(nextEmail, prevEmail) {
  if (!nextEmail || !prevEmail || !hasSavedEmailCredential(prevEmail)) return;
  const nextHasCredential = hasSavedEmailCredential(nextEmail);
  if (!nextHasCredential) {
    Object.assign(nextEmail, structuredClone(prevEmail));
    return;
  }
  if (!nonEmptyString(nextEmail.clientId) && nonEmptyString(prevEmail.clientId)) nextEmail.clientId = prevEmail.clientId;
  if (!nonEmptyString(nextEmail.manualClientId) && nonEmptyString(prevEmail.manualClientId)) nextEmail.manualClientId = prevEmail.manualClientId;
  if (!nonEmptyString(nextEmail.manualClientSecret) && nonEmptyString(prevEmail.manualClientSecret)) nextEmail.manualClientSecret = prevEmail.manualClientSecret;
  if (!nonEmptyString(nextEmail.clientSource) && nonEmptyString(prevEmail.clientSource)) nextEmail.clientSource = prevEmail.clientSource;
  if (!nonEmptyString(nextEmail.account) && nonEmptyString(prevEmail.account)) nextEmail.account = prevEmail.account;
  if (!nextEmail.oauth && prevEmail.oauth && nextEmail.connected !== false) {
    nextEmail.oauth = prevEmail.oauth;
    nextEmail.connected = true;
  }
  if (nextEmail.connected !== true && prevEmail.connected === true && nextEmail.oauth) nextEmail.connected = true;
}

export function preserveSavedApiKeys(next, previous) {
  if (!next || !previous) return next;
  for (const provider of ["openai", "glm", "zaiCoding", "claude", "customApi"]) {
    preserveApiKey(next, previous, provider);
  }
  for (const provider of ["gmail", "outlook"]) {
    const nextEmail = next.connectors?.email?.[provider];
    const prevEmail = previous.connectors?.email?.[provider];
    restoreEmailConnection(nextEmail, prevEmail);
  }
  preserveKeyedApiKeys(next.connectors?.apis, previous.connectors?.apis);
  preserveKeyedApiKeys(next.connectors?.agents, previous.connectors?.agents);
  preserveMcpCredentials(next.connectors?.mcp, previous.connectors?.mcp);
  return next;
}

function mergeMissingConnectorRows(nextItems, previousItems) {
  const next = Array.isArray(nextItems) ? nextItems : [];
  if (!Array.isArray(previousItems) || !previousItems.length) return next;
  const identities = new Set(next.map((item) => item?.id || item?.url).filter(Boolean));
  for (const item of previousItems) {
    const identity = item?.id || item?.url;
    if (!identity || identities.has(identity)) continue;
    next.push(structuredClone(item));
    identities.add(identity);
  }
  return next;
}

export function preserveSavedConnections(next, previous) {
  if (!next || !previous?.connectors) return next;
  next.connectors = next.connectors || {};
  for (const kind of ["apis", "mcp", "agents"]) {
    next.connectors[kind] = mergeMissingConnectorRows(
      next.connectors[kind],
      previous.connectors[kind]
    );
  }
  next.connectors.email = next.connectors.email || {};
  for (const provider of ["gmail", "outlook"]) {
    if (!next.connectors.email[provider] && previous.connectors.email?.[provider]) {
      next.connectors.email[provider] = structuredClone(previous.connectors.email[provider]);
    }
  }
  return next;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  const backup = file + ".bak";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  } catch {
    /* backup is best-effort; never block saving config */
  }
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  for (const file of [CONFIG_FILE, CONFIG_BACKUP_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const raw = readJsonFile(file);
      const cfg = deepMerge(DEFAULTS, raw);
      // Coding Plan traffic must always use Z.AI's dedicated endpoint.
      cfg.zaiCoding.baseUrl = DEFAULTS.zaiCoding.baseUrl;
      if (!["GLM-5.1", "GLM-5-Turbo", "GLM-4.7", "GLM-4.5-Air"].includes(cfg.zaiCoding.model)) cfg.zaiCoding.model = "GLM-4.7";
      // Ollama support was removed â€” fall back to the built-in local engine
      if (!PROVIDERS.includes(cfg.provider)) cfg.provider = "local";
      // migrate configs saved before the context-window increase (8192 â†’ 32768)
      if (!cfg.local.ctx) cfg.local.ctx = 32768;
      let migrated = false;
      if (raw.ui && raw.ui.onboarded === undefined && (raw.eulaAccepted || raw.ui.showOnboarding === false)) {
        cfg.ui.onboarded = true;
        cfg.ui.showOnboarding = false;
        migrated = true;
      }
      const oldProjects = path.join(os.homedir(), "Documents", "SAZ3 Projects");
      const loxaProjects = path.join(os.homedir(), "Documents", "Loxa Projects");
      const booleanProjects = path.join(os.homedir(), "Documents", "Boolean Projects");
      const newProjects = path.join(os.homedir(), "Documents", "Boolean");
      if (cfg.projectsDir === oldProjects || cfg.projectsDir === loxaProjects || cfg.projectsDir === booleanProjects) { cfg.projectsDir = newProjects; migrated = true; }
      if (raw.aiBehaviorVersion !== AI_BEHAVIOR_VERSION) {
        cfg.aiBehaviorVersion = AI_BEHAVIOR_VERSION;
        cfg.ui.contextMode = "balanced";
        cfg.ui.referenceChatMemory = true;
        cfg.ui.learnedMemory = true;
        migrated = true;
      }
      if (migrated) {
        saveConfig(cfg);
      }
      if (raw.aiBehaviorVersion !== AI_BEHAVIOR_VERSION) {
        atomicWriteJson(path.join(SAZ_DIR, "preferences.json"), { rules: [] });
      }
      return cfg;
    } catch {
      /* try next */
    }
  }
  return structuredClone(DEFAULTS);
}

export function saveConfig(config, options = {}) {
  const preserveSecrets = options.preserveSecrets !== false;
  const preserveConnections = options.preserveConnections !== false;
  let next = config;
  try {
    const previous = readJsonFile(CONFIG_FILE);
    if (preserveConnections) next = preserveSavedConnections(next, previous);
    if (preserveSecrets) next = preserveSavedApiKeys(next, previous);
  } catch {
    next = config;
  }
  atomicWriteJson(CONFIG_FILE, next);
}

// the model name active for the current provider
export function currentModel(config) {
  return config[config.provider]?.model || "";
}

export function setCurrentModel(config, model) {
  if (config[config.provider]) config[config.provider].model = model;
}
