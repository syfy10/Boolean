import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const APP_VERSION = "0.9.12";
export const APP_DISPLAY_VERSION = "v0.09.12";
export const APP_NAME = "Boolean";
export const APP_TAGLINE = "local AI workspace.";
export const CLOUD_BACKEND_URL = "https://boolean-cloud.saz3labs.workers.dev";
export const AI_BEHAVIOR_VERSION = 2;

export const SAZ_DIR = path.join(os.homedir(), ".saz");
const CONFIG_FILE = path.join(SAZ_DIR, "config.json");
// pre-rename location (app used to be called sazcode)
const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".sazcode", "config.json");

export const PROVIDERS = ["local", "boolean", "openai", "glm", "zaiCoding", "claude"];
// providers that need an API key, and the friendly label for each
export const CLOUD = {
  openai: "OpenAI",
  glm: "GLM (Z.ai)",
  zaiCoding: "Z.AI Coding Plan",
  claude: "Claude (Anthropic)"
};

const DEFAULTS = {
  aiBehaviorVersion: AI_BEHAVIOR_VERSION,
  provider: "local",
  local: {
    model: "",            // gguf filename in ~/.saz/models
    port: 8783,
    ctx: 32768,           // context window; auto-trimmed so prompts never overflow it
    mmprojMap: {},        // model file -> vision projector (.mmproj) file ("" = explicitly none)
    visionTestMap: {}     // "model|mmproj" -> { ok, message, at }
  },
  boolean: {
    model: "@cf/qwen/qwen3-30b-a3b-fp8"
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
  // when true, run_command / write_file execute without asking first
  autoApprove: false,
  // EULA version the user accepted ("" = not yet accepted)
  eulaAccepted: "",
  // where generated projects are saved (user can change)
  projectsDir: path.join(os.homedir(), "Documents", "Boolean"),
  // reference model for the "estimated savings" figure
  referenceModel: "gpt-5.1",
  connectors: {
    mcp: [],              // [{id,name,command,args,enabled}]
    agents: []            // [{id,name,url,apiKey,enabled}]
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
    fontSize: "medium",       // small | medium | large
    density: "compact",       // compact is the fixed UI density
    notepadTheme: "yellow",    // Classic | Paper | Slate | Obsidian
    showTimestamps: false,
    showTokens: true,
    autoSave: true,           // persist chats to disk (workspace recovery)
    keepLocalWarm: true,      // keep llama-server running after the window closes
    collapseLogs: true,       // auto-collapse tool cards
    referenceChatMemory: true, // compact memory of the open chat for follow-ups
    learnedMemory: true,      // saved safe user preferences/behaviors
    notifications: false,
    contextMode: "balanced",  // minimal | balanced | full â€” Context Optimizer
    browserOpen: false,       // in-app browser panel visible
    browserW: 460,            // browser panel width (px)
    browserTabs: [],          // [{url,title}] restored on launch
    aiBrowser: true,          // allow the AI to browse the web (search/open/click/forms)
    systemActions: true,      // typed Windows inspection/settings/package actions
    searchEngine: "google",   // google | bing | duckduckgo â€” address-bar searches
    browserPerms: { downloads: true, camera: false, mic: false, geo: false },
    browserHistory: [],       // [{url,title,at}] capped at 100
    expandedSections: ["model"] // which Settings sections are open
  }
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const cfg = deepMerge(DEFAULTS, raw);
      // Coding Plan traffic must always use Z.AI's dedicated endpoint.
      cfg.zaiCoding.baseUrl = DEFAULTS.zaiCoding.baseUrl;
      if (!["GLM-5.1", "GLM-5-Turbo", "GLM-4.7", "GLM-4.5-Air"].includes(cfg.zaiCoding.model)) cfg.zaiCoding.model = "GLM-4.7";
      // Ollama support was removed â€” fall back to the built-in local engine
      if (!PROVIDERS.includes(cfg.provider)) cfg.provider = "local";
      // migrate configs saved before the context-window increase (8192 â†’ 32768)
      if (!cfg.local.ctx) cfg.local.ctx = 32768;
      const oldProjects = path.join(os.homedir(), "Documents", "SAZ3 Projects");
      const loxaProjects = path.join(os.homedir(), "Documents", "Loxa Projects");
      const booleanProjects = path.join(os.homedir(), "Documents", "Boolean Projects");
      const newProjects = path.join(os.homedir(), "Documents", "Boolean");
      if (cfg.projectsDir === oldProjects || cfg.projectsDir === loxaProjects || cfg.projectsDir === booleanProjects) cfg.projectsDir = newProjects;
      if (raw.aiBehaviorVersion !== AI_BEHAVIOR_VERSION) {
        cfg.aiBehaviorVersion = AI_BEHAVIOR_VERSION;
        cfg.ui.contextMode = "balanced";
        cfg.ui.referenceChatMemory = true;
        cfg.ui.learnedMemory = true;
        fs.mkdirSync(SAZ_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        fs.writeFileSync(path.join(SAZ_DIR, "preferences.json"), JSON.stringify({ rules: [] }, null, 2));
      }
      return cfg;
    } catch {
      /* try next */
    }
  }
  return structuredClone(DEFAULTS);
}

export function saveConfig(config) {
  fs.mkdirSync(SAZ_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// the model name active for the current provider
export function currentModel(config) {
  return config[config.provider]?.model || "";
}

export function setCurrentModel(config, model) {
  if (config[config.provider]) config[config.provider].model = model;
}
