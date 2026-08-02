// Generates site/demo/fixtures.json — sanitized API responses for the marketing demo.
// Source of truth for shape is a live /api/* capture, but ALL private data is
// overwritten with generic content here so nothing personal ships to the public site.
//
// Usage: capture live fixtures into a dir, then:
//   node site/demo/gen-fixtures.mjs <captureDir>
// If <captureDir> is omitted or missing, a built-in minimal skeleton is used so the
// build stays reproducible without a running app.
import fs from "node:fs";
import path from "node:path";

const capDir = process.argv[2] || "";
const readCap = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(capDir, name), "utf8")); }
  catch { return fallback; }
};

const DAY = 86400000, HOUR = 3600000;
const now = Date.now();

// Generic, non-identifying sidebar content.
const threads = [
  { id: "demo-new",  title: "New chat",        updatedAt: now,            pinned: false, kind: "chat",    side: false, projectDir: "", pendingTask: null },
  { id: "demo-proj", title: "My Project",      updatedAt: now - 2 * DAY,  pinned: false, kind: "project", side: false, projectDir: "C:/Users/you/Documents/My Project", pendingTask: null },
  { id: "demo-c1",   title: "Getting started", updatedAt: now - 10 * HOUR, pinned: false, kind: "chat",   side: false, projectDir: "", pendingTask: null },
  { id: "demo-c2",   title: "Draft blog post", updatedAt: now - 11 * HOUR, pinned: false, kind: "chat",   side: false, projectDir: "", pendingTask: null },
  { id: "demo-c3",   title: "Trip itinerary",  updatedAt: now - 12 * HOUR, pinned: false, kind: "chat",   side: false, projectDir: "", pendingTask: null },
  { id: "demo-c4",   title: "Bug fix ideas",   updatedAt: now - 13 * HOUR, pinned: false, kind: "chat",   side: false, projectDir: "", pendingTask: null },
  { id: "demo-c5",   title: "Meeting notes",   updatedAt: now - 22 * HOUR, pinned: false, kind: "chat",   side: false, projectDir: "", pendingTask: null },
];
const activeThreadId = "demo-new";

const providerReady = { local: true, openai: false, claude: false, google: false, xai: false, deepseek: false, qwen: false, baidu: false, bytedance: false, glm: false, zaiCoding: false, kimi: false, customApi: false };
const keysAllFalse = { openai: false, google: false, xai: false, deepseek: false, qwen: false, baidu: false, bytedance: false, glm: false, zaiCoding: false, claude: false, kimi: false, customApi: false };

// ---- state ----
const stateCap = readCap("state.json", {});
const state = {
  ...stateCap,
  provider: "local",
  model: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
  backendUp: true,
  providerReady,
  keys: keysAllFalse,
  userApi: { name: "Custom API", baseUrl: "", model: "", hasKey: false },
  thirdParty: {},
  connectors: { apis: [], mcp: [] },
  cloudBackend: { url: "", signedIn: false, user: null, tokens: null },
  budgetLimit: 0,
  autoApprove: true,
  projectsDir: "C:/Users/you/Documents",
  threads,
  activeThreadId,
  activeThread: null,
  eulaAccepted: true,
};
if (state.imageGeneration) state.imageGeneration = { ...state.imageGeneration, providers: [] };
if (state.vision) state.vision = { ...state.vision, candidates: [] };
state.ui = { ...(stateCap.ui || {}), onboarded: true, showOnboarding: false, browserOpen: false, notepadOpen: false, browserHistory: [], browserBookmarks: [], browserTabs: [] };
// Provide sane fallbacks if capture was empty.
state.appName ??= "Boolean";
state.version ??= "0.9.70";
state.displayVersion ??= "v0.9.70";
state.providers ??= ["local", "openai", "claude", "google", "glm"];
state.models ??= [];
// Ensure the selected local model is present and installed so the app reports
// "Ready" (selectedLocalModelReady) and lets the demo send.
if (!state.models.some(m => m && m.name === state.model)) {
  state.models.unshift({ name: state.model, installed: true, healthy: true, healthReason: "", vision: false });
} else {
  state.models = state.models.map(m => (m && m.name === state.model) ? { ...m, installed: true, healthy: true } : m);
}
state.providerModels ??= {};
state.cloud ??= {};

// ---- status ----
const statusCap = readCap("status.json", {});
const status = {
  ...statusCap,
  provider: "local",
  model: state.model,
  autoApprove: true,
  backendUp: true,
  providerReady,
  threads,
  activeThreadId,
  activeThread: null,
};

// ---- about (public repo info; safe to keep, but strip any local paths) ----
const about = readCap("about.json", { appName: "Boolean", version: "0.9.70", displayVersion: "v0.9.70", channel: "Stable", repository: "https://github.com/syfy10/Boolean", sourceAvailable: true });

const fixtures = {
  "/api/state": state,
  "/api/status": status,
  "/api/about": about,
  "/api/skills": { skills: [] },
  "/api/top-prompts": { prompts: [] },
  "/api/preferences": { rules: [] },
  "/api/usage": { input: 0, output: 0, total: 0, cost: 0, rows: [] },
  "/api/automations": { automations: [] },
  "/api/agent-runs": { runs: [] },
  "/api/project-status": {},
  "/api/provider-models": { models: [] },
  "/api/estimate": { tokens: 0 },
};

const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures.json");
fs.writeFileSync(out, JSON.stringify(fixtures, null, 1));
console.log("wrote", out, "(" + fs.statSync(out).size + " bytes)");
