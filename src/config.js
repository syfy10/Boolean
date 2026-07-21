import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const APP_VERSION = "0.9.42";
export const APP_DISPLAY_VERSION = "v0.09.42";
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
      gmail: { clientId: "", manualClientId: "", clientSource: "", connected: false, account: "", oauth: null },
      outlook: { clientId: "", manualClientId: "", clientSource: "", connected: false, account: "", oauth: null }
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

export function preserveSavedApiKeys(next, previous) {
  if (!next || !previous) return next;
  for (const provider of ["openai", "glm", "zaiCoding", "claude", "customApi"]) {
    preserveApiKey(next, previous, provider);
  }
  preserveKeyedApiKeys(next.connectors?.apis, previous.connectors?.apis);
  preserveKeyedApiKeys(next.connectors?.agents, previous.connectors?.agents);
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
  let next = config;
  if (preserveSecrets) {
    try {
      next = preserveSavedApiKeys(config, readJsonFile(CONFIG_FILE));
    } catch {
      next = config;
    }
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
