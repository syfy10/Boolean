// Local HTTP server hosting the Boollm UI and bridging it to the agent loop.
// NDJSON streaming for chat; approvals round-trip to the browser as events.
// Multi-thread conversation store, per-thread stop/abort, image attachments.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import * as sea from "node:sea";
import { listCodeExtensions, discoverLanguageServices } from "./code-extensions.js";
import {
  saveConfig, currentModel, setCurrentModel, PROVIDERS, CLOUD,
  APP_VERSION, APP_DISPLAY_VERSION, APP_NAME, APP_TAGLINE, CLOUD_BACKEND_URL,
  ACCESS_MODES, currentAccessMode, defaultConfig, defaultUiSettings, SAZ_DIR
} from "./config.js";
import { tradeConsentActive, armExpiresAt, armWindowMs, evaluateTradeGuard } from "./trade-guard.js";
import { currentTradeState, recordTradePlacement } from "./trade-ledger.js";
import { recordSignalOutcomes, signalStats } from "./signal-log.js";
import { systemPrompt, projectBrief, runTurn, runSubagent, estimateContext, classifyTurnMode, currentTurnInstructionText, requiresArtifactAction, requiresConnectorContinuationAction, isExplicitTaskContinuation, isTaskRefinement, isTaskStatusQuestion, taskStopAnswer } from "./agent.js";
import { resolveTarget, chatCompletion, listProviderModels, backendUp, clearProviderModelCache } from "./providers.js";
import {
  capabilityProbeTool,
  capabilityProbeUnsupportedError,
  evaluateCapabilityProbeReply,
  modelCapabilityKey,
  modelCapabilityProfile,
  nativeToolSupport,
  recordNativeToolSupport
} from "./model-capabilities.js";
import * as engine from "./engine.js";
import { recordUsage, resetUsage, summarizeUsage, checkBudget, monthSpend, costOf } from "./usage.js";
import { saveThreads, loadThreads, clearThreads, buildLocalChatMemory } from "./store.js";
import { handleBrowse, clearCookies } from "./browse.js";
import { executeTool } from "./tools.js";
import { simplePdf } from "./platform.js";
import { learnFromUserText, publicPreferences, deletePreference, updatePreference, clearPreferences, recordResponseFeedback } from "./preferences.js";
import { cloudVaultSnapshot, cloudVaultSummary, mergeCloudVault } from "./cloud-vault.js";
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
  mcpCallTool,
  MCP_STATUS
} from "./mcp.js";
import {
  verifyCloudflareToken,
  verifyCloudflareOAuthToken,
  cloudflareResourceList,
  createCloudflareOAuth,
  exchangeCloudflareOAuthCode
} from "./cloudflare.js";
import {
  verifyAzureConnection, azureResourceList,
  verifyAwsConnection, awsResourceList,
  verifyGoogleCloudConnection, googleCloudResourceList
} from "./cloud-hosting.js";
import { getCotSnapshot, getMarketDashboard, getMarketQuote, getMarketSnapshot, getOptionsChain, getSectorPerformance, getTradeIdeas, runStrategyBacktest, testMarketSettings } from "./markets.js";
import {
  createEmailOAuth,
  exchangeEmailCode,
  emailAccountId,
  getEmailAccount,
  isValidGmailOAuthClientId,
  publicEmailConnections,
  savedEmailAccounts
} from "./email.js";
import { emailOAuthRedirectUri, loadManagedEmailOAuthClients, managedEmailOAuthCredential } from "./email-oauth-config.js";
import { manageAutomation, setAutomationActionHandler, startAutomationScheduler, manageSkill, installedSkills, ghStatus } from "./platform.js";
import { appPath } from "./paths.js";
import { EDITOR_ASSET_PREFIX, resolveEditorAsset } from "./editor-assets.js";
import { detectLocalServers } from "./local-servers.js";
import { marketsRoutes } from "./routes/markets.js";
import { detectWebsiteTech } from "./tech-detector.js";
import { gitCommit, gitCreateBranch, gitDiffFiles, gitFileContents, gitPushBranch, gitRestoreFiles, gitSourceStatus, gitStageFiles, githubCreatePullRequest } from "./git-review.js";
import {
  combineWorkspaceChanges,
  mergeWorkspaceChanges,
  normalizeWorkspaceChanges,
  workspaceChangeStats,
  workspaceChangesReport,
  workspaceChangesReview
} from "./workspace-changes.js";
import { applyAgentRun, discardAgentRun, listAgentRuns } from "./orchestrator.js";
import { autoModelHealthSnapshot, autoSubscriptionEnabled, canonicalModelId, routeForTurn, selectExecutionEngine } from "./model-router.js";
import { createCodexAppServer, installCodexStandaloneCli } from "./codex-app-server.js";
import { codexToolEnvironment, createCodexRunner } from "./codex-runner.js";
import {
  installClaudeCode, readClaudeCodeStatus,
  runClaudeCodeTurn, startClaudeCodeLogin
} from "./claude-code.js";
import officialEducationCatalog from "./education-official.json" with { type: "json" };
import { listActions, searchActions } from "./actions.js";
import {
  listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile,
  createWorkspaceEntry, renameWorkspaceEntry, deleteWorkspaceEntry,
  findWorkspaceFiles, findWorkspaceSymbols, searchWorkspaceText
} from "./workspace-files.js";

const studioVideoOperations = new Map();

async function detectOpenCodex() {
  const endpoint = "http://127.0.0.1:10100";
  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return { detected: false, endpoint, status: response.status };
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id || "")).filter(Boolean) : [];
    return { detected: true, endpoint, apiBase: `${endpoint}/v1`, models: models.slice(0, 50), modelCount: models.length };
  } catch {
    return { detected: false, endpoint };
  }
}

// Labels the trading bar looks for on the broker's own order form when it
// types a ticket. Values are matched against a control's visible text, label,
// placeholder, name, or id, so "quantity" finds a Quantity field. Nothing here
// places an order on its own — it only says where each number goes.
// Values may contain {symbol} and {Side}, expanded per ticket by the bar — a
// broker's final button is usually named after the order ("Buy SPY"), so a
// fixed label could never match it.
const TICKET_FIELD_KEYS = ["quantity", "orderType", "timeInForce", "limit", "trigger", "trail",
  "stop", "target", "positionEffect", "buy", "sell", "place", "cancel"];
// Order settings that belong to the account rather than to one order, so the
// bar can keep them out of the four lines and still send them every time.
const TICKET_DEFAULT_KEYS = ["positionEffect", "instruction", "exchange", "taxLot", "accountName",
  "submitAt", "submitOn", "cancelAt", "cancelOn", "tif"];
export function normalizeTicketDefaults(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of TICKET_DEFAULT_KEYS) {
    const value = String(raw[key] || "").trim().slice(0, 60);
    if (value) out[key] = value;
  }
  return out;
}

export function normalizeTicketFields(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of TICKET_FIELD_KEYS) {
    // A slot may hold one label or several to try in order — brokers name the
    // same control differently, and a page that answers to none of the
    // built-in guesses needs somewhere to put the one that works.
    const values = (Array.isArray(raw[key]) ? raw[key] : [raw[key]])
      .map((value) => String(value || "").trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
    if (values.length) out[key] = values;
  }
  return out;
}

// Whether Boollm may click trade controls on the broker page at all. Shared by
// the ticket and by cancelling, because they need the same consent: the
// permission switch, a signed-in user whose risk agreement matches, and an arm
// window that has not lapsed.
export function tradeClickPermission(config = {}) {
  const perms = config.ui?.browserPerms || {};
  const user = String(config.cloudBackend?.user?.email || config.cloudBackend?.user?.id || "").trim().toLowerCase();
  const consentUser = String(perms.tradeConsentUser || "").trim().toLowerCase();
  const tradeClicks = perms.tradeClicks === true;
  const cloudUser = config.cloudBackend?.user || {};
  const admin = cloudUser.role === "admin" || cloudUser.is_admin === true;
  const identityOk = admin && !!config.cloudBackend?.sessionToken && !!user && consentUser === user;
  const armed = tradeConsentActive(config);
  return {
    tradeClicks,
    identityOk,
    armed,
    canClick: tradeClicks && identityOk && armed,
    reason: !tradeClicks
      ? "Confirmed trade clicks is off in Settings > Browser."
      : !identityOk
        ? "Trading is available only to a signed-in Boollm administrator whose risk agreement matches the current user."
        : !armed
          ? "Trade clicks have auto-disarmed. Press Arm to re-arm."
          : ""
  };
}

export function normalizeTradingStrategy(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const timeframe = [1, 5, 15].includes(Number(input.timeframeMinutes))
    ? Number(input.timeframeMinutes)
    : 5;
  const modes = new Set(["breakout", "ema", "meanReversion", "all"]);
  const requestedMode = String(input.mode || (input.key === "breakout" ? "breakout" : ""));
  const mode = modes.has(requestedMode) ? requestedMode : "all";
  const fastBars = Math.min(50, Math.max(3, Math.round(Number(input.fastBars) || 9)));
  const slowBars = Math.min(100, Math.max(fastBars + 2, Math.round(Number(input.slowBars) || 21)));
  return {
    enabled: input.enabled === true,
    key: mode === "all" ? "multi" : mode,
    mode,
    timeframeMinutes: timeframe,
    lookbackBars: Math.min(100, Math.max(5, Math.round(Number(input.lookbackBars) || 20))),
    fastBars,
    slowBars,
    meanBars: Math.min(100, Math.max(10, Math.round(Number(input.meanBars) || 20))),
    meanSigma: Math.min(3, Math.max(1, Number(input.meanSigma) || 2)),
    riskReward: Math.min(5, Math.max(1, Number(input.riskReward) || 2)),
    maxSignalsPerDay: Math.min(10, Math.max(1, Math.round(Number(input.maxSignalsPerDay) || 4))),
    cooldownBars: Math.min(12, Math.max(1, Math.round(Number(input.cooldownBars) || 2))),
    // Stops used to be the signal candle's own low/high, which on a thin bar
    // sits cents from the entry. The stop is now floored at this many ATRs.
    // 0 restores the old candle-extreme behaviour.
    atrBars: Math.min(50, Math.max(5, Math.round(Number(input.atrBars) || 14))),
    atrStopMultiple: Math.min(3, Math.max(0, Number(input.atrStopMultiple ?? 1))),
    // Regime gate. Breakout and EMA want a trending tape; mean reversion wants
    // a still one. These thresholds are starting assumptions — the signal log
    // records the regime with every signal so they can be checked against real
    // outcomes rather than left as guesses.
    regimeFilter: input.regimeFilter !== false,
    trendMinEfficiency: Math.min(1, Math.max(0, Number(input.trendMinEfficiency ?? 0.35))),
    rangeMaxEfficiency: Math.min(1, Math.max(0, Number(input.rangeMaxEfficiency ?? 0.25))),
    // How far past the range edge a breakout close must land, in ATRs, before
    // it counts as a break rather than a poke.
    breakoutBufferAtr: Math.min(2, Math.max(0, Number(input.breakoutBufferAtr ?? 0.25))),
    // How many completed bars a fired signal is followed for before it is
    // recorded as unresolved.
    outcomeHorizonBars: Math.min(100, Math.max(5, Math.round(Number(input.outcomeHorizonBars) || 20)))
  };
}

function decodeHtmlText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, " ").trim();
}

function websiteMeta(html, baseUrl) {
  const attr = (tag, name) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1] || "";
  const metas = [...String(html).matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);
  const pickMeta = (...names) => {
    const wanted = names.map(name => name.toLowerCase());
    for (const tag of metas) {
      const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
      if (wanted.includes(key)) return decodeHtmlText(attr(tag, "content"));
    }
    return "";
  };
  const title = pickMeta("og:title", "twitter:title") || decodeHtmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const description = pickMeta("og:description", "twitter:description", "description");
  const image = pickMeta("og:image", "twitter:image");
  const theme = pickMeta("theme-color");
  const links = [...String(html).matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
  const logoTag = links.find(tag => /(?:icon|apple-touch-icon)/i.test(attr(tag, "rel"))) || "";
  const resolve = value => { try { return value ? new URL(value, baseUrl).toString() : ""; } catch { return ""; } };
  const colorHits = [...String(html).matchAll(/#[0-9a-f]{6}\b/gi)].map(match => match[0].toLowerCase());
  const srcsetFirst = value => String(value || "").split(",").map(item => item.trim().split(/\s+/)[0]).filter(Boolean).at(-1) || "";
  const imageTags = [...String(html).matchAll(/<(?:img|source)\b[^>]*>/gi)].map(match => match[0]);
  const tagImages = imageTags.flatMap(tag => [
    attr(tag, "src"), attr(tag, "data-src"), attr(tag, "data-lazy-src"),
    srcsetFirst(attr(tag, "srcset") || attr(tag, "data-srcset"))
  ]);
  const cssImages = [...String(html).matchAll(/(?:background(?:-image)?\s*:[^;}]*)?url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]);
  const jsonImages = [...String(html).matchAll(/["'](?:image|imageUrl|thumbnailUrl|contentUrl)["']\s*:\s*["']([^"']+)["']/gi)].map(match => match[1]);
  const imageUrls = [...new Set([...tagImages, ...cssImages, ...jsonImages].map(resolve).filter(Boolean))].filter(url => {
    const value = url.toLowerCase();
    return !/\.(?:svg)(?:\?|$)/.test(value) && !/(?:pixel|spacer|tracking|analytics|favicon|emoji|sprite)[._/-]/.test(value);
  }).slice(0, 40);
  const colors = [...new Set([theme, ...colorHits].filter(value => /^#[0-9a-f]{6}$/i.test(value)))].slice(0, 5);
  return { title, description, imageUrl: resolve(image), logoUrl: resolve(attr(logoTag, "href")), imageUrls, colors };
}

function normalizeTradingSymbol(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 24);
}

function extractTradingSymbolFromUrl(rawUrl = "", rawTitle = "") {
  const normalizeCandidate = (candidate = "") => {
    const raw = String(candidate || "");
    const safeRaw = (() => {
      try { return decodeURIComponent(raw); } catch { return raw; }
    })();
    const firstPart = safeRaw.split("/")[0];
    const slashPart = firstPart.split("?")[0];
    const hashPart = slashPart.split("#")[0];
    const trimmed = hashPart.trim();
    if (!trimmed) return "";

    const [left, right] = trimmed.split(":");
    if (right && /^(NYSE|NASDAQ|AMEX|BATS|CBOE|INDEX|INDEXCBOE|ARCA|ISE|OTC|XNAS|XNYS|XASE|DJI|IXIC)$/i.test(left)) {
      return normalizeTradingSymbol(right);
    }
    if (right) return normalizeTradingSymbol(left);
    if (/^[A-Z0-9]+-[A-Z0-9]/i.test(trimmed)) {
      const withoutExchange = trimmed.replace(/^[^-]+\-/i, "").replace(/^[^.]+\^/i, "^");
      const candidate = normalizeTradingSymbol(withoutExchange);
      if (candidate) return candidate;
    }
    return normalizeTradingSymbol(trimmed);
  };
  const isLikelyTicker = (candidate = "") => {
    const value = String(candidate || "");
    return /^[A-Z0-9.^=-]{2,12}$/.test(value) && /[A-Z]/.test(value);
  };
  const extractFromCandidate = (candidate = "") => {
    const normalized = normalizeCandidate(candidate);
    return isLikelyTicker(normalized) ? normalized : "";
  };
  const extractFromTitleText = (raw = "") => {
    const source = String(raw || "")
      .toUpperCase()
      .replace(/\r?\n/g, " ")
      .replace(/&[A-Z]{2,6};/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!source) return "";

    const stripAndParse = (candidate = "") => {
      const normalized = normalizeCandidate(candidate);
      if (!normalized || !/[A-Z]/.test(normalized)) return "";
      if (!isLikelyTicker(normalized)) return "";
      if (normalized.length < 2 || normalized.length > 12) return "";
      return normalized;
    };
    const titlePatterns = [
      /(?:\(|\s)([A-Z]{1,4}:\s*)?([A-Z0-9.^=-]{2,12})(?=\)|\s|$|[|-])/g,
      /\b(?:SYMBOL|TICKER)\s*[:\-]\s*([A-Z0-9.^=-]{2,12})\b/g,
      /\b([A-Z0-9.^=-]{2,12})\s*-\s*(?:STOCK|ETF|INDEX|QUOTE|CHART|OPTIONS?|FUTURE(?:S)?)\b/g
    ];
    for (const regex of titlePatterns) {
      for (const match of source.matchAll(regex)) {
        const direct = match[match.length - 1];
        const found = stripAndParse(direct);
        if (found) return found;
      }
    }

    const tokenBans = new Set([
      "NASDAQ", "NYSE", "AMEX", "BATS", "CBOE", "INDEX", "NYSEMKT", "ETF", "QUOTE",
      "CHART", "STOCK", "STOCKS", "FUTURE", "FUTURES", "OPTIONS", "MARKET", "HTTP",
      "HTTPS", "TRADING", "ROBINHOOD", "VIEW", "DASHBOARD", "BUILD", "OPEN", "PREVIEW"
    ]);
    const tokens = source.split(/[^A-Z0-9.^=-]+/).map((token) => token.trim()).filter(Boolean);
    for (const token of tokens) {
      const candidate = stripAndParse(token);
      if (!candidate) continue;
      if (tokenBans.has(candidate)) continue;
      return candidate;
    }
    return "";
  };
  const extractFromHostPattern = (url, patterns) => {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(url.pathname);
      if (!match) continue;
      const symbol = extractFromCandidate(match[1]);
      if (symbol) return symbol;
    }
    return "";
  };

  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); } catch { return ""; }
  if (!/^https?:$/i.test(url.protocol)) return "";

  const queryKeys = ["symbol", "ticker", "t", "instrument", "pair", "symbol_name", "pairId", "q", "s"];
  for (const key of queryKeys) {
    const found = extractFromCandidate(url.searchParams.get(key) || "");
    if (found) return found;
  }
  const host = (url.hostname || "").toLowerCase();
  if (host.includes("finance.yahoo.com")) {
    const hostSymbol = extractFromHostPattern(url, [{ regex: /^\/quote\/([^/?#]+)/i }]);
    if (hostSymbol) return hostSymbol;
  }
  if (host.includes("robinhood.com")) {
    const robinhood = extractFromHostPattern(url, [
      { regex: /^\/(?:[^/]+\/){0,6}(?:stocks|stock|options|option|etf|funds|futures|markets)\/([^/?#]+)/i },
      { regex: /^\/(?:[^/]+\/){0,6}(?:watchlists?|lists?)\/([^/?#]+)/i }
    ]);
    if (robinhood) return robinhood;
  }
  if (host.includes("tradingview.com")) {
    const tvPatterns = [
      /^\/.*\/symbols\/([^/?#]+)/i,
      /^\/symbols\/([^/?#]+)/i
    ];
    for (const regex of tvPatterns) {
      const match = regex.exec(url.pathname);
      if (!match) continue;
      const rawMatch = (() => {
        try { return decodeURIComponent(String(match[1] || "")); } catch { return String(match[1] || ""); }
      })();
      const symbolFromMatch = rawMatch.split("/")[0].split("?")[0].split("#")[0];
      const symbolWithoutExchange = symbolFromMatch.includes("-")
        ? symbolFromMatch.replace(/^[^-]+\-/i, "")
        : symbolFromMatch;
      const candidate = normalizeCandidate(symbolWithoutExchange);
      if (isLikelyTicker(candidate)) return candidate;
    }
  }
  if (host.includes("nasdaq.com")) {
    const nasdaq = extractFromHostPattern(url, [
      { regex: /^\/market-activity\/stocks\/([^/?#]+)/i },
      { regex: /^\/market-activity\/etf\/([^/?#]+)/i }
    ]);
    if (nasdaq) return nasdaq;
  }
  if (host.endsWith("localhost") || host.includes("localhost") || host === "127.0.0.1" || host === "::1") {
    const segments = url.pathname.split("/").map((segment) => segment.trim()).filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const found = extractFromCandidate(segments[i]);
      if (found) return found;
    }
  }

  const simplePaths = [
    { regex: /\/quote\/([^/?#]+)/i },
    { regex: /^\/stocks?\/([^/?#]+)/i },
    { regex: /^\/trading\/([^/?#]+)/i },
    { regex: /^\/market-activity\/([^/?#]+)/i },
    { regex: /^\/watchlists?\/([^/?#]+)/i }
  ];
  return extractFromHostPattern(url, simplePaths) || extractFromTitleText(rawTitle);
}

function websiteInternalLinks(html, baseUrl, limit = 8) {
  let origin = "";
  let canonicalBase = "";
  try { const base = new URL(baseUrl); origin = base.origin; base.hash = ""; canonicalBase = base.toString(); } catch { return []; }
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl);
      url.hash = "";
      if (url.origin !== origin || !/^https?:$/.test(url.protocol)) continue;
      if (url.toString() === canonicalBase || /\/cdn-cgi\//i.test(url.pathname)) continue;
      if (/\.(?:pdf|zip|xml|json|jpe?g|png|gif|webp|svg|mp4|webm)(?:\?|$)/i.test(url.pathname)) continue;
      if (/\/(?:login|sign-in|signin|account|cart|checkout|privacy|terms)(?:\/|$)/i.test(url.pathname)) continue;
      if (!links.includes(url.toString())) links.push(url.toString());
    } catch {}
    if (links.length >= limit) break;
  }
  return links;
}

async function fetchSmallDataUrl(url) {
  if (!url) return "";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "Boollm Ad Studio" } });
    const type = response.headers.get("content-type") || "";
    const size = Number(response.headers.get("content-length") || 0);
    if (!response.ok || !type.startsWith("image/") || type.includes("svg") || size > 3_000_000) return "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 2_000 || bytes.length > 3_000_000) return "";
    return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
  } catch { return ""; }
}

function edgeExecutable() {
  if (process.platform !== "win32") return "";
  const roots = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

async function captureWebsitePageDataUrl(url, width = 1280, height = 720) {
  const edge = edgeExecutable();
  if (!edge) return "";
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-studio-"));
  const output = path.join(folder, "page.png");
  try {
    await new Promise(resolve => {
      const child = spawn(edge, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
        `--window-size=${width},${height}`, `--screenshot=${output}`, String(url)
      ], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.once("error", () => { clearTimeout(timer); resolve(); });
    });
    if (!fs.existsSync(output)) return "";
    const bytes = fs.readFileSync(output);
    if (bytes.length < 2_000 || bytes.length > 8_000_000) return "";
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch { return ""; }
  finally { try { fs.rmSync(folder, { recursive: true, force: true }); } catch {} }
}

function loadAsset(name, devPath) {
  if (sea.isSea && sea.isSea()) {
    return Buffer.from(sea.getAsset(name));
  }
  const normalized = devPath.replace(/\\/g, "/");
  if (normalized.startsWith("../assets/")) {
    return fs.readFileSync(appPath("assets", path.basename(devPath)));
  }
  return fs.readFileSync(appPath("src", path.basename(devPath)));
}

const IS_SEA = !!(sea.isSea && sea.isSea());
const officialEducationById = new Map((officialEducationCatalog.exams || []).map((exam) => [exam.id, exam]));
const officialEducationPdfCache = new Map();
// Stand-in that ui.html ships with; the server swaps it for the launch token.
const SESSION_TOKEN_PLACEHOLDER = "__SAZ_SESSION_TOKEN__";
// Stand-in for the src/ui/ bundle (build/build-ui-logic.mjs). ui.html is one
// huge inline script, so browser logic that wants a real unit test lives in
// src/ui/ as an ES module and is inlined here on the way out.
const UI_LOGIC_PLACEHOLDER = "/*__BOOLLM_UI_LOGIC__*/";
const loadUiLogic = () => {
  if (IS_SEA) return loadAsset("ui-logic.js", "./assets/ui-logic.js").toString("utf8");
  return fs.readFileSync(appPath("src", "assets", "ui-logic.js"), "utf8");
};
let devUiCache = { mtimeMs: -1, html: "" };
let uiGzipCache = { html: "", gzip: null };
const loadUiHtml = () => {
  if (IS_SEA) return loadAsset("ui.html", "./ui.html").toString("utf8");
  const file = appPath("src", "ui.html");
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (devUiCache.mtimeMs !== mtimeMs) {
    devUiCache = { mtimeMs, html: fs.readFileSync(file, "utf8") };
  }
  return devUiCache.html;
};
function compressedUiHtml(html) {
  if (uiGzipCache.html !== html || !uiGzipCache.gzip) {
    uiGzipCache = { html, gzip: gzipSync(Buffer.from(html, "utf8"), { level: 6 }) };
  }
  return uiGzipCache.gzip;
}
// Monaco bundle for the Code workspace (see editor-assets.js).
function serveEditorAsset(urlPath, req, res) {
  const asset = resolveEditorAsset(urlPath);
  let stat = null;
  try {
    stat = asset ? fs.statSync(asset.file) : null;
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) { res.writeHead(404); res.end("not found"); return; }
  // Rebuilding the bundle keeps the same file names, so the browser must
  // revalidate rather than serve a stale editor for an hour.
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    res.end();
    return;
  }
  const body = fs.readFileSync(asset.file);
  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": body.length,
    "cache-control": "no-cache",
    etag
  });
  res.end(body);
}

function loadLegalText(file) {
  if (IS_SEA) return fs.readFileSync(path.join(path.dirname(process.execPath), file), "utf8");
  return fs.readFileSync(appPath("assets", file), "utf8");
}

const ABOUT_RELEASES = [
  {
    version: "0.9.71",
    date: "2026-08-03",
    title: "Trading workspace, model routing, and verified changes",
    details: [
      "Adds a compact trading bar that follows the active built-in browser symbol, shows live market and broker state, and keeps live orders behind explicit consent and safety gates.",
      "Routes eligible coding tasks through connected models, Codex, or Claude with verification, clearer worker labels, and project-aware fallback rules.",
      "Improves local and cloud switching, saved connection behavior, fresh-chat navigation, browser resizing, and exact on-disk change verification."
    ]
  },
  {
    version: "0.9.68",
    date: "2026-08-01",
    title: "Reliable Codex and Claude Code engines",
    details: [
      "Adds guided Claude Code installation and sign-in with Sonnet, Opus, and Haiku orchestration beside Boollm and Codex.",
      "Maps Read only, Read & write, and Full access to native coding-engine permissions and preserves the selected project boundary.",
      "Verifies every claimed Codex or Claude file change against the exact path and diff on disk before it appears in Changes."
    ]
  },
  {
    version: "0.9.67",
    date: "2026-08-01",
    title: "Work that continues to a verified result",
    details: [
      "Keeps compatibility-model work moving when a response promises another inspection, edit, command, or verification step instead of stopping mid-task.",
      "Adds compact Codex-style activity summaries plus a guided Codex CLI install and ChatGPT sign-in flow.",
      "Treats current write and deploy approval as authoritative while preserving exact-command, workspace-root, and live-verification safety checks."
    ]
  },
  {
    version: "0.9.65",
    date: "2026-08-01",
    title: "Reliable access and deploy approval",
    details: [
      "Added clear Read only, Read & write, and Full access choices beside the composer.",
      "Made the current request authoritative so stale read-only or no-deploy chat text cannot block a newly approved deployment.",
      "Kept workspace-root safety while allowing an exact approved command to run once without repeated prompts."
    ]
  },
  {
    version: "0.9.54",
    date: "2026-07-24",
    title: "Responsive workspace and personal surfaces",
    details: [
      "Refined the native split workspace so Projects, Chat, Notepad, and Browser resize and hide cleanly across compact and maximized windows.",
      "Added Paper Minimal, Soft Glass, and Graphite Mist surface styles with consistent light and dark panel colors.",
      "Simplified Boollm identity, connection marks, composer controls, and service branding across Settings, About, Gmail, and Outlook."
    ]
  },
  {
    version: "0.9.49",
    date: "2026-07-23",
    title: "Reliable task continuation",
    details: [
      "Recognizes natural continuation requests such as start please, yes start building it, begin building, and next step without dropping the saved task.",
      "Removed an incomplete local relay path that could not safely or reliably provide the paired remote-control experience.",
      "Documented the secure Cloudflare relay, outbound desktop connection, device pairing, and end-to-end encryption required for future phone control."
    ]
  },
  {
    version: "0.9.48",
    date: "2026-07-23",
    title: "Reliable layouts, connections, and task progress",
    details: [
      "Kept Recipes and Email actions visible with bounded, independently scrolling columns and a pinned action row.",
      "Preserved saved API, MCP, agent, Gmail, and Outlook connection records during ordinary app updates and partial settings saves.",
      "Made coding checklists hide noisy live output by default, kept manually hidden ClearFix output closed, and respected Windows snapped layouts when opening Browser or Notepad."
    ]
  },
  {
    version: "0.9.45",
    date: "2026-07-23",
    title: "Task progress and workspace reliability",
    details: [
      "Added a persistent coding-task checklist with live planning, working, and verification states.",
      "Improved native window layout, browser split sizing, and readiness status colors."
    ]
  },
  {
    version: "0.9.44",
    date: "2026-07-22",
    title: "Smarter context and compact UI",
    details: [
      "Added context usage controls and automatic summaries for longer conversations.",
      "Refined Settings spacing, Side chat scaling, and narrow-window behavior."
    ]
  },
  {
    version: "0.9.42",
    date: "2026-07-21",
    title: "Browser, email, and workflow polish",
    details: [
      "Improved embedded-browser controls and responsive workspace layouts.",
      "Expanded email recipes and safer connected-account workflows."
    ]
  }
];

function gitText(args) {
  try {
    const result = spawnSync("git", args, {
      cwd: appPath(),
      encoding: "utf8",
      timeout: 1800,
      windowsHide: true
    });
    if (result.status !== 0) return "";
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function aboutPayload() {
  const branch = gitText(["branch", "--show-current"]);
  const lines = gitText([
    "log", "-6", "--date=short",
    "--pretty=format:%h%x09%ad%x09%s"
  ]).split(/\r?\n/).filter(Boolean);
  const recentCommits = lines.map((line) => {
    const [hash = "", date = "", ...subjectParts] = line.split("\t");
    return { hash, date, subject: subjectParts.join("\t") };
  }).filter((entry) => entry.hash && entry.subject);
  const latest = recentCommits[0] || null;
  return {
    appName: APP_NAME,
    version: APP_VERSION,
    displayVersion: APP_DISPLAY_VERSION,
    channel: "Stable",
    repository: "https://github.com/syfy10/Boollm",
    branch: branch || "release",
    sourceAvailable: !!branch,
    commit: latest,
    recentCommits,
    releases: ABOUT_RELEASES
  };
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

async function readRawBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
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
      const err = new Error("Your Boollm account session expired. Sign in again to continue.");
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

export function serverUserInstructionText(content) {
  return currentTurnInstructionText(textOf(content));
}

function userTextOnly(content) {
  return serverUserInstructionText(content);
}

const PROJECT_WRITE_ACTION = /\b(?:deploy|publish|push|release|commit|install|uninstall|delete|remove|rename|move|migrate|scaffold|format)\b/i;

export function needsProjectWriteElevation({ accessMode = "ask", kind = "chat", projectDir = "", messages = [], forceTurnMode = "", forceNoArtifact = false } = {}) {
  if (String(accessMode).toLowerCase() !== "read_only") return false;
  if (kind !== "project" || !String(projectDir || "").trim()) return false;
  if (forceTurnMode === "chat" || forceNoArtifact === true) return false;
  const source = Array.isArray(messages) ? messages : [];
  if (requiresArtifactAction(source)) return true;
  const latestUser = [...source].reverse().find((message) => message?.role === "user");
  const latest = serverUserInstructionText(latestUser?.content || "");
  return PROJECT_WRITE_ACTION.test(latest)
    && classifyTurnMode(source, { latestText: latest, projectDir }) === "action";
}

export function oneTurnProjectWriteConfig(config = {}) {
  return { ...config, accessMode: "ask", autoApprove: false };
}

const LOCAL_PREVIEW_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>]*)?/gi;

export function requestsLocalPreview(text = "") {
  const value = String(text || "").toLowerCase();
  return /\b(?:preview|local site|local server|dev server|localhost)\b/.test(value)
    || (/\b(?:open|show|launch|run)\b/.test(value) && /\b(?:browser|project|app|site|website|game)\b/.test(value));
}

export function localPreviewUrls(...values) {
  const urls = [];
  const seen = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(LOCAL_PREVIEW_URL_RE)) {
      let candidate = match[0].replace(/[),.;!?]+$/g, "");
      try {
        const parsed = new URL(candidate);
        if (parsed.hostname === "0.0.0.0") parsed.hostname = "127.0.0.1";
        candidate = parsed.toString();
      } catch { continue; }
      if (!seen.has(candidate)) { seen.add(candidate); urls.push(candidate); }
    }
  }
  return urls;
}

export async function firstReachableLocalPreview(values = [], { timeoutMs = 2500 } = {}) {
  for (const url of localPreviewUrls(...values)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (response.status >= 200 && response.status < 400 && contentType.includes("text/html")) return url;
    } catch {}
    finally { clearTimeout(timer); }
  }
  return "";
}

const BOOLLM_PREVIEW_HANDOFF = "Boollm owns the built-in browser. Start the requested project or subproject from the directory that actually contains its existing launcher (for example saz.project.json, package.json, or serve.js); inspect and reuse that launcher before inventing another server. Verify the exact localhost page returns HTTP 2xx/3xx HTML rather than a blank page or error such as 404. If verification fails, use the command output and response to correct the directory, command, port, or project, then verify again; do not use ChatGPT, Codex, Claude, MCP, or plugin browser controls. Include only the verified localhost URL in your final answer; Boollm will open it in its own browser.";

export function withBoollmPreviewHandoff(messages = []) {
  const copy = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  const index = copy.findLastIndex((message) => message?.role === "user");
  if (index < 0) return copy;
  const content = copy[index].content;
  if (Array.isArray(content)) copy[index].content = [...content, { type: "text", text: `\n\n<boolean_preview_handoff>\n${BOOLLM_PREVIEW_HANDOFF}\n</boolean_preview_handoff>` }];
  else copy[index].content = `${String(content || "")}\n\n<boolean_preview_handoff>\n${BOOLLM_PREVIEW_HANDOFF}\n</boolean_preview_handoff>`;
  return copy;
}

function codexThreadIds(threads = []) {
  const ids = new Set();
  for (const thread of threads) {
    for (const value of [thread?.codex?.threadId, thread?.codexActive?.threadId]) {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Boollm and Codex keep separate conversation histories. Any Boollm-side
 * rewind must detach the public app-server thread mapping so the next turn is
 * bootstrapped from the newly truncated Boollm transcript instead of
 * appending to stale Codex context.
 */
export function clearCodexThreadMapping(thread) {
  if (!thread || typeof thread !== "object") return [];
  const ids = codexThreadIds([thread]);
  delete thread.codex;
  delete thread.codexActive;
  delete thread.claudeCode;
  const isMappedCodexOrchestration = (orchestration) => {
    const id = String(orchestration?.thread?.id || "").trim();
    return !!id && ids.includes(id);
  };
  if (isMappedCodexOrchestration(thread.orchestration)) thread.orchestration = null;
  if (isMappedCodexOrchestration(thread.pendingTask?.orchestration)) thread.pendingTask.orchestration = null;
  return ids;
}

/**
 * A task can outlive its streaming worker when an external coding CLI exits,
 * its HTTP client disconnects, or the shell replaces the backend. Never leave
 * that persisted checkpoint claiming to be live when no AbortController owns
 * the turn anymore.
 */
export function interruptOrphanedPendingTask(thread, { now = Date.now(), graceMs = 15000 } = {}) {
  const task = thread?.pendingTask;
  if (!task || !["running", "interrupted"].includes(task.state)) return false;
  const orphaned = task.state === "running" && !thread.abort && now - Number(task.updatedAt || 0) >= graceMs;
  const splitBrain = task.state === "interrupted" && task.controller?.taskRun && !["completed", "failed", "paused"].includes(task.controller.taskRun.state);
  if (!orphaned && !splitBrain) return false;
  if (orphaned) { task.state = "interrupted"; task.updatedAt = now; }
  const controller = task.controller;
  if (controller && typeof controller === "object") {
    if (!["completed", "failed"].includes(controller.phase)) controller.phase = "paused";
    controller.updatedAt = now;
    const run = controller.taskRun;
    if (run && typeof run === "object" && !["completed", "failed", "paused"].includes(run.state)) {
      run.state = "paused";
      run.updatedAt = now;
      run.sequence = Math.max(0, Number(run.sequence) || 0) + 1;
      run.events = [...(Array.isArray(run.events) ? run.events : []), {
        id: crypto.randomUUID(), sequence: run.sequence, type: "run.paused", status: "waiting",
        title: "Task interrupted", detail: "The coding worker stopped responding. Continue the task to resume from this checkpoint.", at: now, details: {}
      }].slice(-160);
    }
    if (controller.compaction && typeof controller.compaction === "object") controller.compaction.state = "paused";
  }
  thread.updatedAt = Math.max(Number(thread.updatedAt) || 0, now);
  return true;
}

/** Describe the result without implying that Boollm owns Codex's storage. */
export function codexHistoryDisposition(threadIds = [], archivedThreadIds = []) {
  const linked = [...new Set((threadIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const archived = [...new Set((archivedThreadIds || []).map((id) => String(id || "").trim()).filter((id) => linked.includes(id)))];
  const archiveNote = archived.length
    ? `Boollm also archived ${archived.length} linked Codex task${archived.length === 1 ? "" : "s"}. `
    : "";
  return {
    managedBy: "codex",
    linkedThreads: linked.length,
    archivedThreads: archived.length,
    retainedExternally: linked.length > 0,
    notice: linked.length
      ? `Boollm deleted its local chat copy. ${archiveNote}Codex manages its task history separately and it may remain until removed from Codex.`
      : "Boollm deleted its local chat history. No linked Codex task history was found."
  };
}

export function codexOrchestrationSnapshot({ threadId = "", turnId = "", items = [], status = "in_progress" } = {}) {
  const normalized = ["completed", "failed", "interrupted"].includes(status) ? status : "in_progress";
  return {
    thread: { id: String(threadId || ""), status: normalized },
    turn: {
      id: String(turnId || ""),
      status: normalized,
      items: Array.isArray(items) ? items.slice(-8) : []
    }
  };
}

export function shortThreadTitle(content) {
  const text = userTextOnly(content);
  const site = text.match(/\bcompany\s+website\s*:\s*(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)(?:\.[a-z0-9.-]+)?/i);
  if (site?.[1]) return `${cap(site[1])} prospect plan`;
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
  if (/\b(email|reply|respond|outlook|gmail)\b/.test(low)) {
    if (/\b(clean|cleanup|trash|inbox)\b/.test(low)) return "Email cleanup";
    if (/\b(summarize|summary|briefing)\b/.test(low)) return "Email summary";
    const topic = firstTopic(clean.replace(/\b(email|emails|e-mail|draft|write|compose|reply|respond|message|outlook|gmail|send|create)\b/gi, ""), 4);
    return topic ? ("Email " + topic).slice(0, 42) : "Email draft";
  }
  if (/\bnotepad|notes?\b/.test(low)) return "Notepad";
  if (/\bsnip|screenshot|ocr|vision\b/.test(low)) return "Screen OCR";
  if (/\bsettings?\b/.test(low)) return "Settings";
  if (/\bbrowser\b/.test(low)) {
    const topic = firstTopic(clean.replace(/\b(browser|use|open|current|page|context|boolean|summarize|research)\b/gi, ""), 4);
    return topic || "Web research";
  }
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
  if (!["Notepad", "Browser"].includes(t?.title)) return false;
  const next = shortThreadTitle(firstUserContent(t)).slice(0, 42);
  if (!next || next === "New chat" || next === t.title) return false;
  t.title = next;
  return true;
}

function adminCloudVaultEnabled(config) {
  const cloud = config.cloudBackend || {};
  const user = cloud.user || {};
  return !!cloud.sessionToken && (user.role === "admin" || user.is_admin === true);
}

function launchGithubGuide(action, projectDir) {
  const intro = "$Host.UI.RawUI.WindowTitle='Boollm GitHub setup'; Write-Host 'Boollm GitHub setup' -ForegroundColor Green;";
  let script;
  if (action === "install") {
    script = `${intro} Write-Host 'Installing the official GitHub CLI...'; winget install --id GitHub.cli --exact --accept-source-agreements --accept-package-agreements; if ($LASTEXITCODE -eq 0) { Write-Host 'GitHub CLI installed. Return to Boollm and press Connect GitHub.' -ForegroundColor Green } else { Write-Host 'Installation did not finish. You can retry from Boollm.' -ForegroundColor Red }; Read-Host 'Press Enter to close'`;
  } else if (action === "connect") {
    script = `${intro} Write-Host 'A secure GitHub sign-in page will open. Follow the browser instructions.'; gh auth login --hostname github.com --git-protocol https --web; if ($LASTEXITCODE -eq 0) { Write-Host 'GitHub connected. You can return to Boollm.' -ForegroundColor Green } else { Write-Host 'GitHub sign-in did not finish. You can retry from Boollm.' -ForegroundColor Red }; Start-Sleep -Seconds 4`;
  } else if (action === "disconnect") {
    script = `${intro} gh auth logout --hostname github.com; Write-Host 'Return to Boollm when finished.'; Start-Sleep -Seconds 3`;
  } else if (action === "switch") {
    script = `${intro} Write-Host 'Choose the current account to sign out, then sign in to the other account.'; gh auth logout --hostname github.com; gh auth login --hostname github.com --git-protocol https --web; Write-Host 'Return to Boollm when finished.'; Start-Sleep -Seconds 4`;
  } else throw new Error("Unsupported GitHub setup action.");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: projectDir, detached: true, stdio: "ignore", windowsHide: false
  });
  child.unref();
}

function githubSetupCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed.`).trim());
  return String(result.stdout || "").trim();
}

function ensureGitRepository(cwd) {
  const existing = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true, encoding: "utf8" });
  if (existing.status !== 0) githubSetupCommand("git", ["init"], cwd);
}

async function writeCloudVault(config, revision, retry = true) {
  const payload = cloudVaultSnapshot(config);
  try {
    const result = await cloudRequest(config, "/vault", {
      method: "PUT",
      body: JSON.stringify({ payload, revision: Number(revision || 0) })
    });
    return { ...result, ...cloudVaultSummary(payload) };
  } catch (err) {
    if (retry && err.status === 409) return writeCloudVault(config, Number(err.data?.revision || 0), false);
    throw err;
  }
}

async function syncCloudVault(config, { merge = true } = {}) {
  if (!adminCloudVaultEnabled(config)) {
    const err = new Error("Encrypted cloud vault is available to signed-in admin accounts.");
    err.status = 403;
    throw err;
  }
  const remote = await cloudRequest(config, "/vault", { method: "GET" });
  if (merge && remote.payload && typeof remote.payload === "object") {
    const result = mergeCloudVault(config, remote.payload);
    if (result.changed) saveConfig(config, { preserveSecrets: false, preserveConnections: false });
  }
  return writeCloudVault(config, Number(remote.revision || 0));
}

export function repairGenericWorkflowTitle(t, allThreads = []) {
  const title = String(t?.title || "").trim();
  if (!/^(?:(?:build\s+)?prepare sourced prospect(?: plan)?|email draft)(?: \d+)?$/i.test(title)) return false;
  const next = uniqueThreadTitle(shortThreadTitle(firstUserContent(t)), t, allThreads);
  if (!next || next === "New chat" || next === t.title) return false;
  t.title = next;
  return true;
}

function uniqueThreadTitle(title, t, allThreads) {
  const base = String(title || "").trim().slice(0, 42);
  if (!base) return base;
  const used = new Set([...allThreads]
    .filter((other) => other && other !== t)
    .map((other) => String(other.title || "").trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let number = 2; number < 100; number += 1) {
    const suffix = ` ${number}`;
    const candidate = base.slice(0, 42 - suffix.length).trimEnd() + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function shouldAutoTitleThread(t) {
  const title = String(t?.title || "").trim();
  return !title || ["New chat", "Side chat", "New project", "Untitled project", "Project"].includes(title);
}

function autoTitleThread(t, content, allThreads = []) {
  if (!t || !shouldAutoTitleThread(t)) return false;
  const next = uniqueThreadTitle(shortThreadTitle(content), t, allThreads);
  if (!next || next === "New chat") return false;
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

function publicConnectors(config, managedEmailOAuthClients = {}) {
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
      tools: Array.isArray(x.tools) ? x.tools.slice(0, 20) : [],
      lastTestedAt: Number(x.lastTestedAt || 0),
      lastTestStatus: x.lastTestStatus || "",
      lastError: x.lastError || "",
      needsReconnect: x.needsReconnect === true
    })) : [],
    agents: Array.isArray(c.agents) ? c.agents.map((x) => ({
      id: x.id, name: x.name, url: x.url, enabled: x.enabled !== false, hasKey: !!x.apiKey
    })) : [],
    email: publicEmailConnections(config, managedEmailOAuthClients),
    cloudflare: {
      connected: c.cloudflare?.connected === true,
      hasToken: !!c.cloudflare?.token,
      fullAccess: c.cloudflare?.fullAccess === true,
      authType: c.cloudflare?.authType || (c.cloudflare?.oauth ? "oauth" : (c.cloudflare?.token ? "token" : "")),
      oauthClientId: c.cloudflare?.oauthClientId || "",
      oauthRedirectUri: c.cloudflare?.oauthRedirectUri || "https://boollm.com/oauth/cloudflare/callback",
      oauthScopes: Array.isArray(c.cloudflare?.oauthScopes) ? c.cloudflare.oauthScopes : [],
      accountId: c.cloudflare?.accountId || "",
      accountName: c.cloudflare?.accountName || "",
      tokenId: c.cloudflare?.tokenId || "",
      status: c.cloudflare?.status || "",
      expiresOn: c.cloudflare?.expiresOn || "",
      lastTestedAt: Number(c.cloudflare?.lastTestedAt || 0)
    },
    azure: {
      connected: c.azure?.connected === true,
      hasSecret: !!c.azure?.clientSecret,
      tenantId: c.azure?.tenantId || "",
      clientId: c.azure?.clientId || "",
      subscriptionId: c.azure?.subscriptionId || "",
      subscriptionName: c.azure?.subscriptionName || "",
      lastTestedAt: Number(c.azure?.lastTestedAt || 0)
    },
    aws: {
      connected: c.aws?.connected === true,
      hasSecret: !!c.aws?.secretAccessKey,
      hasSessionToken: !!c.aws?.sessionToken,
      accessKeyId: c.aws?.accessKeyId || "",
      region: c.aws?.region || "us-east-1",
      accountId: c.aws?.accountId || "",
      arn: c.aws?.arn || "",
      lastTestedAt: Number(c.aws?.lastTestedAt || 0)
    },
    googleCloud: {
      connected: c.googleCloud?.connected === true,
      hasKey: !!c.googleCloud?.serviceAccount,
      projectId: c.googleCloud?.projectId || "",
      projectName: c.googleCloud?.projectName || "",
      clientEmail: c.googleCloud?.clientEmail || "",
      lastTestedAt: Number(c.googleCloud?.lastTestedAt || 0)
    }
  };
}

function publicModelCapability(config, vision = null) {
  const provider = config.provider;
  const settings = config[provider] || {};
  return modelCapabilityProfile(config, {
    provider,
    model: settings.model || "",
    base: settings.baseUrl || ""
  }, { vision });
}

const modelCapabilityProbes = new Map();

async function probeCurrentModelCapability(config, { force = false } = {}) {
  const provider = config.provider;
  const settings = config[provider] || {};
  const selected = {
    provider,
    model: settings.model || "",
    base: settings.baseUrl || ""
  };
  const key = modelCapabilityKey(config, selected);
  const existing = nativeToolSupport(config, selected);
  if (!force && typeof existing === "boolean") {
    return { cached: true, ...publicModelCapability(config) };
  }
  if (modelCapabilityProbes.has(key)) return modelCapabilityProbes.get(key);
  const pending = (async () => {
    try {
      const target = await resolveTarget(config);
      const reply = await chatCompletion({
        ...target,
        noStream: true,
        maxRetries: 1
      }, [{
        role: "user",
        content: "Capability check only. Request the boolean_capability_probe function now. Do not answer in prose."
      }], [capabilityProbeTool()], AbortSignal.timeout(20000));
      const result = evaluateCapabilityProbeReply(reply);
      recordNativeToolSupport(config, selected, result.supported, result.reason);
      saveConfig(config);
      return { cached: false, ...publicModelCapability(config) };
    } catch (error) {
      if (capabilityProbeUnsupportedError(error)) {
        recordNativeToolSupport(config, selected, false, "The provider rejected native function tools.");
        saveConfig(config);
        return { cached: false, ...publicModelCapability(config) };
      }
      throw error;
    } finally {
      modelCapabilityProbes.delete(key);
    }
  })();
  modelCapabilityProbes.set(key, pending);
  return pending;
}

function adminFeatureAccessAllowed(config) {
  const cloud = config.cloudBackend || {};
  const user = cloud.user || {};
  return !!cloud.sessionToken && (user.role === "admin" || user.is_admin === true);
}

function marketAccessAllowed(config) {
  return adminFeatureAccessAllowed(config);
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

function activeProjectDir(threads, activeThreadId) {
  return threads.get(activeThreadId)?.projectDir || process.cwd();
}

function gitStatusSummary(projectDir) {
  const out = { branch: null, upstream: "", ahead: 0, behind: 0, state: "none", changedFiles: [] };
  if (!projectDir) return out;
  const gitResult = spawnSync("git", ["status", "--porcelain=v1", "-b"], { cwd: projectDir, encoding: "utf8", timeout: 4000 });
  if (gitResult.status !== 0) return out;
  const lines = String(gitResult.stdout || "").split("\n");
  const branchLine = lines.find((line) => line.startsWith("## ")) || "";
  const branchMatch = branchLine.match(/^##\s+(.+?)(?:\.\.\.([^\s\[]+))?(?:\s+\[(.+)\])?$/);
  if (branchMatch) {
    out.branch = branchMatch[1] || null;
    out.upstream = branchMatch[2] || "";
    const flags = branchMatch[3] || "";
    const ahead = flags.match(/ahead\s+(\d+)/);
    const behind = flags.match(/behind\s+(\d+)/);
    out.ahead = ahead ? Number(ahead[1]) : 0;
    out.behind = behind ? Number(behind[1]) : 0;
  }
  for (const line of lines) {
    if (!line || line.startsWith("##")) continue;
    const status = line.startsWith("?? ") ? "untracked" : line[0] === "A" || line[1] === "A" ? "added" : line[0] === "D" || line[1] === "D" ? "deleted" : "modified";
    const file = line.slice(3).trim();
    if (file) out.changedFiles.push({ path: file, status });
  }
  if (!out.branch) out.state = "none";
  else if (!out.upstream) out.state = "local";
  else if (out.behind) out.state = out.ahead ? "diverged" : "behind";
  else if (out.ahead) out.state = "unpushed";
  else out.state = "pushed";
  return out;
}

function gitDiffStat(projectDir, changedFiles = []) {
  const out = { files: 0, additions: 0, deletions: 0 };
  if (!projectDir) return out;
  const seen = new Set();
  const r = spawnSync("git", ["diff", "--numstat", "HEAD"], { cwd: projectDir, encoding: "utf8", timeout: 4000 });
  if (r.status !== 0) return out;
  for (const line of String(r.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const [add, del, file] = line.split(/\t/);
    out.files++;
    if (file) seen.add(file.trim());
    out.additions += /^\d+$/.test(add || "") ? Number(add) : 0;
    out.deletions += /^\d+$/.test(del || "") ? Number(del) : 0;
  }
  for (const row of changedFiles || []) {
    const file = String(row?.path || "").trim();
    if (row?.status !== "untracked" || !file || seen.has(file)) continue;
    seen.add(file);
    out.files++;
    try {
      const full = path.resolve(projectDir, file);
      const root = path.resolve(projectDir);
      if (!full.startsWith(root + path.sep)) continue;
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const text = fs.readFileSync(full, "utf8");
      out.additions += text ? text.split(/\r?\n/).length : 0;
    } catch {}
  }
  return out;
}

const PROJECT_STATUS_CACHE_TTL_MS = 2500;
const projectStatusCache = new Map();

function projectGitSnapshot(projectDir, { force = false } = {}) {
  if (!projectDir) return { git: gitStatusSummary(""), diffStat: { files: 0, additions: 0, deletions: 0 } };
  const key = path.resolve(projectDir).toLowerCase();
  const cached = projectStatusCache.get(key);
  if (!force && cached && Date.now() - cached.at < PROJECT_STATUS_CACHE_TTL_MS) return cached.value;
  const git = gitStatusSummary(projectDir);
  const value = { git, diffStat: gitDiffStat(projectDir, git.changedFiles) };
  projectStatusCache.set(key, { at: Date.now(), value });
  return value;
}

function invalidateProjectStatus(projectDir = "") {
  if (!projectDir) {
    projectStatusCache.clear();
    return;
  }
  projectStatusCache.delete(path.resolve(projectDir).toLowerCase());
}

function gitWorkspaceChanges(projectDir = "") {
  if (!projectDir) return [];
  const root = path.resolve(projectDir);
  try {
    const review = gitDiffFiles(root);
    return review.files.slice(0, 12).map((file) => {
      const relativePath = String(file?.path || "");
      const absolutePath = path.resolve(root, relativePath);
      const inside = absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`);
      const diff = (Array.isArray(file?.lines) ? file.lines : []).slice(0, 160).map((line) => {
        if (line?.type === "add") return `+${line.text || ""}`;
        if (line?.type === "del") return `-${line.text || ""}`;
        if (line?.type === "hunk") return String(line.text || "");
        return ` ${line?.text || ""}`;
      }).join("\n");
      return {
        path: relativePath,
        absolutePath: inside ? absolutePath : "",
        status: String(file?.status || "modified"),
        diff: diff.slice(0, 5000)
      };
    }).filter((file) => file.path && file.absolutePath);
  } catch { return []; }
}

export function booleanWorkspaceChanges(thread, fallbackProjectDir = "", threadCollection = null) {
  const projectDir = String(thread?.projectDir || fallbackProjectDir || "");
  if (!projectDir) return [];
  const projectKey = path.resolve(projectDir).toLowerCase();
  const relatedThreads = threadCollection && typeof threadCollection.values === "function"
    ? [...threadCollection.values()].filter((candidate) => {
      const candidateDir = String(candidate?.projectDir || (!candidate?.projectDir && candidate?.kind !== "project" ? fallbackProjectDir : ""));
      return candidateDir && path.resolve(candidateDir).toLowerCase() === projectKey;
    }).sort((a, b) => Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0))
    : [thread];
  let recorded = [];
  for (const candidate of relatedThreads) {
    recorded = mergeWorkspaceChanges(recorded, candidate?.workspaceChanges || [], projectDir);
  }
  const git = gitWorkspaceChanges(projectDir);
  return combineWorkspaceChanges(recorded, git, projectDir);
}

function runGit(projectDir, args, timeout = 10000) {
  const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", timeout });
  return { code: r.status ?? 1, stdout: String(r.stdout || "").trim(), stderr: String(r.stderr || "").trim() };
}

function undoLastPushedCommit(projectDir) {
  const summary = gitStatusSummary(projectDir);
  if (summary.state !== "pushed" || !summary.upstream) {
    return { ok: false, error: "Current branch is not exactly synced with an upstream remote." };
  }
  if (summary.changedFiles.length) {
    return { ok: false, error: "Working tree has local changes. Commit, stash, or discard them before undoing a pushed commit." };
  }
  const branch = runGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0 || !branch.stdout || branch.stdout === "HEAD") return { ok: false, error: "Could not identify the current branch." };
  const current = runGit(projectDir, ["rev-parse", "HEAD"]);
  const previous = runGit(projectDir, ["rev-parse", "HEAD~1"]);
  const upstream = runGit(projectDir, ["rev-parse", "@{u}"]);
  if (current.code !== 0 || previous.code !== 0 || upstream.code !== 0) {
    return { ok: false, error: "Could not inspect local/upstream commits." };
  }
  if (upstream.stdout !== current.stdout) {
    return { ok: false, error: "Remote moved since the last status check. Refresh before undoing push." };
  }
  const upstreamName = summary.upstream;
  const slash = upstreamName.indexOf("/");
  const remote = slash > 0 ? upstreamName.slice(0, slash) : "origin";
  const remoteBranch = slash > 0 ? upstreamName.slice(slash + 1) : branch.stdout;
  const remoteRef = `refs/heads/${remoteBranch}`;
  const push = runGit(projectDir, [
    "push",
    `--force-with-lease=${remoteRef}:${current.stdout}`,
    remote,
    `${previous.stdout}:${remoteRef}`
  ], 20000);
  if (push.code !== 0) return { ok: false, error: push.stderr || "git push --force-with-lease failed." };
  const reset = runGit(projectDir, ["reset", "--mixed", "HEAD~1"], 10000);
  if (reset.code !== 0) return { ok: false, error: reset.stderr || "Remote was moved back, but local reset failed." };
  return { ok: true, branch: branch.stdout, upstream: upstreamName, undoneCommit: current.stdout, resetTo: previous.stdout };
}

function mergeConnectors(current, incoming) {
  const prevApis = new Map((current?.apis || []).map((a) => [a.id, a]));
  const prevAgents = new Map((current?.agents || []).map((a) => [a.id, a]));
  const prevMcp = new Map((current?.mcp || []).map((m) => [m.id, m]));
  const next = {
    apis: Array.isArray(current?.apis) ? current.apis : [],
    mcp: Array.isArray(current?.mcp) ? current.mcp : [],
    agents: Array.isArray(current?.agents) ? current.agents : [],
    cloudflare: current?.cloudflare || {},
    email: current?.email || {}
  };
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
        enabled: x.enabled !== false,
        toolCount: x.toolCount ?? old?.toolCount,
        tools: Array.isArray(x.tools) ? x.tools : (old?.tools || []),
        lastTestedAt: x.lastTestedAt ?? old?.lastTestedAt,
        lastTestStatus: x.lastTestStatus ?? old?.lastTestStatus,
        lastError: x.lastError ?? old?.lastError,
        needsReconnect: x.needsReconnect ?? old?.needsReconnect
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
  if (name === "email_cleanup_preview") return `preview email cleanup`;
  if (name === "email_cleanup_trash") return `move reviewed email to Trash`;
  if (name === "email_cleanup_undo") return `undo email cleanup`;
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
  if (/gemini/.test(value) || provider === "google") return "Gemini";
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

function readSystemClipboardText() {
  if (process.platform !== "win32") return "";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "Clipboard read failed.").trim());
  return String(result.stdout || "").replace(/\r?\n$/, "");
}

export function startServer(config, {
  port = 0,
  autoExit = false,
  emailOAuthClients = null,
  // Secret the page must echo back on every state-changing call. A constant
  // would let any other process running as this user drive the agent — run
  // commands, read the project, send mail from a connected account. Random per
  // launch, handed to the UI only by templating it into the served HTML.
  sessionToken = crypto.randomBytes(24).toString("hex"),
  codexInstaller = installCodexStandaloneCli,
  codexPlatform = process.platform,
  codexClientFactory = createCodexAppServer,
  codexNow = Date.now,
  // The UI cancels after five minutes. Keep the backend lease longer so its
  // final status poll can still cancel the original app-server login by ID.
  codexLoginTtlMs = 10 * 60 * 1000,
  claudeInstaller = installClaudeCode,
  claudeStatusReader = readClaudeCodeStatus,
  claudeLoginStarter = startClaudeCodeLogin,
  claudeTurnRunner = runClaudeCodeTurn
} = {}) {
  const uiHtml = loadUiHtml();
  // The page learns this launch's token by being served with it baked in.
  // Cached against the source so dev reloads still pick up file edits.
  const sessionHtmlCache = { source: "", logic: "", html: "" };
  const uiHtmlForSession = () => {
    const source = IS_SEA ? uiHtml : loadUiHtml();
    const logic = loadUiLogic();
    if (sessionHtmlCache.source !== source || sessionHtmlCache.logic !== logic) {
      if (!source.includes(SESSION_TOKEN_PLACEHOLDER)) {
        throw new Error(`ui.html is missing ${SESSION_TOKEN_PLACEHOLDER}; every API call would be rejected.`);
      }
      if (!source.includes(UI_LOGIC_PLACEHOLDER)) {
        throw new Error(`ui.html is missing ${UI_LOGIC_PLACEHOLDER}; the src/ui/ bundle would never load.`);
      }
      sessionHtmlCache.source = source;
      sessionHtmlCache.logic = logic;
      sessionHtmlCache.html = source
        .replace(SESSION_TOKEN_PLACEHOLDER, sessionToken)
        // $-sequences are meaningful to String.replace; the bundle is code, not
        // a replacement pattern, so hand it over as a function.
        .replace(UI_LOGIC_PLACEHOLDER, () => logic);
    }
    return sessionHtmlCache.html;
  };
  const managedEmailOAuthClients = emailOAuthClients || loadManagedEmailOAuthClients();
  const icon32 = loadAsset("icon-32.png", "../assets/saz-32.png");
  const icon256 = loadAsset("icon-256.png", "../assets/saz-256.png");
  let favicon;
  try { favicon = loadAsset("saz.ico", "../assets/saz.ico"); } catch { favicon = icon32; }

  const pendingApprovals = new Map(); // id -> resolve(boolean)
  const pendingCodexInputs = new Map(); // id -> { resolve, threadId, questions, isBlocking }
  const pendingMcpOAuth = new Map(); // state -> short-lived OAuth transaction
  const pendingEmailOAuth = new Map(); // state -> short-lived mailbox OAuth transaction
  const pendingCloudflareOAuth = new Map(); // state -> short-lived Cloudflare PKCE transaction
  const pendingBrowserControls = new Map(); // id -> resolve(result)
  const pendingNotepadControls = new Map(); // id -> resolve(result)
  let browserUrl = ""; // the page currently open in the in-app browser
  let browserTitle = ""; // optional page title sent with the current browser URL
  let browserSnapshot = null; // last live page read pushed by the desktop shell UI
  let browseBase = ""; // origin of the isolated browser-proxy server (set on listen)
  let serverPort = 0;  // this app's own port, hidden from local-server discovery

  // Why a scheduled monitor has no page to look at. A prompt-type task has no
  // tools, so the snapshot is its only eyes; when it is missing the task must
  // be told plainly, because a model asked to "read the visible page" with no
  // page attached will otherwise report numbers it invented.
  const browserSnapshotGap = () => {
    if (!browserSnapshot) return "no page has been read from Boollm's built-in browser yet";
    const ageSeconds = Math.round(Math.max(0, Date.now() - Number(browserSnapshot.at || 0)) / 1000);
    if (ageSeconds > 120) return `the last page read is ${ageSeconds} seconds old (stale beyond the 120-second limit)`;
    return "";
  };

  const browserSnapshotText = () => {
    if (!browserSnapshot) return "";
    const ageMs = Math.max(0, Date.now() - Number(browserSnapshot.at || 0));
    if (ageMs > 120000) return "";
    const domText = String(browserSnapshot.text || "").trim();
    const ocrText = String(browserSnapshot.ocr || "").trim();
    const pageText = [domText, ocrText && ocrText !== domText ? `Rendered-page OCR:\n${ocrText}` : ""]
      .filter(Boolean)
      .join("\n\n");
    return [
      "CURRENT VISIBLE BROWSER SNAPSHOT (live from Boollm's built-in browser):",
      `URL: ${browserSnapshot.url || "(none)"}`,
      `Title: ${browserSnapshot.title || "(none)"}`,
      `Page status: ${browserSnapshot.open === false ? "closed" : "open"}`,
      pageText ? `Visible page text:\n${pageText}` : "Visible page text: (no readable text)"
    ].join("\n");
  };

  // ── broker snapshot for the trading bar ──────────────────────────
  // Which account the agent would actually act on, whether that account is
  // agent-tradable at all, and its buying power. An account with
  // agentic_allowed=false silently rejects every order, so the bar has to be able
  // to say so BEFORE a trade is attempted. Cached: these are slow MCP round-trips
  // and the bar polls.
  let brokerSnapshot = { at: 0, payload: null, inFlight: null, connector: "" };
  const BROKER_SNAPSHOT_TTL = 30_000;

  const BROKER_CONNECTOR_HINTS = [
    { id: "robinhood", label: "Robinhood", aliases: ["robinhood", "robinhoodlegend", "rh"], hosts: ["robinhood.com"] },
    { id: "schwab", label: "Schwab", aliases: ["schwab", "fidelityschwab", "charlesschwab"], hosts: ["schwab.com"] },
    { id: "alpaca", label: "Alpaca", aliases: ["alpaca"], hosts: ["alpaca.markets"] },
    { id: "ibkr", label: "IBKR", aliases: ["ibkr", "interactivebrokers", "ibkr"], hosts: ["interactivebrokers.com"] },
    { id: "tradier", label: "Tradier", aliases: ["tradier"], hosts: ["tradier.com"] },
    { id: "trade", label: "Broker", aliases: ["trading", "broker"], hosts: [] }
  ];

  const normalizeTradingAdapterId = (value = "") => String(value || "")
    .toLowerCase()
    .replace(/(^https?:\/\/|\/.*$)/g, "")
    .replace(/[^\w]/g, "");

  const normalizeTradingHost = (value = "") => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return normalizeTradingAdapterId(new URL(raw).hostname || "");
    } catch {
      return normalizeTradingAdapterId(raw);
    }
  };

  const tradingAdapterForConnector = (connector = {}) => {
    const candidates = [
      normalizeTradingAdapterId(connector?.id),
      normalizeTradingAdapterId(connector?.name),
      normalizeTradingHost(connector?.url),
      normalizeTradingAdapterId(connector?.url)
    ].filter(Boolean);
    const flat = candidates.join(" ");
    for (const hint of BROKER_CONNECTOR_HINTS) {
      const aliases = new Set((hint.aliases || []).map((value) => normalizeTradingAdapterId(value)));
      const hosts = new Set((hint.hosts || []).map((value) => normalizeTradingAdapterId(value)));
      if (candidates.some((candidate) => aliases.has(candidate) || hosts.has(candidate))) return hint.id;
      if (flat.includes(hint.id)) return hint.id;
    }
    return "";
  };

  const tradingConnectorMatchesConnector = (connector, requestedAdapter = "", fallbackName = "") => {
    const requested = normalizeTradingAdapterId(requestedAdapter);
    const fallback = normalizeTradingAdapterId(fallbackName);
    if (!requested && !fallback) return false;
    const normalized = [
      normalizeTradingAdapterId(connector?.id),
      normalizeTradingAdapterId(connector?.name),
      normalizeTradingHost(connector?.url),
      normalizeTradingAdapterId(connector?.url),
      tradingAdapterForConnector(connector)
    ].filter(Boolean);
    return normalized.some((candidate) => candidate === requested || candidate === fallback);
  };

  const tradingAdapterCatalog = (nextConfig = config) => {
    const list = Array.isArray(nextConfig?.connectors?.mcp) ? nextConfig.connectors.mcp : [];
    const enabled = list.filter((item) => item && item.enabled !== false && item.url);
    return enabled.map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.id || ""),
      url: String(item.url || ""),
      adapter: tradingAdapterForConnector(item),
      label: BROKER_CONNECTOR_HINTS.find((hint) => hint.id === tradingAdapterForConnector(item))?.label || ""
    }));
  };

  const tradingAdapterSummary = (nextConfig = config) => (
    tradingAdapterCatalog(nextConfig).map((item) => item.adapter || item.name || item.id).filter(Boolean)
  );

  const maskAccount = (value = "") => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.length <= 4 ? raw : `••••${raw.slice(-4)}`;
  };

  const brokerConnector = (nextConfig = config, requestedConnector = "") => {
    const list = Array.isArray(nextConfig?.connectors?.mcp) ? nextConfig.connectors.mcp : [];
    const enabled = list.filter((item) => item && item.enabled !== false && item.url);
    const requested = normalizeTradingAdapterId(requestedConnector);
    if (requested) {
      const direct = enabled.find((item) => tradingConnectorMatchesConnector(item, requested, ""));
      if (direct) return direct;
    }
    const configured = String(nextConfig?.connectors?.trading?.broker
      || nextConfig?.connectors?.trading?.pnl?.connector || "").trim();
    if (configured) {
      const configuredMatch = enabled.find((item) => tradingConnectorMatchesConnector(
        item,
        configured,
        String(nextConfig?.connectors?.trading?.pnl?.connector || "")
      ));
      if (configuredMatch) return configuredMatch;
    }
    const pnlConnector = String(nextConfig?.connectors?.trading?.pnl?.connector || "").trim();
    if (pnlConnector) {
      const pnlMatch = enabled.find((item) => tradingConnectorMatchesConnector(item, pnlConnector, ""));
      if (pnlMatch) return pnlMatch;
    }
    const robinhood = enabled.find((item) => tradingAdapterForConnector(item) === "robinhood");
    if (robinhood) return robinhood;
    const brokerHint = enabled.find((item) => BROKER_CONNECTOR_HINTS.some((hint) => tradingAdapterForConnector(item) === hint.id));
    if (brokerHint) return brokerHint;
    return enabled.find((item) => /robinhood|broker|trading|schwab|alpaca|ibkr|tradier/i
      .test(`${item.name || ""} ${item.url || ""}`)) || null;
  };

  function mcpStructured(result) {
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find?.((part) => part?.type === "text")?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function loadBrokerSnapshot(nextConfig = config, requestedConnector = "") {
    const connector = brokerConnector(nextConfig, requestedConnector);
    if (!connector) return { ok: false, error: "No broker connector is configured." };
    const accountsResult = await mcpCallTool(connector, "get_accounts", {});
    const accounts = mcpStructured(accountsResult)?.data?.accounts;
    if (!Array.isArray(accounts) || !accounts.length) {
      return { ok: false, connector: connector.name || connector.id, error: "The broker returned no accounts." };
    }
    const active = accounts.find((a) => a.is_default) || accounts[0];
    const agentic = accounts.find((a) => a.agentic_allowed === true) || null;

    let buyingPower = null;
    let accountValue = null;
    try {
      // get_portfolio requires the account it should report on.
      const portfolio = mcpStructured(await mcpCallTool(connector, "get_portfolio",
        { account_number: String(active.account_number || "") }))?.data;
      const raw = Number(portfolio?.buying_power?.buying_power);
      if (Number.isFinite(raw)) buyingPower = Math.round(raw * 100) / 100;
      const total = Number(portfolio?.total_value);
      if (Number.isFinite(total)) accountValue = Math.round(total * 100) / 100;
    } catch { /* balances are a bonus; the account identity is the point */ }

    return {
      ok: true,
      connector: connector.name || connector.id,
      // Never send full account numbers to the UI — it only ever displays them.
      account: {
        masked: maskAccount(active.account_number),
        type: String(active.brokerage_account_type || active.type || ""),
        nickname: String(active.nickname || ""),
        agenticAllowed: active.agentic_allowed === true
      },
      agenticAccount: agentic && agentic !== active
        ? { masked: maskAccount(agentic.account_number), nickname: String(agentic.nickname || "") }
        : null,
      anyAgentic: accounts.some((a) => a.agentic_allowed === true),
      buyingPower,
      accountValue
    };
  }

  async function brokerSnapshotCached({
    refresh = false,
    connector: requestedConnector = ""
  } = {}) {
    const connectorKey = normalizeTradingAdapterId(requestedConnector || config?.connectors?.trading?.broker || config?.connectors?.trading?.pnl?.connector || "");
    const fresh = !refresh && brokerSnapshot.payload && brokerSnapshot.connector === connectorKey
      && Date.now() - brokerSnapshot.at < BROKER_SNAPSHOT_TTL;
    if (fresh) return brokerSnapshot.payload;
    if (brokerSnapshot.inFlight) return brokerSnapshot.inFlight;
    brokerSnapshot.inFlight = (async () => {
      try {
        const payload = await loadBrokerSnapshot(config, requestedConnector);
        brokerSnapshot = { at: Date.now(), payload, inFlight: null, connector: connectorKey };
        return payload;
      } catch (err) {
        const payload = { ok: false, error: String(err?.message || err).slice(0, 200) };
        brokerSnapshot = { at: Date.now(), payload, inFlight: null, connector: connectorKey };
        return payload;
      }
    })();
    return brokerSnapshot.inFlight;
  }
  let codexClient = null;
  let codexRunner = null;
  let codexClientCommand = "";
  let codexAccount = null;
  let codexModels = [];
  let codexCheckedAt = 0;
  let codexInstallPromise = null;
  let codexLoginId = "";
  let codexLoginStartedAt = 0;
  let codexLoginStarting = false;
  let codexLoginCompletedWhileStarting = "";
  let codexLoginGeneration = 0;
  let claudeInstallPromise = null;
  let claudeCheckedAt = 0;
  let claudeStatus = null;
  const codexLoginLeaseMs = Math.max(1000, Number(codexLoginTtlMs) || 10 * 60 * 1000);
  // Keep npx/Wrangler scratch writes in a small Boollm-owned temp subtree.
  // The same environment is passed to the app-server and its sandbox policy.
  const codexProcessEnvironment = codexToolEnvironment(process.env);

  const clearCodexLogin = () => {
    codexLoginGeneration++;
    codexLoginId = "";
    codexLoginStartedAt = 0;
    codexLoginStarting = false;
    codexLoginCompletedWhileStarting = "";
  };
  const codexLoginPending = () => {
    if ((codexLoginStarting || codexLoginId)
      && Number(codexNow()) - codexLoginStartedAt >= codexLoginLeaseMs) {
      clearCodexLogin();
    }
    return codexLoginStarting || !!codexLoginId;
  };
  const activeCodexLoginId = () => {
    codexLoginPending();
    return codexLoginId;
  };

  const validCodexAuthUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 2048) return "";
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
      if (hostname !== "chatgpt.com" && !hostname.endsWith(".chatgpt.com")) return "";
      const normalized = parsed.toString();
      return normalized.length <= 2048 ? normalized : "";
    } catch { return ""; }
  };

  const codexCommand = () => String(process.env.CODEX_EXECUTABLE || config.codex?.command || "codex").trim() || "codex";
  const codexErrorMessage = (error) => {
    const raw = String(error?.message || error || "Codex app-server is unavailable.");
    if (/access is denied|eperm|eacces/i.test(raw)) {
      return "Windows blocked that Codex executable. Install the public Codex CLI, or choose its executable in Settings. The Microsoft Store desktop bundle cannot be launched as a CLI by Boollm.";
    }
    if (/enoent|not recognized|cannot find|could not start/i.test(raw)) {
      return "Codex CLI was not found. Use Set up Codex in Settings to install the official standalone CLI.";
    }
    return raw;
  };
  const publicCodexModels = (result) => {
    const rows = Array.isArray(result) ? result : (result?.data || result?.models || []);
    return rows.slice(0, 200).map((row) => ({
      id: String(row?.id || row?.model || row?.slug || "").slice(0, 200),
      name: String(row?.displayName || row?.name || row?.id || row?.model || "").slice(0, 200),
      description: String(row?.description || "").slice(0, 500),
      default: row?.isDefault === true || row?.default === true,
      reasoningEfforts: (Array.isArray(row?.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [])
        .map((effort) => String(effort?.reasoningEffort || effort?.effort || effort || ""))
        .filter(Boolean)
    })).filter((row) => row.id);
  };
  const publicCodexAccount = (result) => {
    const account = result?.account || result || null;
    if (!account || typeof account !== "object") return null;
    return {
      signedIn: !!(account.email || account.type || account.planType || account.accountId || result?.requiresOpenaiAuth === false),
      email: String(account.email || "").slice(0, 320),
      type: String(account.type || account.authMode || "").slice(0, 80),
      plan: String(account.planType || account.plan || "").slice(0, 80)
    };
  };
  const publicCodexStatus = () => ({
    enabled: config.codex?.enabled === true,
    command: config.codex?.command || "codex",
    model: config.codex?.model || "",
    reasoningEffort: config.codex?.reasoningEffort || "medium",
    installing: !!codexInstallPromise,
    loginPending: codexLoginPending(),
    ...(codexClient?.getStatus?.() || { state: "stopped", running: false, ready: false, lastError: "" }),
    lastError: codexClient?.getStatus?.().lastError ? codexErrorMessage(codexClient.getStatus().lastError) : "",
    account: codexAccount,
    models: codexModels,
    checkedAt: codexCheckedAt
  });
  const claudeCommand = () => String(process.env.CLAUDE_CODE_EXECUTABLE || config.claudeCode?.command || "claude").trim() || "claude";
  const refreshClaudeStatus = ({ force = false } = {}) => {
    if (!force && claudeStatus && Date.now() - claudeCheckedAt < 5000) return claudeStatus;
    claudeStatus = claudeStatusReader(claudeCommand());
    claudeCheckedAt = Date.now();
    return claudeStatus;
  };
  const publicClaudeStatus = ({ refresh = false } = {}) => {
    const status = refreshClaudeStatus({ force: refresh });
    return {
      enabled: config.codingEngine === "claude-code" || config.claudeCode?.enabled === true,
      command: config.claudeCode?.command || "claude",
      model: config.claudeCode?.model || "sonnet",
      installing: !!claudeInstallPromise,
      ...status,
      ready: status.ready === true && status.signedIn === true,
      checkedAt: claudeCheckedAt
    };
  };
  const publicCodexInputs = () => [...pendingCodexInputs.entries()].map(([id, entry]) => ({
    id,
    threadId: String(entry?.threadId || ""),
    questions: Array.isArray(entry?.questions) ? entry.questions : [],
    isBlocking: entry?.isBlocking !== false
  }));
  const publicCodexApprovals = () => [...pendingApprovals.entries()]
    .map(([id, resolve]) => resolve?.codexEvent ? ({ id, ...resolve.codexEvent }) : null)
    .filter(Boolean);
  const stopCodexClient = async () => {
    const current = codexClient;
    codexClient = null;
    codexRunner = null;
    codexClientCommand = "";
    clearCodexLogin();
    if (current) await current.stop().catch(() => {});
  };
  const ensureCodexClient = async ({ refresh = false } = {}) => {
    const command = codexCommand();
    if (codexClient && codexClientCommand !== command) await stopCodexClient();
    if (!codexClient) {
      codexClientCommand = command;
      codexClient = codexClientFactory({
        command,
        args: ["app-server", "--stdio"],
        env: codexProcessEnvironment,
        clientInfo: { name: "boolean", title: "Boollm", version: APP_VERSION },
        capabilities: { experimentalApi: true },
        onStatus: () => { codexCheckedAt = Date.now(); },
        onEvent: (message) => {
          if (message?.method === "account/login/completed") {
            const completedId = String(message?.params?.loginId || "");
            if (codexLoginStarting && !codexLoginId) {
              codexLoginCompletedWhileStarting = completedId || "*";
            } else if (!completedId || !codexLoginId || completedId === codexLoginId) {
              clearCodexLogin();
            }
            codexCheckedAt = 0;
          }
          if (message?.method === "account/updated") {
            if (codexLoginStarting && !codexLoginId) codexLoginCompletedWhileStarting = "*";
            else clearCodexLogin();
            codexAccount = publicCodexAccount(message.params);
            codexCheckedAt = Date.now();
          }
        }
      });
    }
    await codexClient.start();
    if (refresh || !codexCheckedAt || !codexAccount || !codexModels.length) {
      const [account, models] = await Promise.allSettled([
        codexClient.accountRead({ refreshToken: refresh }),
        codexClient.modelList({ limit: 200 })
      ]);
      // A rejected refresh must not leave a revoked account or stale model list
      // looking healthy in Settings. The app-server can be running while its
      // authentication is no longer valid.
      codexAccount = account.status === "fulfilled" ? publicCodexAccount(account.value) : null;
      codexModels = models.status === "fulfilled" ? publicCodexModels(models.value) : [];
      codexCheckedAt = Date.now();
    }
    return codexClient;
  };
  const ensureCodexRunner = async () => {
    const client = await ensureCodexClient();
    if (!codexRunner) codexRunner = createCodexRunner({ client });
    return codexRunner;
  };
  const archiveLinkedCodexThreads = async (threadIds = []) => {
    const linked = [...new Set(threadIds.map((id) => String(id || "").trim()).filter(Boolean))];
    const archived = [];
    // Deleting a Boollm chat must remain reliable even when Codex is not
    // running. If the public app-server is already available, archive its
    // linked task; either way the response explicitly says Codex retains and
    // manages its own history.
    if (linked.length && codexClient?.getStatus?.().ready) {
      await Promise.all(linked.map(async (threadId) => {
        try {
          await codexClient.request("thread/archive", { threadId }, { timeoutMs: 2500 });
          archived.push(threadId);
        } catch { /* disclose retained history in the response below */ }
      }));
    }
    return codexHistoryDisposition(linked, archived);
  };

  // Entry page for the built-in browser. Kept deliberately small and dependency
  // free: local servers first (the thing you almost always want), then links.
  const browserStartPage = (servers, { explore = false, bookmarks = [] } = {}) => {
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    // With "Explore as browser home" on, every new tab leads with the three
    // Explore surfaces. They are app UI, not web pages, so the cards ask the
    // shell (which owns both this pane and the chat WebView) to open them.
    const exploreCards = [
      ["markets", "Market", "Quotes, movers, screeners and research"],
      ["education", "Education", "Practice exams and study sessions"],
      ["sales", "Sales", "Research a company and build an outreach plan"]
    ].map(([id, label, desc]) => `<button class="exp" data-surface="${id}">
          <span class="nm">${label}</span>
          <span class="ds">${desc}</span>
          <span class="go">▷</span>
        </button>`).join("");
    const exploreBlock = explore
      ? `<h1>Explore</h1><div class="list">${exploreCards}</div>`
      : "";
    const exploreScript = explore
      ? `<script>
document.querySelectorAll(".exp").forEach(function(b){
  b.addEventListener("click",function(){
    try{ window.chrome.webview.postMessage({type:"exploreSurface",surface:b.dataset.surface}); }
    catch(e){ b.classList.add("off"); }
  });
});
</script>`
      : "";
    const cards = servers.length
      ? servers.map((s) => `<a class="srv" href="${esc(s.url)}">
          <span class="ico">▤</span>
          <span class="nm">${esc(s.name)}</span>
          <span class="pt">:${esc(s.port)}</span>
          <span class="go">▷</span>
        </a>`).join("")
      : `<p class="none">No local servers are running right now. Start one and reopen this page.</p>`;
    const links = [
      ["https://www.google.com", "Google"],
      ["https://github.com", "GitHub"],
      ["https://stackoverflow.com", "Stack Overflow"],
      ["https://developer.mozilla.org", "MDN"]
    ].map(([u, l]) => `<a class="lnk" href="${u}">${l}</a>`).join("");
    const saved = bookmarks
      .filter((b) => b && typeof b.url === "string" && /^https?:\/\//i.test(b.url))
      .slice(0, 24)
      .map((b) => `<a class="lnk" href="${esc(b.url)}" title="${esc(b.url)}">${esc(b.title || b.url)}</a>`)
      .join("");
    const savedBlock = saved ? `<h1>Bookmarks</h1><div class="links">${saved}</div>` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><title>New tab</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
  font:14px/1.5 "Segoe UI",system-ui,sans-serif;background:#fafaf9;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#e8e8e8}}
h1{margin:0;font-size:15px;font-weight:600;opacity:.55;letter-spacing:.02em}
.list{display:flex;flex-direction:column;gap:8px;width:min(460px,88vw)}
.srv{display:flex;align-items:center;gap:12px;padding:13px 15px;border:1px solid #e2e2df;border-radius:11px;
  background:#fff;color:inherit;text-decoration:none;transition:border-color .15s,transform .08s}
.srv:hover{border-color:#9a9a95}
.srv:active{transform:translateY(1px)}
@media(prefers-color-scheme:dark){.srv{background:#242424;border-color:#3a3a3a}.srv:hover{border-color:#5a5a5a}}
.ico{opacity:.5}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pt{opacity:.5;font-variant-numeric:tabular-nums}
.go{display:grid;place-items:center;width:26px;height:26px;border:1px solid #e2e2df;border-radius:7px;opacity:.75}
@media(prefers-color-scheme:dark){.go{border-color:#3a3a3a}}
.none{opacity:.55;text-align:center;margin:0}
.links{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.lnk{padding:6px 13px;border:1px solid #e2e2df;border-radius:999px;color:inherit;text-decoration:none;font-size:13px;opacity:.8}
.lnk:hover{opacity:1}
@media(prefers-color-scheme:dark){.lnk{border-color:#3a3a3a}}
.exp{display:flex;align-items:center;gap:12px;width:100%;padding:13px 15px;border:1px solid #e2e2df;border-radius:11px;
  background:#fff;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,transform .08s}
.exp:hover{border-color:#9a9a95}
.exp:active{transform:translateY(1px)}
.exp .ds{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55}
.exp.off{opacity:.5;cursor:default}
@media(prefers-color-scheme:dark){.exp{background:#242424;border-color:#3a3a3a}.exp:hover{border-color:#5a5a5a}}
</style></head><body>
${exploreBlock}
<h1>Running locally</h1>
<div class="list">${cards}</div>
${savedBlock}
<div class="links">${links}</div>
${exploreScript}
</body></html>`;
  };

  // The browser CHROME (tab strip, nav row, address bar, task row, overflow menu
  // and window controls) rendered as HTML so it can match every app theme and
  // stay clean. It talks to the C# shell over WebView2 postMessage; the shell
  // drives the real page rendering. Deliberately self-contained (no assets).
  const browserChromePage = () => `<!doctype html><html><head><meta charset="utf-8"><title>chrome</title><style>
  :root{
    --bg:#fafafa; --sidebar:#ffffff; --text:#1a1a1a; --dim:#8a8a8a; --border:#ececea;
    --hover:#f3f3f1; --card:#ffffff; --accent:#2d2d2d; --online:#e86f16;
    --radius:12px; --radius-sm:8px; --radius-pill:999px;
    --ui:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
    --shadow-sm:0 1px 2px rgba(0,0,0,.06);
  }
  @media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){
    --bg:#181818; --sidebar:#1d1d1d; --text:#ececec; --dim:#8f8f8f; --border:#2a2a2a;
    --hover:#242424; --card:#202020; --accent:#ececec; --online:#fb923c;
    --shadow-sm:0 1px 2px rgba(0,0,0,.3); } }
  :root[data-theme="dark"]{
    --bg:#181818; --sidebar:#1d1d1d; --text:#ececec; --dim:#8f8f8f; --border:#2a2a2a;
    --hover:#242424; --card:#202020; --accent:#ececec; --online:#fb923c;
    --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  }
  :root[data-visual-theme="light"][data-color-theme="classic"]{ --bg:#f5f5f3; --sidebar:#fbfbfa; --card:#fff; --border:#e9e9e6; }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:transparent}
  body{color:var(--text);font:12.5px/1 var(--ui);
    -webkit-user-select:none;user-select:none;cursor:default}
  button{font:inherit;color:inherit;border:0;background:transparent;cursor:default}
  .bar{display:flex;flex-direction:column;height:116px;background:var(--bg)}
  .row{display:flex;align-items:center;gap:2px;padding:0 6px}
  .r-tabs{height:40px;padding-left:8px;padding-right:0}
  .r-nav{height:42px;gap:3px}
  .r-tasks{height:34px;gap:4px;overflow:hidden;border-top:1px solid color-mix(in srgb,var(--border) 60%,transparent)}
  .ico{display:grid;place-items:center;min-width:30px;height:30px;padding:0 6px;border-radius:9px;
    color:var(--text);font-size:14px;line-height:1;transition:background .12s}
  .ico:hover{background:var(--hover)}
  .ico.on{background:color-mix(in srgb,var(--online) 14%,var(--card));color:var(--online)}
  .ico:disabled{opacity:.32}
  .ico:disabled:hover{background:transparent}
  /* tabs */
  .tabs{display:flex;align-items:center;gap:3px;flex:0 1 auto;min-width:0;overflow:hidden}
  .tab{display:flex;align-items:center;gap:7px;flex:0 1 auto;min-width:64px;width:180px;max-width:200px;height:30px;
    padding:0 6px 0 11px;border-radius:9px;color:var(--dim);border:1px solid transparent}
  .tab:hover{background:var(--hover)}
  .tab.on{background:var(--card);color:var(--text);border-color:var(--border);box-shadow:var(--shadow-sm)}
  .tab .dot{width:7px;height:7px;border-radius:50%;background:var(--dim);flex:none;opacity:.7}
  .tab.on .dot{background:var(--online);opacity:1}
  .tab .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
  .tab .x{display:grid;place-items:center;width:18px;height:18px;border-radius:6px;font-size:13px;color:var(--dim);flex:none;opacity:0}
  .tab:hover .x,.tab.on .x{opacity:1}
  .tab .x:hover{background:color-mix(in srgb,var(--text) 12%,transparent);color:var(--text)}
  .add{min-width:28px;flex:none;font-size:16px}
  .drag{flex:1;align-self:stretch;min-width:8px}
  .wc{display:flex;align-items:center;gap:1px;flex:none;padding-left:4px}
  .wc .ico{min-width:34px;height:32px;border-radius:0;font-size:10px;
    font-family:"Segoe Fluent Icons","Segoe MDL2 Assets",var(--ui)}
  .wc .close:hover{background:#e81123;color:#fff}
  /* address */
  .addr{flex:1;min-width:60px;display:flex;align-items:center;height:30px;margin:0 4px;
    background:var(--card);border:1px solid var(--border);border-radius:var(--radius-pill);
    padding:0 4px 0 12px;transition:border-color .12s}
  .addr:focus-within{border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
  .addr input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);
    font:12.5px var(--ui);-webkit-user-select:text;user-select:text}
  .addr .clr{width:22px;height:22px;border-radius:50%;color:var(--dim);font-size:14px;display:none;place-items:center}
  .addr .clr:hover{background:var(--hover)}
  /* tasks */
  .task{height:26px;padding:0 11px;border-radius:9px;color:var(--dim);font-size:11.5px;white-space:nowrap;flex:none}
  .task:hover{background:var(--hover);color:var(--text)}
  /* menu */
  .menu{position:fixed;top:78px;right:8px;min-width:224px;max-height:calc(100vh - 86px);overflow-y:auto;
    scrollbar-color:var(--dim) transparent;background:var(--sidebar);
    border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.22);
    padding:6px;z-index:50;display:none}
  .menu.open{display:block}
  .mi{display:flex;align-items:center;height:30px;padding:0 10px;border-radius:8px;
    width:100%;text-align:left;color:var(--text);font-size:12.5px}
  .mi:hover{background:var(--hover)}
  .sep{height:1px;margin:5px 6px;background:var(--border)}
  /* bookmarks list inside the overflow menu */
  .bms{max-height:210px;overflow-y:auto;scrollbar-color:var(--dim) transparent}
  .bms:empty{display:none}
  .bm{display:flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border-radius:8px;color:var(--text)}
  .bm:hover{background:var(--hover)}
  .bm .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;text-align:left}
  .bm .x{display:grid;place-items:center;width:18px;height:18px;border-radius:6px;font-size:13px;color:var(--dim);flex:none;opacity:0}
  .bm:hover .x{opacity:1}
  .bm .x:hover{background:color-mix(in srgb,var(--text) 12%,transparent);color:var(--text)}
  .bmnone{padding:4px 10px 6px;color:var(--dim);font-size:11.5px}
  .devw{display:none;align-items:center;height:26px;padding:0 8px;border-radius:7px;background:var(--card);
    color:var(--dim);font:11px/1 ui-monospace,Consolas,monospace;white-space:nowrap}
  .devw.on{display:flex}
  .zoom{display:flex;align-items:center;gap:6px;padding:2px 10px;height:32px}
  .zoom span{flex:1;color:var(--dim)}
  .zoom b{min-width:44px;text-align:center;font-weight:600}
  .zoom button{width:24px;height:24px;border-radius:7px;font-size:14px}
  .zoom button:hover{background:var(--hover)}
  </style></head><body>
  <div class="bar">
    <div class="row r-tabs">
      <div class="tabs" id="tabs"></div>
      <button class="ico add" id="add" title="New tab">+</button>
      <div class="drag" id="drag"></div>
      <button class="ico" id="full" title="Hide chat (focus browser)">&#x2922;</button>
      <div class="wc">
        <button class="ico" data-w="min" title="Minimize">&#xE921;</button>
        <button class="ico" id="wmax" data-w="maxtoggle" title="Maximize">&#xE922;</button>
        <button class="ico close" id="browserClose" title="Close browser panel" aria-label="Close browser panel">&#xE8BB;</button>
      </div>
    </div>
    <div class="row r-nav">
      <button class="ico" id="back" title="Back">&#x2190;</button>
      <button class="ico" id="fwd" title="Forward">&#x2192;</button>
      <button class="ico" id="reload" title="Reload">&#x21BB;</button>
      <button class="ico" id="device" title="Responsive view: Desktop / Tablet / Mobile. Then drag the preview's right edge to any width.">&#x25A3;</button>
      <span class="devw" id="devw" title="Preview width — drag the preview's right edge to change it"></span>
      <button class="ico" id="run" title="Run current project">&#x25B6;</button>
      <button class="ico" id="darkPage" title="Dark mode for websites" aria-pressed="false">&#x263E;</button>
      <button class="ico" id="star" title="Bookmark this page" aria-pressed="false">&#x2606;</button>
      <div class="addr">
        <input id="url" placeholder="Search or enter a URL" spellcheck="false" autocomplete="off">
        <button class="clr" id="clr" title="Clear">&times;</button>
      </div>
      <button class="ico" id="menu" title="Menu">&#x22EE;</button>
    </div>
    <div class="row r-tasks" id="tasks"></div>
  </div>
  <div class="menu" id="dd">
    <button class="mi" data-a="newTab">New tab</button>
    <button class="mi" data-a="closeTab">Close current tab</button>
    <button class="mi" data-a="closeOthers">Close other tabs</button>
    <div class="sep"></div>
    <button class="mi" data-a="bookmark">Bookmark this page</button>
    <div class="bms" id="bms"></div>
    <div class="sep"></div>
    <button class="mi" data-a="sendPageAI">Send page to AI</button>
    <button class="mi" data-a="sendSelMsg">Send selection to message</button>
    <button class="mi" data-a="sendSelNote">Send selection to notepad</button>
    <button class="mi" data-a="sendShotAI">Send screenshot to AI</button>
    <button class="mi" data-a="sendShotNote">Send screenshot to notepad</button>
    <div class="sep"></div>
    <div class="zoom"><span>Zoom</span><button data-a="zoomOut">&minus;</button><b id="zpct">100%</b><button data-a="zoomIn">+</button></div>
    <button class="mi" data-a="autofit">Auto fit to window</button>
    <div class="sep"></div>
    <button class="mi" data-a="clear">Clear browsing data</button>
    <div class="sep"></div>
    <button class="mi" data-a="openSystem">Open in system browser</button>
    <button class="mi" data-a="hideChat">Hide chat (focus browser)</button>
    <button class="mi" data-a="hideBrowser">Hide browser panel</button>
  </div>
  <script>
  (function(){
    var vs = window.chrome && window.chrome.webview;
    var $ = function(id){ return document.getElementById(id); };
    function send(o){ try{ vs.postMessage(o); }catch(e){} }
    function act(a, extra){ send(Object.assign({type:"chrome",a:a}, extra||{})); }
    function win(action){ send({type:"window",action:action}); }
    var dev = { desktop:"\\u25A3", tablet:"\\u25AD", mobile:"\\u25AF" };

    // static wiring
    $("back").onclick   = function(){ act("back"); };
    $("fwd").onclick    = function(){ act("fwd"); };
    $("reload").onclick = function(){ act("reload"); };
    $("device").onclick = function(){ act("device"); };
    $("run").onclick    = function(){ act("run"); };
    $("darkPage").onclick = function(){ act("darkPage"); };
    $("star").onclick   = function(){ act("bookmark"); };
    $("add").onclick    = function(){ act("newTab"); };
    $("full").onclick   = function(){ act("hideChat"); };
    $("browserClose").onclick = function(){ act("hideBrowser"); };
    document.querySelectorAll(".wc [data-w]").forEach(function(b){
      b.onclick = function(){ win(b.dataset.w); };
    });
    // drag empty regions; double-click toggles maximize
    ["drag"].forEach(function(id){
      var el = $(id);
      el.addEventListener("mousedown", function(e){ if(e.button===0) win("drag"); });
      el.addEventListener("dblclick", function(){ win("maxtoggle"); });
    });

    // address bar
    var url = $("url"), clr = $("clr");
    url.addEventListener("keydown", function(e){
      if(e.key==="Enter"){ e.preventDefault(); act("go",{url:url.value}); url.blur(); }
    });
    url.addEventListener("input", function(){ clr.style.display = url.value ? "grid" : "none"; });
    clr.onclick = function(){ url.value=""; clr.style.display="none"; url.focus(); };

    // overflow menu
    var dd = $("dd"), open=false;
    function setMenu(v){
      open=v;
      dd.classList.toggle("open", v);
      act("menuLayout",{open:v});
    }
    $("menu").onclick = function(e){ e.stopPropagation(); setMenu(!open); };
    document.addEventListener("click", function(){ if(open) setMenu(false); });
    document.addEventListener("keydown", function(e){ if(e.key==="Escape"&&open){ e.preventDefault(); setMenu(false); $("menu").focus(); } });
    dd.addEventListener("click", function(e){ e.stopPropagation(); });
    dd.querySelectorAll("[data-a]").forEach(function(b){
      b.onclick = function(){ var a=b.dataset.a; act(a); if(a!=="zoomIn"&&a!=="zoomOut") setMenu(false); };
    });

    var urlFocused=false;
    url.addEventListener("focus", function(){ urlFocused=true; });
    url.addEventListener("blur", function(){ urlFocused=false; });

    function renderTabs(tabs){
      var host = $("tabs"); host.innerHTML="";
      (tabs||[]).forEach(function(t){
        var el = document.createElement("div");
        el.className = "tab" + (t.active ? " on" : "");
        el.title = t.title || "New tab";
        var dot = document.createElement("span"); dot.className="dot"; el.appendChild(dot);
        var lbl = document.createElement("span"); lbl.className="t"; lbl.textContent = t.title || "New tab"; el.appendChild(lbl);
        var x = document.createElement("span"); x.className="x"; x.innerHTML="&times;"; el.appendChild(x);
        el.addEventListener("mousedown", function(e){
          if(e.button===1){ e.preventDefault(); act("closeTab",{id:t.id}); }
        });
        el.addEventListener("click", function(e){ if(e.target===x){ act("closeTab",{id:t.id}); } else { act("selTab",{id:t.id}); } });
        host.appendChild(el);
      });
    }
    function renderTasks(list){
      var host = $("tasks"); host.innerHTML="";
      (list||[]).forEach(function(s){
        var b = document.createElement("button");
        b.className="task"; b.textContent=s.text; b.title=s.tip;
        b.onclick = function(){ act("task",{task:s.task}); };
        host.appendChild(b);
      });
    }
    // Saved pages, newest first. Opening one takes a new tab; the × removes it
    // without closing the menu, so several can be cleaned up in one pass.
    function renderBookmarks(list){
      var host = $("bms"); host.innerHTML="";
      if(!list || !list.length){
        var none = document.createElement("div");
        none.className="bmnone"; none.textContent="No bookmarks yet";
        host.appendChild(none);
        return;
      }
      list.forEach(function(b){
        var row = document.createElement("div");
        row.className="bm"; row.title=b.url;
        var t = document.createElement("span"); t.className="t"; t.textContent=b.title||b.url; row.appendChild(t);
        var x = document.createElement("span"); x.className="x"; x.innerHTML="&times;"; x.title="Remove bookmark"; row.appendChild(x);
        row.addEventListener("click", function(e){
          if(e.target===x){ e.stopPropagation(); act("bookmarkRemove",{url:b.url}); return; }
          act("bookmarkOpen",{url:b.url});
          setMenu(false);
        });
        host.appendChild(row);
      });
    }
    function applyTheme(dark, surface){
      var r = document.documentElement;
      r.style.colorScheme = dark ? "dark" : "light";
      if(dark){ r.setAttribute("data-theme","dark"); r.removeAttribute("data-visual-theme"); r.removeAttribute("data-color-theme"); }
      else { r.setAttribute("data-theme","light"); r.setAttribute("data-visual-theme","light"); r.setAttribute("data-color-theme","classic"); }
    }
    function render(s){
      if(!s || s.type!=="state") return;
      applyTheme(s.dark, s.surface);
      renderTabs(s.tabs);
      renderTasks(s.tasks);
      if(!urlFocused){ url.value = s.url||""; clr.style.display = url.value ? "grid" : "none"; }
      $("back").disabled = !s.canBack;
      $("fwd").disabled = !s.canFwd;
      $("device").innerHTML = dev[s.device] || dev.desktop;
      $("device").classList.toggle("on", (s.deviceWidth||0) > 0);
      var devw = $("devw");
      devw.textContent = s.deviceLabel || "";
      devw.classList.toggle("on", !!s.deviceLabel);
      $("darkPage").classList.toggle("on", !!s.darkPage);
      $("darkPage").setAttribute("aria-pressed", s.darkPage ? "true" : "false");
      $("darkPage").title = s.darkPage ? "Turn off website dark mode" : "Dark mode for websites";
      renderBookmarks(s.bookmarks);
      var star = $("star");
      star.innerHTML = s.bookmarked ? "\\u2605" : "\\u2606";
      star.classList.toggle("on", !!s.bookmarked);
      star.setAttribute("aria-pressed", s.bookmarked ? "true" : "false");
      star.title = s.bookmarked ? "Remove bookmark" : "Bookmark this page";
      star.disabled = !s.url;
      var bmItem = dd.querySelector('[data-a="bookmark"]');
      if(bmItem) bmItem.textContent = s.bookmarked ? "Remove bookmark" : "Bookmark this page";
      $("zpct").textContent = (s.zoom||100) + "%";
      var wm = $("wmax"); wm.innerHTML = s.maxed ? "\\uE923" : "\\uE922"; wm.title = s.maxed ? "Restore" : "Maximize";
    }
    if(vs) vs.addEventListener("message", function(e){
      if(e.data && e.data.type==="dismissMenu"){ setMenu(false); return; }
      render(e.data);
    });
    act("ready");
  })();
  </script>
  </body></html>`;

  // ── thread store ───────────────────────────────────────────────
  const threads = new Map(); // id -> { id, title, messages, createdAt, updatedAt, abort }
  function newThread({ kind = "chat", title = "New chat", projectDir = "", parentProjectId = "", side = false } = {}) {
    const id = crypto.randomUUID();
    const workDir = kind === "project" && projectDir ? projectDir : config.projectsDir;
    const t = {
      id, title, kind, projectDir, parentProjectId, side: side === true,
      messages: [{ role: "system", content: systemPrompt(workDir, config.autoApprove, config) }],
      log: [], // display entries: {t:'user'|'ai'|'tool', ...}
      createdAt: Date.now(), updatedAt: Date.now(), abort: null, pendingTask: null, memoryDigest: null,
      workspaceChanges: []
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
  function turnModeForPendingTask(messages, latestText) {
    const prospective = Array.isArray(messages) ? messages : [];
    return classifyTurnMode(prospective, {
      latestText,
      artifactActionRequired: requiresArtifactAction(prospective),
      connectorActionRequired: requiresConnectorContinuationAction(prospective)
    });
  }
  function shouldTrackPendingTask(t, messages, latestText) {
    const mode = turnModeForPendingTask(messages, latestText);
    return mode === "connector" || (mode === "action" && t?.kind === "project" && !!t?.projectDir);
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
  function resumeTaskMessage(task, latestUserText = "", { refinement = false } = {}) {
    const userText = String(latestUserText || "").trim();
    if (userText) return userText;
    const loopPaused = /\b(?:loop guard|tool budget reached|repeated the same kind of inspection)\b/i
      .test(String(task?.controller?.lastFailure || ""));
    return loopPaused
      ? "Continue the saved task with a new strategy. Use the evidence already collected. Do not repeat broad searches, folder listings, or file reads; make the next targeted progress action, or report the specific blocker."
      : "Continue the saved task from its checkpoint.";
  }
  function resetLoopRecoveryState(task) {
    const controller = task?.controller;
    if (!controller || !/\b(?:loop guard|tool budget reached|repeated the same kind of inspection)\b/i.test(String(controller.lastFailure || ""))) return false;
    controller.nonProgressCount = 0;
    controller.actionCounts = {};
    controller.blockedToolCount = 0;
    controller.blockedActionCounts = {};
    controller.consecutiveFailures = 0;
    controller.lastFailure = "";
    controller.phase = "executing";
    controller.updatedAt = Date.now();
    return true;
  }
  function isBlankNewThread(t) {
    if (!t || t.kind === "project" || t.pinned) return false;
    if (!["New chat", "Side chat"].includes(t.title || "")) return false;
    if (Array.isArray(t.log) && t.log.length) return false;
    const messages = Array.isArray(t.messages) ? t.messages : [];
    return messages.every((m) => m?.role === "system");
  }
  const BLANK_THREAD_TTL_MS = 30 * 60 * 1000;
  function cleanupBlankThreads({ force = false } = {}) {
    const now = Date.now();
    let removed = false;
    for (const [id, t] of threads) {
      if (!isBlankNewThread(t)) continue;
      if (!force && id === activeThreadId) continue;
      if (!force && now - Number(t.updatedAt || t.createdAt || 0) < BLANK_THREAD_TTL_MS) continue;
      threads.delete(id);
      removed = true;
    }
    if (!threads.size) newThread();
    if (!threads.has(activeThreadId)) activeThreadId = [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
    return removed;
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
  function publicTaskController(controller) {
    if (!controller || typeof controller !== "object" || !Array.isArray(controller.plan)) return null;
    return {
      objective: String(controller.objective || "").slice(0, 500),
      phase: String(controller.phase || ""),
      artifactRequired: controller.artifactRequired === true,
      // The controller decides this once real work starts; artifactRequired alone
      // is only a classification and must not raise a plan on its own.
      showPlan: controller.showPlan === true,
      plan: controller.plan.slice(0, 40).map((step) => ({
        step: String(step?.step || "").slice(0, 300),
        status: ["pending", "in_progress", "done"].includes(step?.status) ? step.status : "pending"
      })),
      startedAt: Number(controller.startedAt) || 0,
      updatedAt: Number(controller.updatedAt) || 0,
      completedAt: Number(controller.completedAt) || 0,
      lastFailure: String(controller.lastFailure || "").slice(0, 1000),
      changedFiles: Array.isArray(controller.changedFiles)
        ? controller.changedFiles.slice(-12).map((item) => String(item || "").slice(0, 260))
        : [],
      checks: Array.isArray(controller.checks)
        ? controller.checks.slice(-8).map((item) => String(item || "").slice(0, 260))
        : [],
      recentActions: Array.isArray(controller.recentActions)
        ? controller.recentActions.slice(-10).map((item) => String(item || "").slice(0, 260))
        : [],
      taskRun: controller.taskRun && typeof controller.taskRun === "object" ? controller.taskRun : null,
      compaction: controller.compaction && typeof controller.compaction === "object" ? controller.compaction : null,
      inspectionCount: Math.max(0, Number(controller.inspectionCount) || 0),
      mutationCount: Math.max(0, Number(controller.mutationCount) || 0),
      lastVerification: Math.max(0, Number(controller.lastVerification) || 0)
    };
  }
  function publicPendingTask(task) {
    if (!task || typeof task !== "object") return null;
    return {
      state: task.state || "",
      updatedAt: task.updatedAt || 0,
      controller: publicTaskController(task.controller)
    };
  }
  function threadList() {
    cleanupBlankThreads();
    let repairedOrphan = false;
    for (const thread of threads.values()) repairedOrphan = interruptOrphanedPendingTask(thread) || repairedOrphan;
    if (repairedOrphan) persist();
    return [...threads.values()]
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, pinned: !!t.pinned,
        kind: isProjectThread(t) ? "project" : "chat", side: t.side === true, projectDir: t.projectDir || "",
        parentProjectId: t.parentProjectId || "",
        pendingTask: publicPendingTask(t.pendingTask) }));
  }
  const renderThread = (t) => t.log; // display log = full history incl. tool steps
  function threadPage(t, { tail = 0, before = null, limit = 0 } = {}) {
    const log = Array.isArray(renderThread(t)) ? renderThread(t) : [];
    const end = before === null ? log.length : Math.max(0, Math.min(log.length, Number(before) || 0));
    const requested = Math.max(0, Math.min(250, Number(tail || limit) || 0));
    const start = requested ? Math.max(0, end - requested) : 0;
    let userIndex = -1;
    for (let i = 0; i < start; i++) if (log[i]?.t === "user") userIndex++;
    const page = log.slice(start, end).map((entry) => {
      if (entry?.t !== "user") return entry;
      userIndex++;
      return { ...entry, userIndex };
    });
    return { log: page, logStart: start, logTotal: log.length, hasMore: start > 0 };
  }
  let activeThreadId = null;

  // Facts about the open thread, not behavior instructions. This was stubbed to
  // "" to keep the relay provider-neutral, which also cut the project file map
  // and BOOLLM.md project rules - leaving the policy's "inspect repository
  // instructions before editing" rule with nothing to inspect. Restored; the
  // memory sections stay behind their existing user settings.
  function currentAppContext(t, latestText = "", { inspectSavedTask = false } = {}) {
    const parts = [];
    const taskPrompt = inspectSavedTask && t.pendingTask
      ? [
          "SAVED TASK STATUS (read-only; do not resume it unless the user explicitly asks):",
          `Objective: ${t.pendingTask.objective || ""}`,
          `State: ${t.pendingTask.state || "unknown"}`,
          t.pendingTask.controller?.phase ? `Controller phase: ${t.pendingTask.controller.phase}` : "",
          t.pendingTask.controller?.changedFiles?.length ? `Changed files: ${t.pendingTask.controller.changedFiles.join(", ")}` : "",
          t.pendingTask.controller?.checks?.length ? `Checks: ${t.pendingTask.controller.checks.join("; ")}` : ""
        ].filter(Boolean).join("\n")
      : activeTaskPrompt(t.pendingTask);
    const useChatMemory = config.ui?.referenceChatMemory !== false;
    const digest = useChatMemory && t.memoryDigest && typeof t.memoryDigest === "object" ? [
      "DURABLE CHAT MEMORY:",
      t.memoryDigest.activeTopic ? `Active topic: ${t.memoryDigest.activeTopic}` : "",
      t.memoryDigest.userCorrections?.length ? `User corrections: ${t.memoryDigest.userCorrections.slice(-2).join(" | ")}` : "",
      t.memoryDigest.recentDecisions?.length ? `Decisions: ${t.memoryDigest.recentDecisions.slice(-3).join(" | ")}` : "",
      t.memoryDigest.recentAnswers?.length ? `Recent answers: ${t.memoryDigest.recentAnswers.slice(-2).join(" | ")}` : ""
    ].filter(Boolean).join("\n") : "";
    const brief = t.kind === "project" && t.projectDir ? projectBrief(t.projectDir) : "";
    const memory = !useChatMemory || config.ui?.autoSave === false ? "" : buildLocalChatMemory([...threads.values()], {
      currentThreadId: t.id,
      latestText,
      projectDir: t.kind === "project" ? t.projectDir || "" : "",
      maxThreads: 4
    });
    if (brief) parts.push(brief);
    if (taskPrompt) parts.push(taskPrompt);
    if (digest) parts.push(digest);
    if (memory) parts.push(memory);
    return parts.length ? `\n\nCURRENT APP CONTEXT:\n${parts.join("\n\n")}` : "";
  }

  // persist chats to disk (workspace recovery), unless privacy mode is on
  const persist = () => {
    if (config.ui?.autoSave === false) return;
    saveThreads([...threads.values()].filter((t) => !isBlankNewThread(t)));
  };

  // restore previous session's chats on startup
  const restored = config.ui?.autoSave === false ? [] : loadThreads();
  if (restored.length) {
    let repairedTitles = false;
    for (const t of restored) {
      if (t.side !== true && t.title === "Side chat") { t.side = true; repairedTitles = true; }
      if (repairAutoNotepadTitle(t)) repairedTitles = true;
      if (repairGenericWorkflowTitle(t, restored)) repairedTitles = true;
      if (!t.kind && isProjectThread(t)) { t.kind = "project"; repairedTitles = true; }
      if (t.kind !== "project") { t.kind = "chat"; t.projectDir = ""; t.parentProjectId = ""; }
      t.workspaceChanges = Array.isArray(t.workspaceChanges) ? t.workspaceChanges : [];
      if (t.pendingTask?.state === "running") {
        t.pendingTask.state = "interrupted";
        t.pendingTask.updatedAt = Date.now();
        repairedTitles = true;
      }
      threads.set(t.id, { ...t, abort: null });
    }
    for (const t of restored) {
      if (t.kind === "project") continue;
      const unique = uniqueThreadTitle(t.title, t, restored);
      if (unique !== t.title) { t.title = unique; repairedTitles = true; }
      const saved = threads.get(t.id);
      if (saved) saved.title = t.title;
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
    // Keep every scheduled monitor in its own continuing chat. runDueAutomations
    // persists this runtime field with the rest of the item after the first run,
    // so its previous same-symbol reading becomes the next run's baseline.
    if (!item.threadId) item.threadId = t.id;
    const text = String(item.text || "").trim();
    if (!text) return { code: 1, output: "The scheduled AI prompt is empty.", threadId: t.id };
    const needsVisiblePage = /\b(browser|visible page|current page|robinhood|legend|broker page)\b/i.test(text);
    const liveBrowserContext = needsVisiblePage ? browserSnapshotText() : "";
    // A task that asks to read a page, with no page attached and (for prompt
    // tasks) no tools to fetch one, is the shape that produced invented prices
    // and alerts about moves that never happened. Name the gap and forbid the
    // guess rather than leaving a blank the model will fill.
    const missingPage = needsVisiblePage && !liveBrowserContext ? browserSnapshotGap() : "";
    const content = `Scheduled task: ${text}`
      + (liveBrowserContext
        ? `\n\n${liveBrowserContext}\n\nTreat the symbol or contract visible in this snapshot as the monitored instrument. If it differs from an older symbol, reset the comparison baseline for the newly visible instrument and do not ask to reopen the old one.`
        : "")
      + (missingPage
        ? `\n\nNO PAGE SNAPSHOT IS AVAILABLE — ${missingPage}.`
          + (item.actionType === "agent"
            ? " Read the page with visible_browser_read before answering. If that fails, report that you could not read it."
            : " This task type has no tools, so there is no way to read the page on this run.")
          + " Do NOT estimate, assume, or repeat earlier values as if they were current, and do NOT raise an alert."
          + " Reply with one line saying the page could not be read and why."
        : "");
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
    if (shouldAutoTitleThread(t)) t.title = String(item.name || shortThreadTitle(text)).slice(0, 42);
    t.updatedAt = Date.now();
    persist();

    try {
      if (item.actionType === "agent") {
        if (!item.autoApprove) throw new Error("This scheduled AI task needs Auto-approve. Edit the task while Auto-approve is enabled, or use Ask AI (answer only).");
        if (t.messages[0]?.role === "system") {
          t.messages[0] = { role: "system", content: systemPrompt(runConfig.projectsDir, true, runConfig) + currentAppContext(t, content) };
        }
        const abort = new AbortController();
        let replyModel = currentModel(runConfig);
        let runIn = 0, runOut = 0, runEst = false, runCalls = 0;
        const ctx = {
          config: runConfig,
          unattended: true,
          scheduled: true,
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
          onCapabilityChange: (modelCapabilities) => {
            config.modelCapabilities = modelCapabilities;
            saveConfig(config);
          },
          onBrowse: () => {},
          visibleBrowser: async (command = {}) => {
            if (!["read", "inspect_layout"].includes(String(command.action || ""))) {
              return "Scheduled tasks may read the cached visible browser page but cannot interact with it unattended.";
            }
            return browserSnapshotText() || "The visible browser has not supplied a recent page snapshot. Keep Boollm open with the broker page visible, then try again.";
          },
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
        { role: "system", content: "" },
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
  const syncWarmEnv = () => { process.env.BOOLLM_KEEP_ENGINE_WARM = config.ui?.keepLocalWarm !== false ? "1" : ""; };
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
    <script>try{if(window.opener)window.opener.postMessage({type:"boolean-mcp-oauth",ok:${ok}},location.origin);${ok ? "setTimeout(()=>window.close(),900)" : ""}}catch{}</script>`;
  function shutdown() {
    if (activeChats > 0) return;
    if (config.ui?.keepLocalWarm !== false) {
      try { engine.keepEngineAliveOnExit(); } catch { /* keep normal shutdown */ }
    }
    if (codexClient) {
      const timer = setTimeout(() => process.exit(0), 750);
      timer.unref?.();
      stopCodexClient().finally(() => { clearTimeout(timer); process.exit(0); });
      return;
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
    const emailOAuthCallbackRequest = req.method === "GET" && p === "/"
      && url.searchParams.has("state")
      && (url.searchParams.has("code") || url.searchParams.has("error"));
    const json = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // block DNS-rebinding: only accept requests addressed to localhost
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    // CSRF guard: state-changing API calls must carry this launch's token.
    // (Proxied web pages run in a sandboxed frame and can never add the header;
    // the token additionally keeps other local processes out.)
    if (p.startsWith("/api/") && req.method === "POST" && p !== "/api/bye" && req.headers["x-saz"] !== sessionToken) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    try {
      if (req.method === "POST" && p === "/api/browse/clear") {
        clearCookies();
        json({ ok: true });
        return;
      }
      if (req.method === "POST" && p === "/api/clipboard/read") {
        try {
          json({ ok: true, text: readSystemClipboardText() });
        } catch (err) {
          json({ ok: false, error: err?.message || "Could not read clipboard." }, 500);
        }
        return;
      }
      if (req.method === "GET" && p === "/" && !emailOAuthCallbackRequest) {
        // in dev (running from source) re-read the file each load, so editing
        // ui.html + refreshing the browser shows changes with no restart
        const html = uiHtmlForSession();
        const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(req.headers["accept-encoding"] || ""));
        if (acceptsGzip) {
          const body = compressedUiHtml(html);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": body.length,
            "cache-control": "no-store",
            vary: "Accept-Encoding"
          });
          res.end(body);
        } else {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Accept-Encoding" });
          res.end(html);
        }
        return;
      }
      if (req.method === "GET" && p.startsWith(EDITOR_ASSET_PREFIX)) {
        serveEditorAsset(p, req, res);
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
      if (req.method === "GET" && p === "/api/education/official") {
        if (!marketAccessAllowed(config)) {
          json({ error: "Sign in to your Boollm account to use Education." }, 401);
          return;
        }
        json(officialEducationCatalog);
        return;
      }
      if (req.method === "GET" && p === "/api/education/card") {
        if (!marketAccessAllowed(config)) {
          json({ error: "Sign in to your Boollm account to use Education." }, 401);
          return;
        }
        const exam = officialEducationById.get(String(url.searchParams.get("id") || ""));
        const number = Number(url.searchParams.get("number"));
        if (!exam || !Number.isInteger(number) || number < 1 || number > Number(exam.questionCount)) {
          json({ error: "official education question not found" }, 404);
          return;
        }
        const cardPath = IS_SEA
          ? path.join(path.dirname(process.execPath), "education-cards", exam.id, `${number}.webp`)
          : appPath("assets", "education-cards", exam.id, `${number}.webp`);
        if (!fs.existsSync(cardPath)) {
          json({ error: "official education question card not found" }, 404);
          return;
        }
        res.writeHead(200, {
          "content-type": "image/webp",
          "cache-control": "private, max-age=86400",
          "content-length": fs.statSync(cardPath).size
        });
        fs.createReadStream(cardPath).pipe(res);
        return;
      }
      if (req.method === "GET" && p === "/api/education/pdf") {
        if (!marketAccessAllowed(config)) {
          json({ error: "Sign in to your Boollm account to use Education." }, 401);
          return;
        }
        const exam = officialEducationById.get(String(url.searchParams.get("id") || ""));
        const kind = String(url.searchParams.get("kind") || "exam");
        const index = Math.max(0, Number(url.searchParams.get("index")) || 0);
        let sourceUrl = "";
        if (exam) {
          if (kind === "exam") sourceUrl = exam.examUrl;
          else if (kind === "key") sourceUrl = exam.keyUrl;
          else if (kind === "conversion") sourceUrl = exam.conversionUrl;
          else if (kind === "rating") sourceUrl = exam.ratingUrls?.[index] || "";
        }
        if (!sourceUrl || !/^https:\/\/(?:www\.)?nysedregents\.org\//i.test(sourceUrl)) {
          json({ error: "official education document not found" }, 404);
          return;
        }
        try {
          let document = officialEducationPdfCache.get(sourceUrl);
          if (!document) {
            const upstream = await fetch(sourceUrl, {
              headers: { "user-agent": `${APP_NAME}/${APP_VERSION} educational PDF viewer` },
              signal: AbortSignal.timeout(45000)
            });
            if (!upstream.ok) throw new Error(`NYSED returned HTTP ${upstream.status}`);
            document = Buffer.from(await upstream.arrayBuffer());
            if (document.length > 30 * 1024 * 1024) throw new Error("official document is too large");
            if (officialEducationPdfCache.size >= 6) officialEducationPdfCache.delete(officialEducationPdfCache.keys().next().value);
            officialEducationPdfCache.set(sourceUrl, document);
          }
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": document.length,
            "cache-control": "private, max-age=3600",
            "content-disposition": `inline; filename="${exam.id}-${kind}.pdf"`
          });
          res.end(document);
        } catch (err) {
          json({ error: err.message || "official document could not be loaded" }, 502);
        }
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
          name: APP_NAME, short_name: "Boollm", description: APP_TAGLINE,
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

      if (req.method === "GET" && p === "/api/about") {
        json(aboutPayload());
        return;
      }

      if (req.method === "POST" && p === "/api/bye") {
        res.writeHead(200); res.end("bye");
        if (autoExit && !byeTimer) byeTimer = setTimeout(shutdown, 8000);
        return;
      }

      // Local dev servers currently listening, for the browser's start screen.
      if (req.method === "GET" && p === "/api/local-servers") {
        let servers = [];
        try { servers = await detectLocalServers({ excludePort: serverPort }); } catch { /* best effort */ }
        return json({ servers });
      }

      // Entry page for the built-in browser: local servers first, then quick links.
      if (req.method === "GET" && p === "/browser-start") {
        let servers = [];
        try { servers = await detectLocalServers({ excludePort: serverPort }); } catch { /* best effort */ }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(browserStartPage(servers, {
          explore: config.ui?.browserExploreHome === true,
          bookmarks: Array.isArray(config.ui?.browserBookmarks) ? config.ui.browserBookmarks : []
        }));
        return;
      }

      if (req.method === "GET" && p === "/browser-chrome") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(browserChromePage());
        return;
      }

      if (req.method === "GET" && p === "/api/state") {
        lastPing = Date.now();
        if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
        let models = [];
        try { models = await listProviderModels(config, { remote: false }); } catch { /* backend down */ }
        const providerReady = {};
        await Promise.all(PROVIDERS.map(async (provider) => {
          try { providerReady[provider] = await backendUp({ ...config, provider }); }
          catch { providerReady[provider] = false; }
        }));
        const activeThread = url.searchParams.get("thread") === "1" ? threads.get(activeThreadId) : null;
        const activeThreadPage = activeThread
          ? threadPage(activeThread, { tail: url.searchParams.get("tail") || 80 })
          : null;
        const currentVision = config.provider === "local"
          ? (() => { try { return engine.visionState(config); } catch { return { supported: false, reason: "unknown" }; } })()
          : { supported: config.provider !== "zaiCoding", cloud: true };
        json({
          appName: APP_NAME, version: APP_VERSION, displayVersion: APP_DISPLAY_VERSION, tagline: APP_TAGLINE,
          provider: config.provider, providers: PROVIDERS, models,
          providerModels: Object.fromEntries(PROVIDERS.map((p) => [p, config[p]?.model || ""])),
          cloudFallback: {
            enabled: !!config.cloudFallback?.enabled,
            provider: config.cloudFallback?.provider || "",
            model: config.cloudFallback?.model || ""
          },
          model: currentModel(config), accessMode: currentAccessMode(config), autoApprove: config.autoApprove,
          modelCapability: publicModelCapability(config, currentVision.supported),
          local: (() => {
            const hardware = engine.detectLocalHardware();
            let modelBytes = 0;
            try {
              const selected = config.local.model || engine.listLocalModels()[0] || "";
              if (selected) modelBytes = fs.statSync(path.join(engine.MODELS_DIR, selected)).size;
            } catch { /* recommendation remains useful without a selected model */ }
            const recommendation = engine.recommendLocalSettings(hardware, modelBytes);
            return { ctx: config.local.ctx, autoTune: config.local.autoTune !== false, hardware, recommendation };
          })(),
          backendUp: providerReady[config.provider] === true,
          providerReady,
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
          budgetLimit: config.budgetLimit || 0,
          connectors: publicConnectors(config, managedEmailOAuthClients),
          imageGeneration: publicImageGeneration(config),
          codingEngine: config.codingEngine || (config.codex?.enabled ? "codex" : "boolean"),
          codex: publicCodexStatus(),
          claudeCode: publicClaudeStatus(),
          codexPendingInputs: publicCodexInputs(),
          codexPendingApprovals: publicCodexApprovals(),
          cloudBackend: publicCloudBackend(config),
          browseBase,
          vision: currentVision,
          ui: config.ui,
          eulaAccepted: !!config.eulaAccepted,
          threads: threadList(), activeThreadId,
          activeThread: activeThread ? {
            id: activeThread.id,
            title: activeThread.title,
            kind: isProjectThread(activeThread) ? "project" : "chat",
            side: activeThread.side === true,
            projectDir: activeThread.projectDir || "",
            pendingTask: publicPendingTask(activeThread.pendingTask),
            ...activeThreadPage
          } : null
        });
        return;
      }

      if (req.method === "GET" && p === "/api/status") {
        lastPing = Date.now();
        if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
        const providerReady = {};
        await Promise.all(PROVIDERS.map(async (provider) => {
          try { providerReady[provider] = await backendUp({ ...config, provider }); }
          catch { providerReady[provider] = false; }
        }));
        json({
          version: APP_VERSION,
          displayVersion: APP_DISPLAY_VERSION,
          provider: config.provider,
          model: currentModel(config),
          modelCapability: publicModelCapability(config),
          accessMode: currentAccessMode(config),
          autoApprove: config.autoApprove,
          backendUp: providerReady[config.provider] === true,
          providerReady,
          codingEngine: config.codingEngine || (config.codex?.enabled ? "codex" : "boolean"),
          codex: publicCodexStatus(),
          claudeCode: publicClaudeStatus(),
          codexPendingInputs: publicCodexInputs(),
          codexPendingApprovals: publicCodexApprovals(),
          tradingAdapters: tradingAdapterSummary(config),
          threads: threadList(),
          activeThreadId
        });
        return;
      }

      if (req.method === "GET" && p === "/api/provider-models") {
        const provider = String(url.searchParams.get("provider") || "").trim();
        if (!CLOUD[provider]) return json({ error: "invalid_provider" }, 400);
        if (!config[provider]?.apiKey) return json({ error: "api_key_required" }, 401);
        const providerConfig = { ...config, provider };
        try {
          const models = await listProviderModels(providerConfig, { strict: true });
          json({ ok: true, provider, models });
        } catch (err) {
          const status = err?.status === 401 || err?.status === 403 ? 401 : 502;
          json({ error: status === 401 ? "api_key_rejected" : "model_list_failed", message: String(err?.message || err) }, status);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/model/warm") {
        if (config.provider !== "local" || config.ui?.keepLocalWarm === false) {
          return json({ ok: true, skipped: true });
        }
        setImmediate(() => engine.ensureRunning(config, () => {}).catch(() => {}));
        json({ ok: true, warming: true });
        return;
      }

      if (req.method === "POST" && p === "/api/model-capabilities/probe") {
        const body = await readBody(req);
        try {
          const result = await probeCurrentModelCapability(config, { force: body.force === true });
          json({ ok: true, modelCapability: result });
        } catch (err) {
          json({
            error: "capability_probe_failed",
            message: "Boollm could not complete the safe capability check. No tools were executed.",
            detail: String(err?.message || err)
          }, 502);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/provider-test") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim();
        if (!CLOUD[provider]) return json({ error: "invalid_provider" }, 400);
        const candidateKey = typeof body.key === "string" ? body.key.trim() : "";
        if (!candidateKey && !config[provider]?.apiKey) return json({ error: "api_key_required" }, 401);
        try {
          const providerConfig = candidateKey
            ? { ...config, provider, [provider]: { ...config[provider], apiKey: candidateKey } }
            : { ...config, provider };
          const target = await resolveTarget(providerConfig);
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
          if (data.user?.role === "admin" || data.user?.is_admin === true) {
            try { await syncCloudVault(config, { merge: true }); } catch { /* sign-in still succeeds if vault setup is incomplete */ }
          }
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

      if (req.method === "GET" && p === "/api/skills") {
        try {
          const skills = installedSkills().map(({ id, name, version, description, permissions }) => ({ id, name, version, description: description || "", permissions }));
          json({ skills });
        } catch (err) { json({ error: err.message }, 500); }
        return;
      }

      if (req.method === "POST" && p === "/api/skills") {
        const body = await readBody(req);
        const operation = String(body.operation || "");
        if (!["install", "remove", "inspect"].includes(operation)) {
          return json({ error: "Unsupported skill operation." }, 400);
        }
        try {
          const result = await manageSkill(body, {
            projectDir: config.projectsDir,
            config,
            approve: async () => true
          });
          try { json(JSON.parse(result)); }
          catch { json({ ok: true, message: result }); }
        } catch (err) { json({ error: err.message }, 500); }
        return;
      }

      if (req.method === "GET" && p === "/api/github/status") {
        try {
          const status = await ghStatus({ projectDir: config.projectsDir, config });
          json(status);
        } catch (err) { json({ installed: false, authenticated: false, error: err.message }); }
        return;
      }

      if (req.method === "POST" && p === "/api/github/setup") {
        try {
          const body = await readBody(req);
          const action = String(body.action || "");
          const projectDir = path.resolve(config.projectsDir || process.cwd());
          if (["install", "connect", "disconnect", "switch"].includes(action)) {
            launchGithubGuide(action, projectDir);
            json({ ok: true, started: true, action });
            return;
          }
          if (action === "repo_create") {
            const name = String(body.name || "").trim();
            const visibility = body.visibility === "public" ? "public" : "private";
            if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return json({ error: "Use a repository name with letters, numbers, dots, dashes, or underscores." }, 400);
            ensureGitRepository(projectDir);
            githubSetupCommand("gh", ["repo", "create", name, `--${visibility}`, "--source", projectDir, "--remote", "origin", "--push"], projectDir);
            json({ ok: true, action, message: `Created ${name} on GitHub.` });
            return;
          }
          if (action === "repo_connect") {
            const url = String(body.url || "").trim();
            if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(url)) return json({ error: "Enter a complete GitHub repository URL." }, 400);
            ensureGitRepository(projectDir);
            const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: projectDir, windowsHide: true, encoding: "utf8" });
            githubSetupCommand("git", remote.status === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url], projectDir);
            json({ ok: true, action, message: "Connected this project to the GitHub repository." });
            return;
          }
          json({ error: "Unsupported GitHub setup action." }, 400);
        } catch (err) { json({ error: err.message }, 500); }
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
        if (url.searchParams.get("peek") !== "1") activeThreadId = t.id;
        const page = threadPage(t, {
          tail: url.searchParams.get("tail"),
          before: url.searchParams.has("before") ? url.searchParams.get("before") : null,
          limit: url.searchParams.get("limit")
        });
        json({ id: t.id, title: t.title, kind: isProjectThread(t) ? "project" : "chat", side: t.side === true,
          projectDir: t.projectDir || "", parentProjectId: t.parentProjectId || "", ...page,
          pendingTask: publicPendingTask(t.pendingTask) });
        return;
      }

      if (req.method === "GET" && p === "/api/top-prompts") {
        const internal = /^(TOOL RESULT|RESUME INTERRUPTED TASK|CURRENT APP CONTEXT|CURRENT THREAD MEMORY|APPROVAL RESULT|SCHEDULED TASK|SYSTEM PREFLIGHT|BOOLLM CONTROLLER)/i;
        const counts = new Map();
        for (const t of threads.values()) {
          for (const m of t.messages || []) {
            if (m?.role !== "user") continue;
            if (typeof m.content !== "string") continue;
            const text = m.content.trim();
            if (!text || internal.test(text)) continue;
            const first = text.split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
            if (!first) continue;
            const prompt = first.length > 80 ? first.slice(0, 80) + "..." : first;
            const row = counts.get(prompt) || { prompt, count: 0 };
            row.count++;
            counts.set(prompt, row);
          }
        }
        json({ prompts: [...counts.values()].sort((a, b) => b.count - a.count || a.prompt.localeCompare(b.prompt)).slice(0, 10) });
        return;
      }

      if (req.method === "POST" && p === "/api/thread/new") {
        const body = await readBody(req);
        const previousActiveThreadId = activeThreadId;
        const title = String(body.title || "").trim().slice(0, 80);
        const parentProject = body.projectId ? threads.get(String(body.projectId)) : null;
        if (body.projectId && (!parentProject || parentProject.kind !== "project" || parentProject.parentProjectId || !parentProject.projectDir)) {
          return json({ error: "This project folder is unavailable." }, 404);
        }
        const t = parentProject
          ? newThread({ kind: "project", title: title || "New chat", projectDir: parentProject.projectDir, parentProjectId: parentProject.id })
          : body.side === true
          ? newThread({ title: title || "Side chat", side: true })
          : (body.forceNew === true ? newThread({ title: title || "New chat" }) : reuseOrNewThread());
        if (body.side === true && threads.has(previousActiveThreadId)) activeThreadId = previousActiveThreadId;
        persist();
        json({ id: t.id, parentProjectId: t.parentProjectId || "" });
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

      // ── Semantic actions and capability search ──
      if (p.startsWith("/api/workspace/")) {
        const requestedThreadId = String(url.searchParams.get("threadId") || activeThreadId || "");
        const workspaceThread = threads.get(requestedThreadId);
        if (!workspaceThread || workspaceThread.kind !== "project" || !workspaceThread.projectDir) {
          return json({ error: "Open a project task before using Code." }, 400);
        }
        // The global CSRF guard only covers POST, and these routes create,
        // move, and delete real files in the user's project.
        if (req.method !== "GET" && req.headers["x-saz"] !== sessionToken) {
          res.writeHead(403); res.end("forbidden"); return;
        }
        try {
          if (req.method === "POST" && p === "/api/workspace/entry") {
            const body = await readBody(req);
            const created = createWorkspaceEntry(workspaceThread.projectDir, body.path, { type: body.type, content: body.content });
            invalidateProjectStatus(workspaceThread.projectDir);
            return json({ ok: true, threadId: workspaceThread.id, ...created });
          }
          if (req.method === "PATCH" && p === "/api/workspace/entry") {
            const body = await readBody(req);
            const moved = renameWorkspaceEntry(workspaceThread.projectDir, body.from, body.to);
            invalidateProjectStatus(workspaceThread.projectDir);
            return json({ ok: true, threadId: workspaceThread.id, ...moved });
          }
          if (req.method === "DELETE" && p === "/api/workspace/entry") {
            const removed = deleteWorkspaceEntry(workspaceThread.projectDir, url.searchParams.get("path") || "");
            invalidateProjectStatus(workspaceThread.projectDir);
            return json({ ok: true, threadId: workspaceThread.id, ...removed });
          }
          if (req.method === "GET" && p === "/api/workspace/tree") {
            return json({ threadId: workspaceThread.id, ...listWorkspaceTree(workspaceThread.projectDir) });
          }
          if (req.method === "GET" && p === "/api/workspace/search") {
            const query = url.searchParams.get("q") || "";
            const mode = url.searchParams.get("mode");
            const found = mode === "text"
              ? searchWorkspaceText(workspaceThread.projectDir, query, { caseSensitive: url.searchParams.get("case") === "1" })
              : mode === "symbols" ? findWorkspaceSymbols(workspaceThread.projectDir, query)
              : findWorkspaceFiles(workspaceThread.projectDir, query);
            return json({ threadId: workspaceThread.id, ...found });
          }
          if (req.method === "GET" && p === "/api/workspace/file") {
            const file = readWorkspaceFile(workspaceThread.projectDir, url.searchParams.get("path") || "");
            return json({ threadId: workspaceThread.id, root: path.resolve(workspaceThread.projectDir), ...file });
          }
          if (req.method === "PUT" && p === "/api/workspace/file") {
            const body = await readBody(req);
            const saved = writeWorkspaceFile(workspaceThread.projectDir, body.path, body.content, { expectedMtimeMs: body.expectedMtimeMs, expectedHash: body.expectedHash });
            invalidateProjectStatus(workspaceThread.projectDir);
            return json({ ok: true, threadId: workspaceThread.id, ...saved });
          }
        } catch (err) {
          const status = err?.code === "WORKSPACE_FILE_CONFLICT" || err?.code === "WORKSPACE_ENTRY_EXISTS" ? 409
            : err?.code === "WORKSPACE_UNAVAILABLE" || err?.code === "WORKSPACE_ENTRY_MISSING" ? 404
              : err?.code?.startsWith("WORKSPACE_") ? 400 : 500;
          return json({ error: err.message, code: err.code || "WORKSPACE_ERROR" }, status);
        }
      }

      if (req.method === "GET" && p === "/api/actions") {
        const query = url.searchParams.get("q") || "";
        json({ ok: true, actions: query ? searchActions(query) : listActions() });
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/vault/sync") {
        try { json({ ok: true, ...(await syncCloudVault(config, { merge: true })) }); }
        catch (err) { json(err?.data || { error: "cloud_vault_unavailable", message: err.message }, err.status || 502); }
        return;
      }

      if (req.method === "POST" && p === "/api/cloud/vault/push") {
        try { json({ ok: true, ...(await syncCloudVault(config, { merge: false })) }); }
        catch (err) { json(err?.data || { error: "cloud_vault_unavailable", message: err.message }, err.status || 502); }
        return;
      }

      // ── Diagnostics ──
      if (req.method === "GET" && p === "/api/opencodex/status") {
        json(await detectOpenCodex());
        return;
      }
      if (req.method === "GET" && p === "/api/diagnostics/export") {
        const active = threads.get(activeThreadId);
        const activeProvider = String(config.provider || "local");
        const activeModel = String(currentModel(config) || "").slice(0, 160);
        const capability = modelCapabilityProfile(config, {
          provider: activeProvider,
          model: activeModel,
          base: config?.[activeProvider]?.baseUrl || ""
        });
        const report = {
          format: "boolean-diagnostics",
          version: 1,
          exportedAt: new Date().toISOString(),
          app: { name: APP_NAME, version: APP_VERSION, packaged: IS_SEA, platform: process.platform, arch: process.arch },
          runtime: { node: process.version, uptimeSeconds: Math.round(process.uptime()), activeChats },
          model: {
            id: canonicalModelId({ provider: activeProvider, model: activeModel }),
            provider: activeProvider,
            model: activeModel,
            accessMode: currentAccessMode(config),
            autoApprove: config.autoApprove === true,
            capabilities: capability.capabilities,
            capabilityMode: capability.mode
          },
          routing: {
            enabled: config.ui?.autoRouteModels === true,
            preference: config.ui?.modelRouting?.preference || "balanced",
            profiles: config.ui?.modelRouting?.profiles || {},
            health: autoModelHealthSnapshot()
          },
          openCodex: await detectOpenCodex(),
          task: publicPendingTask(active?.pendingTask),
          capabilities: listActions().map((action) => action.capability)
        };
        const body = JSON.stringify(report, null, 2);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="boolean-diagnostics-${Date.now()}.json"`,
          "cache-control": "no-store"
        });
        res.end(body);
        return;
      }
      if (req.method === "GET" && p === "/api/diagnostics") {
        const results = {};
        const spawnCheck = (cmd, args) => {
          try {
            const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 4000, shell: args.length === 0 });
            return { ok: r.status === 0, out: (r.stdout || "").trim().split("\n")[0].slice(0, 80) };
          } catch(e) { return { ok: false, out: "not found" }; }
        };

        // Provider/backend
        const provider = config.provider || "local";
        results.provider = { status: "ok", label: provider === "local" ? "Local engine" : provider, detail: config.backendUp === false ? "needs setup" : "ready" };
        const openCodex = await detectOpenCodex();
        results.openCodex = {
          status: openCodex.detected ? "ok" : "warn",
          label: openCodex.detected ? `OpenCodex · ${openCodex.modelCount} models` : "OpenCodex not running",
          detail: openCodex.detected ? `${openCodex.apiBase} · optional gateway available` : "Optional · start it on localhost:10100 to make it discoverable"
        };

        // Local model
        const modelFile = config.model || "";
        const configuredLocalModel = config.local?.model || modelFile;
        results.localModel = { status: configuredLocalModel ? "ok" : "warn", label: configuredLocalModel || "No model selected", detail: configuredLocalModel ? "available" : "select a model" };

        // Git
        const git = spawnCheck("git", ["--version"]);
        results.git = { status: git.ok ? "ok" : "err", label: git.ok ? git.out : "not installed", detail: git.ok ? "ready" : "install Git" };

        // GitHub CLI/auth
        const gh = spawnCheck("gh", ["auth", "status", "--hostname", "github.com"]);
        results.github = {
          status: gh.ok ? "ok" : "warn",
          label: gh.ok ? "signed in" : "needs login",
          detail: gh.ok ? "GitHub CLI authenticated" : "run gh auth login"
        };

        // Node
        const node = spawnCheck("node", ["--version"]);
        results.node = { status: node.ok ? "ok" : "err", label: node.ok ? node.out : "not installed", detail: node.ok ? "ready" : "needs Node.js" };

        // .NET / shell build toolchain
        const dotnet = spawnCheck("dotnet", ["--version"]);
        results.dotnet = { status: dotnet.ok ? "ok" : "warn", label: dotnet.ok ? dotnet.out : "not found", detail: dotnet.ok ? "shell builds ready" : "needed for packaging" };

        // Wrangler / deployment toolchain
        const wrangler = spawnCheck("npx.cmd", ["wrangler", "--version"]);
        results.wrangler = { status: wrangler.ok ? "ok" : "idle", label: wrangler.ok ? wrangler.out : "not configured", detail: wrangler.ok ? "Cloudflare deploy tool ready" : "optional deploy tool" };

        // WebView2 / shell
        results.webview = { status: "ok", label: config.appVersion || "0.9.x", detail: "running" };

        // Tool permissions
        results.permissions = {
          status: "ok",
          label: currentAccessMode(config) === "read_only" ? "Read only" : (config.autoApprove ? "Full access" : "Read & write"),
          detail: currentAccessMode(config) === "read_only"
            ? "inspect and validate without changing files or deploying"
            : (config.autoApprove ? "approved workspace actions run automatically" : "ask before changes and commands")
        };

        // Cloud budget
        const budget = config.budgetLimit || 0;
        results.cloudBudget = {
          status: budget > 0 ? "ok" : "idle",
          label: budget > 0 ? "$" + budget + "/mo" : "no limit",
          detail: budget > 0 ? "configured" : "unlimited"
        };

        const updateManifest = appPath("dist", "update.json");
        results.update = {
          status: fs.existsSync(updateManifest) ? "ok" : "idle",
          label: fs.existsSync(updateManifest) ? "manifest found" : "local only",
          detail: fs.existsSync(updateManifest) ? "installer metadata available" : "no local update manifest"
        };

        json({ ok: true, results });
        return;
      }

      // ── Export logs ──
      if (req.method === "GET" && p === "/api/export-logs") {
        const logs = [];
        try {
          const logDir = path.join(path.dirname(process.execPath), "..", "logs");
          if (fs.existsSync(logDir)) {
            for (const f of fs.readdirSync(logDir).filter(f => f.endsWith(".log")).slice(-3)) {
              logs.push({ file: f, content: fs.readFileSync(path.join(logDir, f), "utf8").slice(-5000) });
            }
          }
        } catch(e) {}
        json({ ok: true, logs, timestamp: new Date().toISOString() });
        return;
      }

      // ── Project status (dashboard data) ──
      if (req.method === "GET" && p === "/api/project-status") {
        const t = threads.get(activeThreadId);
        const projectDir = t?.projectDir || "";
        const { git } = projectGitSnapshot(projectDir, { force: url.searchParams.get("force") === "1" });
        const workspaceChanges = booleanWorkspaceChanges(t, projectDir, threads);
        const diffStat = workspaceChangeStats(workspaceChanges);
        json({ ok: true, projectName: t?.title || "No project", branch: git.branch, changedFiles: workspaceChanges, changesCount: workspaceChanges.length, diffStat, git,
          task: t?.task || null, taskState: t?.taskState || "idle", nextAction: t?.nextAction || null,
          serverRunning: !!(globalThis._bgServers?.size > 0), testStatus: null, testState: "idle" });
        return;
      }

      if (req.method === "GET" && p === "/api/workspace-changes") {
        const t = threads.get(activeThreadId);
        const changes = booleanWorkspaceChanges(t, t?.projectDir || "", threads);
        json({ ok: true, count: changes.length, changes, ...workspaceChangesReview(changes) });
        return;
      }

      if (req.method === "GET" && p === "/api/git/source-status") {
        try {
          json({ ok: true, ...gitSourceStatus(activeProjectDir(threads, activeThreadId)) });
        } catch (error) {
          json({ ok: false, error: error?.message || "Could not read Git status." }, 400);
        }
        return;
      }

      if (req.method === "GET" && p === "/api/code/extensions") {
        try {
          const projectDir = activeProjectDir(threads, activeThreadId);
          json({ ok: true, ...listCodeExtensions(projectDir), services: discoverLanguageServices({ probe: url.searchParams.get("probe") !== "0" }) });
        } catch (error) {
          json({ ok: false, error: error?.message || "Could not inspect Code extensions." }, 400);
        }
        return;
      }

      if (req.method === "GET" && p === "/api/git/file-diff") {
        try {
          json({ ok: true, ...gitFileContents(activeProjectDir(threads, activeThreadId), url.searchParams.get("path"), { staged: url.searchParams.get("staged") === "1" }) });
        } catch (error) {
          json({ ok: false, error: error?.message || "Could not open the file diff." }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/git/stage") {
        const body = await readBody(req);
        try {
          const projectDir = activeProjectDir(threads, activeThreadId);
          const result = gitStageFiles(projectDir, body.files, { unstage: body.unstage === true });
          invalidateProjectStatus(projectDir);
          json({ ok: true, ...result, status: gitSourceStatus(projectDir) });
        } catch (error) {
          json({ ok: false, error: error?.message || "Could not update the Git index." }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/git/commit") {
        const body = await readBody(req);
        try {
          const projectDir = activeProjectDir(threads, activeThreadId);
          const result = gitCommit(projectDir, body.message);
          invalidateProjectStatus(projectDir);
          json({ ok: true, ...result, status: gitSourceStatus(projectDir) });
        } catch (error) {
          json({ ok: false, error: error?.message || "Could not create the commit." }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/git/branch") {
        const body = await readBody(req);
        try { const projectDir = activeProjectDir(threads, activeThreadId); json({ ok: true, ...gitCreateBranch(projectDir, body.name), status: gitSourceStatus(projectDir) }); }
        catch (error) { json({ ok: false, error: error?.message || "Could not create branch." }, 400); }
        return;
      }

      if (req.method === "POST" && p === "/api/git/push") {
        const body = await readBody(req);
        try { json({ ok: true, ...gitPushBranch(activeProjectDir(threads, activeThreadId), body) }); }
        catch (error) { json({ ok: false, error: error?.message || "Could not push branch." }, 400); }
        return;
      }

      if (req.method === "POST" && p === "/api/github/pull-request") {
        const body = await readBody(req);
        try { json({ ok: true, ...githubCreatePullRequest(activeProjectDir(threads, activeThreadId), body) }); }
        catch (error) { json({ ok: false, error: error?.message || "Could not create pull request." }, 400); }
        return;
      }

      if (req.method === "POST" && p === "/api/git/unpush-last") {
        const body = await readBody(req);
        if (body.confirm !== "undo last push") {
          json({ ok: false, error: "Confirmation phrase required." }, 400);
          return;
        }
        const projectDir = activeProjectDir(threads, activeThreadId);
        invalidateProjectStatus(projectDir);
        const result = undoLastPushedCommit(projectDir);
        invalidateProjectStatus(projectDir);
        json(result);
        return;
      }

      if (req.method === "GET" && p === "/api/git/diff-files") {
        const t = threads.get(activeThreadId);
        const staged = url.searchParams.get("staged") === "1";
        let review;
        if (staged) {
          try { review = gitDiffFiles(activeProjectDir(threads, activeThreadId), { staged: true }); }
          catch { review = { files: [], patch: "", staged: true }; }
        } else {
          review = { ...workspaceChangesReview(booleanWorkspaceChanges(t, t?.projectDir || "", threads)), staged: false };
        }
        json({ ok: true, source: staged ? "git" : "boolean", ...review });
        return;
      }

      if (req.method === "POST" && p === "/api/git/restore-files") {
        const body = await readBody(req);
        try {
          json({ ok: true, ...gitRestoreFiles(activeProjectDir(threads, activeThreadId), body.files) });
        } catch {
          // Boollm can review verified changes in a non-Git folder, but it
          // never guesses how to restore them without a repository baseline.
          json({ ok: true, restored: [], skipped: Array.isArray(body.files) ? body.files : [], message: "Non-Git changes were left on disk." });
        }
        return;
      }

      if (req.method === "GET" && p === "/api/agent-runs") {
        const projectDir = activeProjectDir(threads, activeThreadId);
        json({ ok: true, runs: listAgentRuns(projectDir).map((run) => ({
          id: run.id,
          task: run.task,
          state: run.state,
          branch: run.branch,
          commit: run.commit || "",
          summary: run.summary || "",
          changeSummary: run.changeSummary || "",
          createdAt: run.createdAt,
          updatedAt: run.updatedAt
        })) });
        return;
      }

      if (req.method === "POST" && p === "/api/agent-runs/apply") {
        const body = await readBody(req);
        // A result that failed its own checks is refused unless the user says
        // to apply it anyway; the decision is theirs, not silent either way.
        const run = await applyAgentRun(String(body.id || ""), activeProjectDir(threads, activeThreadId), { requireVerified: body.force !== true });
        json({ ok: true, run });
        return;
      }

      if (req.method === "POST" && p === "/api/agent-runs/discard") {
        const body = await readBody(req);
        const run = await discardAgentRun(String(body.id || ""));
        json({ ok: true, run });
        return;
      }

      // ── Stripe billing endpoints ──
      if (req.method === "GET" && p === "/api/billing/plans") {
        json({ ok: true, plans: [
          { id: "free", name: "Free", price: 0, credits: 1000, features: ["Local AI", "1 cloud credit/day", "Community support"] },
          { id: "pro", name: "Pro", price: 12, credits: 500000, features: ["Everything in Free", "500K cloud credits/mo", "Priority models", "Email support"] },
          { id: "team", name: "Team", price: 39, credits: 2000000, features: ["Everything in Pro", "2M cloud credits/mo", "Shared workspace", "Priority support"] }
        ], current: config.cloud?.plan || "free" });
        return;
      }

      if (req.method === "POST" && p === "/api/billing/checkout") {
        const body = await readBody(req);
        const planId = String(body.planId || "").trim();
        const validPlans = ["pro", "team"];
        if (!validPlans.includes(planId)) return json({ error: "Invalid plan." }, 400);
        const key = process.env.STRIPE_SECRET_KEY || config.cloud?.stripeKey || "";
        if (!key) return json({ error: "Billing not configured. Set STRIPE_SECRET_KEY." }, 503);
        try {
          const prices = { pro: "price_pro_monthly", team: "price_team_monthly" };
          const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              "mode": "subscription",
              "line_items[0][price]": prices[planId],
              "line_items[0][quantity]": "1",
              "success_url": body.successUrl || `http://localhost:${server.address()?.port || 0}/?billing=success`,
              "cancel_url": body.cancelUrl || `http://localhost:${server.address()?.port || 0}/?billing=cancel`,
            }).toString()
          });
          const session = await resp.json();
          if (!resp.ok) return json({ error: session.error?.message || "Stripe checkout failed." }, 502);
          json({ ok: true, url: session.url, sessionId: session.id });
        } catch(e) { json({ error: "Could not reach Stripe: " + e.message }, 502); }
        return;
      }

      if (req.method === "POST" && p === "/api/billing/webhook") {
        const raw = await readRawBody(req);
        const key = process.env.STRIPE_SECRET_KEY || config.cloud?.stripeKey || "";
        const sig = req.headers["stripe-signature"] || "";
        if (!key) return json({ error: "Webhooks not configured." }, 503);
        try {
          const event = JSON.parse(raw);
          if (event.type === "checkout.session.completed") {
            const plan = event.data?.object?.metadata?.plan || "pro";
            config.cloud = config.cloud || {};
            config.cloud.plan = plan;
            persist();
          }
          json({ received: true });
        } catch(e) { json({ error: "Invalid webhook payload." }, 400); }
        return;
      }

      if (req.method === "GET" && p === "/api/billing/status") {
        const plan = config.cloud?.plan || "free";
        json({ ok: true, plan, creditsUsed: 0, creditsLimit: plan === "free" ? 1000 : plan === "pro" ? 500000 : 2000000 });
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
        const linkedCodexThreads = codexThreadIds([t]);
        if (t?.abort) t.abort.abort();
        threads.delete(body.id);
        if (threads.size === 0) newThread();
        if (!threads.has(activeThreadId)) activeThreadId = threadList()[0].id;
        persist();
        const codexHistory = await archiveLinkedCodexThreads(linkedCodexThreads);
        json({ ok: true, activeThreadId, codexHistory });
        return;
      }

      // Delete Boollm's saved copy. Codex owns a separate local history, so
      // archive linked app-server tasks when possible and always disclose that
      // the underlying Codex history is managed separately.
      if (req.method === "POST" && p === "/api/clear-history") {
        const savedThreads = [...threads.values()];
        const linkedCodexThreads = codexThreadIds(savedThreads);
        for (const thread of savedThreads) thread.abort?.abort();
        threads.clear();
        clearThreads();
        newThread();
        const codexHistory = await archiveLinkedCodexThreads(linkedCodexThreads);
        json({ ok: true, activeThreadId, codexHistory });
        return;
      }

      if (req.method === "POST" && p === "/api/config") {
        const body = await readBody(req);
        let explicitSecretRemoval = false;
        let explicitConnectionRemoval = body.replaceConnectors === true;
        let restartCodex = false;
        const provider = typeof body.provider === "string" && PROVIDERS.includes(body.provider) ? body.provider : config.provider;
        if (typeof body.provider === "string" && PROVIDERS.includes(body.provider)) config.provider = body.provider;
        if (typeof body.model === "string" && body.model) setCurrentModel(config, body.model, provider);
        if (body.accessMode !== undefined) {
          const accessMode = String(body.accessMode || "").trim().toLowerCase();
          if (!ACCESS_MODES.includes(accessMode)) return json({ error: "invalid_access_mode" }, 400);
          config.accessMode = accessMode;
          config.autoApprove = accessMode === "full_access";
        } else if (typeof body.autoApprove === "boolean") {
          // Old clients only know Manual/Auto. Keep them compatible while
          // storing the canonical permission boundary used by new clients.
          config.autoApprove = body.autoApprove;
          config.accessMode = body.autoApprove ? "full_access" : "ask";
        }
        if (Number.isFinite(body.localCtx)) {
          const ctx = Math.max(4096, Math.min(262144, Math.round(body.localCtx)));
          if (config.local.ctx !== ctx) {
            config.local.ctx = ctx;
            config.local.autoTune = false;
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
          explicitSecretRemoval = true;
          config[body.clearKey].apiKey = "";
          if (config.provider === body.clearKey) config.provider = "local";
          if (config.cloudFallback?.provider === body.clearKey) config.cloudFallback = { enabled: false, provider: "", model: "" };
        }
        if (typeof body.projectsDir === "string" && body.projectsDir.trim()) config.projectsDir = body.projectsDir.trim();
        if (typeof body.referenceModel === "string" && body.referenceModel) config.referenceModel = body.referenceModel;
        if (body.budgetLimit !== undefined) {
          const v = Number(body.budgetLimit);
          config.budgetLimit = (!isNaN(v) && v >= 0) ? Math.round(v * 100) / 100 : 0;
        }
        if (body.cloudFallback && typeof body.cloudFallback === "object") {
          const enabled = body.cloudFallback.enabled === true;
          const provider = String(body.cloudFallback.provider || "").trim();
          const model = String(body.cloudFallback.model || "").trim().slice(0, 200);
          if (enabled) {
            if (!CLOUD[provider] || provider === "local") return json({ error: "invalid_fallback_provider" }, 400);
            if (!config[provider]?.apiKey) return json({ error: "fallback_api_key_required" }, 400);
          }
          config.cloudFallback = { enabled, provider: enabled ? provider : "", model: enabled ? model : "" };
        }
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
        if (body.codex && typeof body.codex === "object") {
          if (codexInstallPromise) return json({
            ok: false,
            error: "install_in_progress",
            message: "Codex setup is already running."
          }, 409);
          const old = config.codex || {};
          const command = body.codex.command === undefined
            ? String(old.command || "codex")
            : String(body.codex.command || "codex").trim();
          if (!command || command.length > 1024 || /[\r\n\0]/.test(command)) return json({ error: "invalid_codex_command" }, 400);
          const effort = String(body.codex.reasoningEffort || old.reasoningEffort || "medium");
          if (!["low", "medium", "high", "xhigh", "ultra"].includes(effort)) return json({ error: "invalid_codex_effort" }, 400);
          const nextCodex = {
            enabled: body.codex.enabled === undefined ? old.enabled === true : body.codex.enabled === true,
            command,
            model: String(body.codex.model === undefined ? (old.model || "") : body.codex.model).trim().slice(0, 200),
            reasoningEffort: effort
          };
          restartCodex = nextCodex.command !== old.command || (old.enabled === true && nextCodex.enabled !== true);
          config.codex = nextCodex;
        }
        if (body.claudeCode && typeof body.claudeCode === "object") {
          if (claudeInstallPromise) return json({ ok: false, error: "install_in_progress", message: "Claude Code setup is already running." }, 409);
          const old = config.claudeCode || {};
          const command = body.claudeCode.command === undefined
            ? String(old.command || "claude")
            : String(body.claudeCode.command || "claude").trim();
          if (!command || command.length > 1024 || /[\r\n\0]/.test(command)) return json({ error: "invalid_claude_command" }, 400);
          config.claudeCode = {
            enabled: body.claudeCode.enabled === undefined ? old.enabled === true : body.claudeCode.enabled === true,
            command,
            model: String(body.claudeCode.model === undefined ? (old.model || "sonnet") : body.claudeCode.model).trim().slice(0, 200) || "sonnet"
          };
          claudeStatus = null;
          claudeCheckedAt = 0;
        }
        if (body.codingEngine !== undefined) {
          const engine = String(body.codingEngine || "boolean");
          if (!new Set(["boolean", "auto", "codex", "claude-code"]).has(engine)) return json({ error: "invalid_coding_engine" }, 400);
          config.codingEngine = engine;
          config.codex = { ...(config.codex || {}), enabled: engine === "codex" };
          config.claudeCode = { ...(config.claudeCode || {}), enabled: engine === "claude-code" };
        }
        if (body.connectors && typeof body.connectors === "object") config.connectors = mergeConnectors(config.connectors, body.connectors);
        if (typeof body.removeApiConnector === "string") {
          explicitConnectionRemoval = true;
          config.connectors.apis = (config.connectors?.apis || []).filter((x) => x.id !== body.removeApiConnector);
          if (config.customApi?.connectionId === body.removeApiConnector) {
            explicitSecretRemoval = true;
            config.customApi = { connectionId: "", name: "Custom API", baseUrl: "", model: "", apiKey: "", approvedUse: false };
            if (config.provider === "customApi") config.provider = "local";
          }
        }
        if (body.ui && typeof body.ui === "object") { config.ui = { ...config.ui, ...body.ui }; syncWarmEnv(); }
        if (body.acceptEula === true) config.eulaAccepted = "1.0";
        clearProviderModelCache();
        saveConfig(config, {
          preserveSecrets: !explicitSecretRemoval,
          preserveConnections: !explicitConnectionRemoval
        });
        if (restartCodex) await stopCodexClient();
        if (adminCloudVaultEnabled(config)) syncCloudVault(config, { merge: false }).catch(() => {});
        json({ ok: true, accessMode: currentAccessMode(config), autoApprove: config.autoApprove === true });
        return;
      }

      if (req.method === "GET" && p === "/api/claude-code/status") {
        try { json({ ok: true, ...publicClaudeStatus({ refresh: url.searchParams.get("refresh") === "1" }) }); }
        catch (error) { json({ ok: false, error: String(error?.message || error), ...publicClaudeStatus() }, 400); }
        return;
      }

      if (req.method === "POST" && p === "/api/claude-code/install") {
        if (claudeInstallPromise) return json({ ok: false, error: "install_in_progress", message: "Claude Code setup is already running." }, 409);
        claudeInstallPromise = Promise.resolve().then(() => claudeInstaller({ platform: process.platform }));
        try {
          const result = await claudeInstallPromise;
          if (!result?.ok) return json(result, 500);
          config.claudeCode = { ...(config.claudeCode || {}), command: result.command || "claude" };
          saveConfig(config);
          claudeStatus = null;
          const login = claudeLoginStarter(config.claudeCode.command, { platform: process.platform });
          json({ ...result, ...publicClaudeStatus({ refresh: true }), loginStarted: login.ok === true, loginMessage: login.message || "", ok: true });
        } catch (error) {
          json({ ok: false, error: "install_failed", message: `Claude Code setup failed: ${error?.message || error}` }, 500);
        } finally { claudeInstallPromise = null; }
        return;
      }

      if (req.method === "POST" && p === "/api/claude-code/auth/start") {
        const result = claudeLoginStarter(claudeCommand(), { platform: process.platform });
        json(result, result.ok ? 200 : 400);
        return;
      }

      if (req.method === "GET" && p === "/api/codex/status") {
        try {
          if (url.searchParams.get("start") === "1" && !codexInstallPromise) {
            await ensureCodexClient({ refresh: url.searchParams.get("refresh") === "1" });
          }
          json({ ok: true, ...publicCodexStatus() });
        } catch (error) {
          codexCheckedAt = Date.now();
          json({ ok: false, ...publicCodexStatus(), error: codexErrorMessage(error) });
        }
        return;
      }

      if (req.method === "POST" && p === "/api/codex/recheck") {
        if (codexInstallPromise) {
          json({ ok: false, error: "install_in_progress", message: "Codex setup is already running." }, 409);
          return;
        }
        try {
          await ensureCodexClient({ refresh: true });
          json({ ok: true, ...publicCodexStatus() });
        } catch (error) {
          codexCheckedAt = Date.now();
          json({ ok: false, ...publicCodexStatus(), error: codexErrorMessage(error) }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/codex/install") {
        if (codexPlatform !== "win32") {
          json({
            ok: false,
            error: "unsupported_platform",
            message: "Automatic Codex CLI setup is available on Windows only."
          }, 400);
          return;
        }
        if (codexInstallPromise) {
          json({ ok: false, error: "install_in_progress", message: "Codex setup is already running." }, 409);
          return;
        }
        if (codexLoginPending()) {
          json({ ok: false, error: "login_in_progress", message: "Finish or cancel the current Codex sign-in before installing again." }, 409);
          return;
        }
        codexInstallPromise = Promise.resolve().then(() => codexInstaller({ platform: codexPlatform }));
        try {
          const result = await codexInstallPromise;
          if (!result?.ok) {
            const status = result?.error === "install_timeout" ? 504 : result?.error === "unsupported_platform" ? 400 : 500;
            json({
              ok: false,
              error: String(result?.error || "install_failed"),
              message: String(result?.message || "Codex setup did not finish."),
              output: String(result?.output || ""),
              outputTruncated: result?.outputTruncated === true
            }, status);
            return;
          }
          const command = String(result.command || "codex").trim();
          if (!command || command.length > 1024 || /[\r\n\0]/.test(command)) {
            json({ ok: false, error: "install_not_found", message: "Codex was installed, but its executable could not be verified." }, 500);
            return;
          }
          config.codex = { ...(config.codex || {}), command };
          saveConfig(config);
          await stopCodexClient();
          let connectionError = "";
          try { await ensureCodexClient({ refresh: true }); }
          catch (error) { connectionError = codexErrorMessage(error); }
          json({
            ...result,
            ok: true,
            installed: true,
            command,
            message: String(result.message || "Codex CLI installed."),
            ...publicCodexStatus(),
            installing: false,
            connectionError
          });
        } catch (error) {
          json({
            ok: false,
            error: "install_failed",
            message: `Codex setup failed: ${error?.message || error}`
          }, 500);
        } finally {
          codexInstallPromise = null;
        }
        return;
      }

      if (req.method === "POST" && p === "/api/codex/auth/start") {
        if (codexInstallPromise) {
          json({ ok: false, error: "install_in_progress", message: "Codex setup is already running." }, 409);
          return;
        }
        if (codexLoginPending()) {
          json({ ok: false, error: "login_in_progress", message: "Codex sign-in is already open." }, 409);
          return;
        }
        // Acquire the sign-in lease before the first await. Without this lock,
        // two requests can both pass the guard while the app-server is starting.
        const loginAttempt = ++codexLoginGeneration;
        codexLoginStarting = true;
        codexLoginStartedAt = Number(codexNow());
        codexLoginCompletedWhileStarting = "";
        try {
          const client = await ensureCodexClient();
          const result = await client.request("account/login/start", {
            type: "chatgpt",
            useHostedLoginSuccessPage: true,
            appBrand: "codex"
          });
          const loginId = String(result?.loginId || "").trim().slice(0, 200);
          const authUrl = validCodexAuthUrl(result?.authUrl);
          if (loginAttempt !== codexLoginGeneration || !codexLoginStarting) {
            if (loginId) await client.request("account/login/cancel", { loginId }).catch(() => {});
            json({
              ok: false,
              error: "login_expired",
              message: "That Codex sign-in request expired. Start sign-in again."
            }, 409);
            return;
          }
          if (!loginId || !authUrl) {
            clearCodexLogin();
            if (loginId) await client.request("account/login/cancel", { loginId }).catch(() => {});
            json({
              ok: false,
              error: "invalid_auth_url",
              message: "Codex returned an invalid sign-in link. Sign-in was not opened."
            }, 502);
            return;
          }
          const completedBeforeResponse = codexLoginCompletedWhileStarting === "*"
            || codexLoginCompletedWhileStarting === loginId;
          codexLoginStarting = false;
          codexLoginCompletedWhileStarting = "";
          if (completedBeforeResponse) {
            codexLoginId = "";
            codexLoginStartedAt = 0;
          } else {
            codexLoginId = loginId;
            codexLoginStartedAt = Number(codexNow());
          }
          json({ ok: true, loginId, authUrl });
        } catch (error) {
          clearCodexLogin();
          json({ ok: false, error: codexErrorMessage(error) }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/codex/auth/cancel") {
        if (codexInstallPromise) {
          json({ ok: false, error: "install_in_progress", message: "Codex setup is already running." }, 409);
          return;
        }
        try {
          const body = await readBody(req);
          if (codexLoginPending() && codexLoginStarting) {
            json({ ok: false, error: "login_starting", message: "Codex is still preparing the sign-in page." }, 409);
            return;
          }
          const pendingLoginId = activeCodexLoginId();
          if (!pendingLoginId) {
            json({ ok: false, error: "no_pending_login", message: "There is no Codex sign-in to cancel." }, 404);
            return;
          }
          const requestedId = String(body.loginId || pendingLoginId).trim();
          if (requestedId !== pendingLoginId) {
            json({ ok: false, error: "login_mismatch", message: "That Codex sign-in is no longer active." }, 409);
            return;
          }
          const client = await ensureCodexClient();
          await client.request("account/login/cancel", { loginId: pendingLoginId });
          clearCodexLogin();
          json({ ok: true });
        } catch (error) {
          json({ ok: false, error: codexErrorMessage(error) }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/codex/logout") {
        if (codexInstallPromise) {
          json({ ok: false, error: "install_in_progress", message: "Codex setup is already running." }, 409);
          return;
        }
        if (codexLoginPending() && codexLoginStarting) {
          json({ ok: false, error: "login_starting", message: "Codex is still preparing the sign-in page." }, 409);
          return;
        }
        try {
          const client = await ensureCodexClient();
          await client.request("account/logout", {});
          clearCodexLogin();
          codexAccount = null;
          json({ ok: true, ...publicCodexStatus() });
        } catch (error) {
          json({ ok: false, error: codexErrorMessage(error) }, 400);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/settings/reset") {
        config.ui = defaultUiSettings();
        saveConfig(config);
        json({ ok: true, ui: config.ui });
        return;
      }

      // /api/markets/* lives in src/routes/markets.js — see that file for the
      // router contract the remaining groups should follow.
      if (await marketsRoutes({ req, p, url, config, json, readBody, saveConfig, marketAccessAllowed })) return;

      if (req.method === "POST" && p === "/api/local-data/save") {
        saveConfig(config);
        saveThreads([...threads.values()].filter((thread) => !isBlankNewThread(thread)));
        json({
          ok: true,
          savedAt: new Date().toISOString(),
          location: SAZ_DIR
        });
        return;
      }

      if (req.method === "POST" && p === "/api/local-data/backup") {
        saveConfig(config);
        saveThreads([...threads.values()].filter((thread) => !isBlankNewThread(thread)));
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.join(SAZ_DIR, "backups", `manual-${stamp}`);
        const files = [
          "config.json",
          "threads.json",
          "preferences.json",
          "automations.json",
          "automation-runs.json",
          "agent-runs.json",
          "email-cleanup.json",
          "usage.json",
          "system-actions.jsonl"
        ];
        fs.mkdirSync(backupDir, { recursive: true });
        const included = [];
        for (const name of files) {
          const source = path.join(SAZ_DIR, name);
          if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
          fs.copyFileSync(source, path.join(backupDir, name));
          included.push(name);
        }
        fs.writeFileSync(path.join(backupDir, "backup-info.json"), JSON.stringify({
          format: "boolean-local-backup",
          version: 1,
          createdAt: new Date().toISOString(),
          appVersion: APP_VERSION,
          sensitive: true,
          included
        }, null, 2));
        json({ ok: true, location: backupDir, included });
        return;
      }

      if (req.method === "POST" && p === "/api/delete-all-data") {
        const body = await readBody(req);
        if (body.confirm !== "DELETE ALL BOOLLM DATA") {
          json({ ok: false, error: "Type DELETE ALL BOOLLM DATA to confirm." }, 400);
          return;
        }
        for (const thread of threads.values()) {
          try { thread.abort?.abort(); } catch {}
        }
        threads.clear();
        clearThreads();
        clearPreferences();
        clearCookies();
        const fresh = defaultConfig();
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, fresh);
        saveConfig(config, { preserveSecrets: false, preserveConnections: false });
        newThread();
        json({ ok: true, activeThreadId });
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

      if (req.method === "POST" && p === "/api/cloud-hosting/connect") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim();
        if (!["azure", "aws", "googleCloud"].includes(provider)) {
          return json({ ok: false, error: "Choose Azure, AWS, or Google Cloud." }, 400);
        }
        const saved = config.connectors?.[provider] || {};
        const input = body.credentials && typeof body.credentials === "object" ? body.credentials : body;
        try {
          let connection;
          let accounts = [];
          if (provider === "azure") {
            const credentials = {
              tenantId: String(input.tenantId || saved.tenantId || "").trim(),
              clientId: String(input.clientId || saved.clientId || "").trim(),
              clientSecret: input.clientSecret === "__keep__" ? saved.clientSecret : String(input.clientSecret || "").trim(),
              subscriptionId: String(body.accountId || saved.subscriptionId || "").trim()
            };
            const verified = await verifyAzureConnection(credentials);
            accounts = verified.accounts;
            const selected = accounts.find((item) => item.id === credentials.subscriptionId) || verified.selected;
            connection = {
              ...credentials, connected: !!selected,
              subscriptionId: selected?.id || "", subscriptionName: selected?.name || "",
              lastTestedAt: Date.now()
            };
          } else if (provider === "aws") {
            const credentials = {
              accessKeyId: String(input.accessKeyId || saved.accessKeyId || "").trim(),
              secretAccessKey: input.secretAccessKey === "__keep__" ? saved.secretAccessKey : String(input.secretAccessKey || "").trim(),
              sessionToken: input.sessionToken === "__keep__" ? saved.sessionToken : String(input.sessionToken || "").trim(),
              region: String(input.region || saved.region || "us-east-1").trim()
            };
            const verified = await verifyAwsConnection(credentials);
            accounts = [{ id: verified.accountId, name: verified.arn || verified.accountId }];
            connection = { ...credentials, ...verified, connected: true, lastTestedAt: Date.now() };
          } else {
            const rawKey = input.serviceAccount === "__keep__" ? saved.serviceAccount : input.serviceAccount;
            const serviceAccount = typeof rawKey === "string" ? JSON.parse(rawKey) : rawKey;
            const credentials = { serviceAccount, projectId: String(body.accountId || saved.projectId || "").trim() };
            const verified = await verifyGoogleCloudConnection(credentials);
            accounts = verified.accounts;
            const selected = accounts.find((item) => item.id === credentials.projectId) || verified.selected;
            connection = {
              ...credentials, connected: !!selected, projectId: selected?.id || "",
              projectName: selected?.name || "", clientEmail: verified.clientEmail,
              lastTestedAt: Date.now()
            };
          }
          config.connectors = config.connectors || {};
          config.connectors[provider] = connection;
          saveConfig(config);
          return json({
            ok: true, connected: connection.connected, accounts,
            connection: publicConnectors(config, managedEmailOAuthClients)[provider],
            message: connection.connected ? "Cloud account connected." : "Credentials verified. Choose an account."
          });
        } catch (error) {
          return json({ ok: false, error: error.message || "Cloud connection failed." }, 400);
        }
      }

      if (req.method === "POST" && p === "/api/cloud-hosting/disconnect") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim();
        if (!["azure", "aws", "googleCloud"].includes(provider)) return json({ ok: false, error: "Unsupported cloud provider." }, 400);
        config.connectors = config.connectors || {};
        config.connectors[provider] = provider === "azure"
          ? { tenantId: "", clientId: "", clientSecret: "", connected: false, subscriptionId: "", subscriptionName: "", lastTestedAt: 0 }
          : provider === "aws"
            ? { accessKeyId: "", secretAccessKey: "", sessionToken: "", region: "us-east-1", connected: false, accountId: "", arn: "", lastTestedAt: 0 }
            : { serviceAccount: null, connected: false, projectId: "", projectName: "", clientEmail: "", lastTestedAt: 0 };
        saveConfig(config, { preserveSecrets: false });
        return json({ ok: true, connection: publicConnectors(config, managedEmailOAuthClients)[provider] });
      }

      if (req.method === "GET" && p === "/api/cloud-hosting/resources") {
        const provider = String(url.searchParams.get("provider") || "").trim();
        const kind = String(url.searchParams.get("kind") || "").trim();
        const connection = config.connectors?.[provider];
        if (!connection?.connected) return json({ ok: false, error: "Connect this cloud provider in Settings first." }, 400);
        try {
          const result = provider === "azure"
            ? await azureResourceList(connection, kind || "resources")
            : provider === "aws"
              ? await awsResourceList(connection, kind || "amplify")
              : await googleCloudResourceList(connection, kind || "projects");
          return json({ ok: true, provider, kind, resources: result });
        } catch (error) {
          return json({ ok: false, error: error.message || "Could not load cloud resources." }, 400);
        }
      }

      if (req.method === "POST" && p === "/api/cloudflare/connect") {
        const body = await readBody(req);
        const saved = config.connectors?.cloudflare || {};
        const token = String(body.token || "").trim() === "__keep__"
          ? String(saved.token || "")
          : String(body.token || "").trim();
        // A Global API Key is account-wide and authenticates with the account
        // email, so it needs both fields and a different verify path.
        const globalKey = String(body.authType || "").trim() === "global"
          || (!!String(body.email || "").trim() && !body.authType);
        const email = String(body.email || "").trim() === "__keep__"
          ? String(saved.email || "")
          : String(body.email || "").trim();
        if (!token) {
          return json({ ok: false, error: globalKey ? "Paste your Cloudflare Global API Key." : "Paste a Cloudflare API token." }, 400);
        }
        if (globalKey && !email) {
          return json({ ok: false, error: "Enter the Cloudflare account email that owns this Global API Key." }, 400);
        }
        try {
          const verified = globalKey
            ? await verifyCloudflareGlobalKey(email, token)
            : await verifyCloudflareToken(token);
          const requestedAccountId = String(body.accountId || "").trim();
          const selected = verified.accounts.find((account) => account.id === requestedAccountId)
            || (verified.accounts.length === 1 ? verified.accounts[0] : null);
          config.connectors = config.connectors || {};
          config.connectors.cloudflare = {
            token,
            email: globalKey ? email : "",
            authType: globalKey ? "global" : "token",
            fullAccess: saved.fullAccess === true,
            oauthClientId: saved.oauthClientId || "",
            oauthRedirectUri: saved.oauthRedirectUri || "https://boollm.com/oauth/cloudflare/callback",
            oauthScopes: Array.isArray(saved.oauthScopes) ? saved.oauthScopes : [],
            oauth: null,
            connected: !!selected,
            accountId: selected?.id || "",
            accountName: selected?.name || "",
            tokenId: verified.tokenId,
            status: verified.status,
            expiresOn: verified.expiresOn,
            lastTestedAt: Date.now()
          };
          saveConfig(config);
          return json({
            ok: true,
            connected: !!selected,
            accounts: verified.accounts,
            cloudflare: publicConnectors(config, managedEmailOAuthClients).cloudflare,
            message: selected ? `${selected.name} is connected.` : "Token verified. Choose an account."
          });
        } catch (error) {
          return json({ ok: false, error: error.message || "Cloudflare connection failed." }, 400);
        }
      }

      if (p.startsWith("/api/trading/") && !adminFeatureAccessAllowed(config)) {
        return json({ ok: false, error: "Trading is available only to Boollm administrators." }, 403);
      }

      if (req.method === "GET" && p === "/api/trading/state") {
        const g = config.connectors?.trading || {};
        const bp = config.ui?.browserPerms || {};
        const user = String(config.cloudBackend?.user?.email || config.cloudBackend?.user?.id || "").trim().toLowerCase();
        const ledger = currentTradeState(SAZ_DIR);
        return json({
          armed: tradeConsentActive(config),
          // Consent was given, but the arming window has lapsed — the bar offers a re-arm.
          armLapsed: !!user && bp.tradeClicks === true
            && String(bp.tradeConsentUser || "").trim().toLowerCase() === user
            && !tradeConsentActive(config),
          armExpiresAt: armExpiresAt(config),
          armWindowMinutes: Math.round(armWindowMs(g) / 60_000),
          enabled: g.enabled === true,
          killSwitch: g.killSwitch === true,
          maxOrdersPerDay: Number(g.maxOrdersPerDay) || 0,
          dailyLossCapUsd: Number(g.dailyLossCapUsd) || 0,
          maxNotionalUsd: Number(g.maxNotionalUsd) || 0,
          maxRiskPerTradeUsd: Number(g.maxRiskPerTradeUsd) || 0,
          symbolAllowlist: Array.isArray(g.symbolAllowlist) ? g.symbolAllowlist : [],
          strategy: normalizeTradingStrategy(g.strategy),
          // Which control on the broker's own order form each ticket value goes
          // into. Broker forms differ, so this is configurable; the bar falls
          // back to sensible labels when a key is unset.
          ticketFields: normalizeTicketFields(g.ticketFields),
          ticketDefaults: normalizeTicketDefaults(g.ticketDefaults),
          browserSymbol: extractTradingSymbolFromUrl(browserUrl, browserTitle),
          ordersToday: ledger.ordersToday,
          realizedLossUsd: ledger.realizedLossUsd,
          lastAction: ledger.lastAction || null
        });
      }

      if (req.method === "GET" && p === "/api/trading/broker") {
        const refresh = url.searchParams.get("refresh") === "1";
        const connector = String(url.searchParams.get("connector") || "").trim();
        return json(await brokerSnapshotCached({ refresh, connector }));
      }

      if (req.method === "GET" && p === "/api/trading/adapters") {
        return json({
          ok: true,
          selected: String(config.connectors?.trading?.broker || config.connectors?.trading?.pnl?.connector || ""),
          adapters: tradingAdapterCatalog(config)
        });
      }

      if (req.method === "POST" && p === "/api/trading/settings") {
        const body = await readBody(req);
        config.connectors = config.connectors || {};
        const g = { ...(config.connectors.trading || {}) };
        if ("broker" in body) g.broker = String(body.broker || "").trim();
        if ("killSwitch" in body) g.killSwitch = body.killSwitch === true;
        if ("enabled" in body) g.enabled = body.enabled === true;
        if ("maxOrdersPerDay" in body) g.maxOrdersPerDay = Math.max(0, Number(body.maxOrdersPerDay) || 0);
        if ("dailyLossCapUsd" in body) g.dailyLossCapUsd = Math.min(100_000_000, Math.max(0, Math.round((Number(body.dailyLossCapUsd) || 0) * 100) / 100));
        if ("maxNotionalUsd" in body) g.maxNotionalUsd = Math.max(0, Number(body.maxNotionalUsd) || 0);
        if ("maxRiskPerTradeUsd" in body) g.maxRiskPerTradeUsd = Math.min(100_000_000, Math.max(0, Math.round((Number(body.maxRiskPerTradeUsd) || 0) * 100) / 100));
        if ("armWindowMinutes" in body) g.armWindowMinutes = Math.max(0, Number(body.armWindowMinutes) || 0);
        if (Array.isArray(body.symbolAllowlist)) g.symbolAllowlist = body.symbolAllowlist.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean);
        if (body.strategy && typeof body.strategy === "object") {
          g.strategy = normalizeTradingStrategy({ ...(g.strategy || {}), ...body.strategy });
        }
        if (body.ticketFields && typeof body.ticketFields === "object") {
          g.ticketFields = normalizeTicketFields({ ...(g.ticketFields || {}), ...body.ticketFields });
        }
        if (body.ticketDefaults && typeof body.ticketDefaults === "object") {
          g.ticketDefaults = normalizeTicketDefaults({ ...(g.ticketDefaults || {}), ...body.ticketDefaults });
        }
        config.connectors.trading = g;
        saveConfig(config);
        const ledger = currentTradeState(SAZ_DIR);
        return json({ ok: true, killSwitch: g.killSwitch === true, enabled: g.enabled === true,
          maxOrdersPerDay: g.maxOrdersPerDay || 0, dailyLossCapUsd: g.dailyLossCapUsd || 0,
          maxRiskPerTradeUsd: g.maxRiskPerTradeUsd || 0,
          strategy: normalizeTradingStrategy(g.strategy),
          ordersToday: ledger.ordersToday, realizedLossUsd: ledger.realizedLossUsd });
      }

      // What the strategies actually did. Read-only history of resolved
      // signals; none of these were auto-traded, so this measures the ideas,
      // not the account.
      if (req.method === "GET" && p === "/api/trading/signals") {
        return json({ ok: true, stats: signalStats(SAZ_DIR) });
      }

      if (req.method === "POST" && p === "/api/trading/signals") {
        const body = await readBody(req);
        const result = recordSignalOutcomes(SAZ_DIR, Array.isArray(body.outcomes) ? body.outcomes : []);
        return json({ ok: true, ...result });
      }

      // Price a trading-bar ticket against the guard. Read-only: it evaluates
      // and reports, and never types, clicks, or places anything. The bar calls
      // it as the ticket is edited so a blocked order says why before the user
      // reaches for Send.
      if (req.method === "POST" && p === "/api/trading/ticket/check") {
        const body = await readBody(req);
        const g = config.connectors?.trading || {};
        // The ticket rides the confirmed-click permission, which has its own
        // on/off switch, so the guard's master `enabled` gate is skipped here
        // exactly as it is for visible_browser_trade. Caps and kill-switch stay.
        const verdict = evaluateTradeGuard(g, {
          symbol: body.symbol,
          side: body.side,
          quantity: body.quantity,
          // The guard owns which order types exist and which prices each needs,
          // so the ticket's choice is passed through rather than flattened.
          orderType: body.orderType,
          timeInForce: body.timeInForce,
          limitPrice: Number(body.limitPrice) || 0,
          triggerPrice: Number(body.triggerPrice) || 0,
          trailAmount: Number(body.trailAmount) || 0,
          referencePrice: Number(body.referencePrice) || 0,
          stopPrice: Number(body.stopPrice) || 0,
          targetPrice: Number(body.targetPrice) || 0,
          reducesPosition: body.reducesPosition === true
        }, currentTradeState(SAZ_DIR), { skipEnabled: true });
        const clicks = tradeClickPermission(config);
        return json({
          ok: true,
          allowed: verdict.allowed,
          reason: verdict.reason,
          order: verdict.order,
          armed: clicks.armed,
          identityOk: clicks.identityOk,
          tradeClicks: clicks.tradeClicks,
          canSend: verdict.allowed && clicks.canClick,
          sendBlockedReason: clicks.reason
        });
      }

      // Whether a working order may be cancelled from the bar.
      //
      // Deliberately NOT gated on the kill-switch or the risk caps. Those exist
      // to stop new exposure, and a resting order is exposure — refusing to
      // cancel while halted would trap the user in the very thing the halt was
      // meant to escape. The click consent still applies: this drives the
      // broker page, so it needs the same permission every other click does.
      if (req.method === "GET" && p === "/api/trading/cancel/check") {
        const clicks = tradeClickPermission(config);
        return json({ ok: true, ...clicks, canCancel: clicks.canClick, blockedReason: clicks.reason });
      }

      // Count an order the user actually sent from the ticket, so the daily
      // order cap sees bar-placed orders the same way it sees agent-placed
      // ones. Mirrors the tools.js rule: only touch the ledger when a cap is
      // configured, so cap-free setups do no file IO.
      if (req.method === "POST" && p === "/api/trading/ticket/placed") {
        const body = await readBody(req);
        const g = config.connectors?.trading || {};
        if ((Number(g.maxOrdersPerDay) || 0) > 0) {
          recordTradePlacement(SAZ_DIR, {
            symbol: String(body.symbol || "").trim().toUpperCase(),
            side: String(body.side || "").trim().toLowerCase()
          });
        }
        const ledger = currentTradeState(SAZ_DIR);
        return json({ ok: true, ordersToday: ledger.ordersToday, realizedLossUsd: ledger.realizedLossUsd });
      }

      if (req.method === "POST" && p === "/api/cloudflare/full-access") {
        const body = await readBody(req);
        config.connectors = config.connectors || {};
        const saved = config.connectors.cloudflare || {};
        if (!saved.connected || !saved.token) {
          return json({ ok: false, error: "Connect Cloudflare first, then enable Full access." }, 400);
        }
        config.connectors.cloudflare = { ...saved, fullAccess: body.enabled === true };
        saveConfig(config);
        return json({ ok: true, cloudflare: publicConnectors(config, managedEmailOAuthClients).cloudflare });
      }

      if (req.method === "POST" && p === "/api/cloudflare/oauth/start") {
        const body = await readBody(req);
        const saved = config.connectors?.cloudflare || {};
        const clientId = String(body.clientId || saved.oauthClientId || "").trim();
        const redirectUri = String(body.redirectUri || saved.oauthRedirectUri || "https://boollm.com/oauth/cloudflare/callback").trim();
        const scopes = Array.isArray(body.scopes)
          ? body.scopes
          : String(body.scopes || "").split(/[\s,]+/).filter(Boolean);
        try {
          const transaction = createCloudflareOAuth(clientId, redirectUri, scopes);
          const localCallbackUrl = `http://${req.headers.host}/cloudflare/oauth/callback`;
          const relayState = `${transaction.state}.${Buffer.from(localCallbackUrl).toString("base64url")}`;
          transaction.state = relayState;
          const authorizationUrl = new URL(transaction.authorizationUrl);
          authorizationUrl.searchParams.set("state", relayState);
          transaction.authorizationUrl = authorizationUrl.toString();
          pendingCloudflareOAuth.set(transaction.state, { ...transaction, status: "pending" });
          for (const [key, value] of pendingCloudflareOAuth) {
            if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingCloudflareOAuth.delete(key);
          }
          config.connectors = config.connectors || {};
          config.connectors.cloudflare = {
            ...saved,
            oauthClientId: clientId,
            oauthRedirectUri: redirectUri,
            oauthScopes: transaction.scopes
          };
          saveConfig(config);
          return json({
            ok: true,
            state: transaction.state,
            authorizationUrl: transaction.authorizationUrl,
            redirectUri,
            localCallbackUrl
          });
        } catch (error) {
          return json({ ok: false, error: error.message || "Could not start Cloudflare authorization." }, 400);
        }
      }

      if (req.method === "GET" && p === "/api/cloudflare/oauth/status") {
        const state = url.searchParams.get("state") || "";
        const transaction = pendingCloudflareOAuth.get(state);
        if (!transaction) return json({ status: "expired" }, 404);
        return json({
          status: transaction.status,
          error: transaction.error || "",
          accounts: Array.isArray(transaction.accounts) ? transaction.accounts : [],
          cloudflare: transaction.status === "complete"
            ? publicConnectors(config, managedEmailOAuthClients).cloudflare
            : undefined
        });
      }

      if (req.method === "GET" && p === "/cloudflare/oauth/callback") {
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const oauthError = url.searchParams.get("error") || "";
        const transaction = pendingCloudflareOAuth.get(state);
        if (!transaction || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization expired", "Return to Boollm and connect Cloudflare again.", false));
          return;
        }
        if (oauthError || !code) {
          transaction.status = "error";
          transaction.error = oauthError || "Cloudflare did not return an authorization code.";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization canceled", "No Cloudflare access was saved.", false));
          return;
        }
        try {
          const oauth = await exchangeCloudflareOAuthCode(transaction, code);
          const verified = await verifyCloudflareOAuthToken(oauth.accessToken);
          const selected = verified.accounts.length === 1 ? verified.accounts[0] : null;
          const saved = config.connectors?.cloudflare || {};
          config.connectors.cloudflare = {
            ...saved,
            token: oauth.accessToken,
            authType: "oauth",
            oauth,
            oauthClientId: transaction.clientId,
            oauthRedirectUri: transaction.redirectUri,
            oauthScopes: transaction.scopes,
            connected: !!selected,
            accountId: selected?.id || "",
            accountName: selected?.name || "",
            tokenId: verified.tokenId,
            status: verified.status,
            expiresOn: verified.expiresOn,
            lastTestedAt: Date.now()
          };
          saveConfig(config);
          transaction.status = "complete";
          transaction.accounts = verified.accounts;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Cloudflare connected", selected
            ? `${selected.name} is ready in Boollm. This window will close.`
            : "Cloudflare approved access. Return to Boollm and choose an account.", true));
        } catch (error) {
          transaction.status = "error";
          transaction.error = error.message || "Cloudflare authorization failed.";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Could not connect Cloudflare", transaction.error, false));
        }
        return;
      }

      if (req.method === "POST" && p === "/api/cloudflare/disconnect") {
        config.connectors = config.connectors || {};
        config.connectors.cloudflare = {
          token: "", connected: false, accountId: "", accountName: "",
          tokenId: "", status: "", expiresOn: "", lastTestedAt: 0,
          authType: "", oauthClientId: "", oauthRedirectUri: "https://boollm.com/oauth/cloudflare/callback",
          oauthScopes: [], oauth: null
        };
        saveConfig(config, { preserveSecrets: false });
        return json({ ok: true, cloudflare: publicConnectors(config, managedEmailOAuthClients).cloudflare });
      }

      if (req.method === "GET" && p === "/api/cloudflare/resources") {
        const connection = config.connectors?.cloudflare;
        if (!connection?.connected || !connection?.token) {
          return json({ ok: false, error: "Connect Cloudflare in Settings first." }, 400);
        }
        const kind = String(url.searchParams.get("kind") || "zones").toLowerCase();
        try {
          const payload = await cloudflareResourceList(connection, kind);
          return json({ ok: true, kind, result: payload.result || [], resultInfo: payload.result_info || null });
        } catch (error) {
          return json({ ok: false, error: error.message || "Could not load Cloudflare resources." }, 400);
        }
      }

      if (req.method === "POST" && p === "/api/mcp/connect") {
        const body = await readBody(req);
        const mcpUrl = String(body.url || "").trim();
        const name = cleanConnectorName(body.name) || (mcpUrl.includes("robinhood.com") ? "Robinhood Trading" : "MCP server");
        const token = typeof body.token === "string" ? body.token.trim() : "";
        if (!/^https?:\/\//i.test(mcpUrl)) return json({ ok: false, error: "Enter a valid http(s) MCP URL" }, 400);
        const existing = (config.connectors?.mcp || []).find((item) => item.id === body.id || item.url === mcpUrl);
        const connector = {
          ...(existing || {}),
          id: existing?.id || String(body.id || crypto.randomUUID()),
          name,
          type: "remote",
          url: mcpUrl,
          token: token || existing?.token || "",
          oauth: existing?.oauth || null,
          enabled: true
        };
        try {
          const result = await testMcpConnector(connector);
          saveMcpConnector({
            ...connector,
            toolCount: result.toolCount,
            tools: result.tools.map((tool) => tool.name).filter(Boolean).slice(0, 50),
            lastTestedAt: Date.now(),
            lastTestStatus: "ok",
            lastError: "",
            needsReconnect: false
          });
          return json({ ok: true, connected: true, connectorId: connector.id, ...result,
            tools: result.tools.map((tool) => tool.name).filter(Boolean) });
        } catch (err) {
          if (!(err instanceof McpHttpError) || err.status !== 401 || token) {
            const status = err?.mcpStatus || classifyMcpError(err, connector);
            saveMcpConnector({
              ...connector,
              toolCount: 0,
              tools: [],
              lastTestedAt: Date.now(),
              lastTestStatus: "error",
              lastError: err.message || "connection failed",
              needsReconnect: true
            });
            return json({ ok: false, error: err.message || "connection failed",
              connectorId: connector.id, ...mcpStatusPayload(status) });
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
            saveMcpConnector({
              ...connector,
              toolCount: 0,
              tools: [],
              lastTestedAt: Date.now(),
              lastTestStatus: "error",
              lastError: oauthError.message || "could not start authorization",
              needsReconnect: true
            });
            return json({ ok: false, error: oauthError.message || "could not start authorization",
              connectorId: connector.id, ...mcpStatusPayload(classifyMcpError(oauthError, connector)) });
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
          res.end(oauthResultPage("Authorization expired", "Return to Boollm and try connecting again.", false));
          return;
        }
        if (oauthError || !code) {
          transaction.status = "error";
          transaction.error = oauthError || "Robinhood did not return an authorization code.";
          saveMcpConnector({
            ...transaction.connector,
            lastTestedAt: Date.now(),
            lastTestStatus: "error",
            lastError: transaction.error,
            needsReconnect: true
          });
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization canceled", "No changes were made. You can return to Boollm.", false));
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
            lastTestedAt: Date.now(),
            lastTestStatus: "ok",
            lastError: "",
            needsReconnect: false
          });
          transaction.status = "complete";
          transaction.connectorId = connector.id;
          transaction.serverName = result.serverName || connector.name;
          transaction.toolCount = result.toolCount;
          transaction.tools = result.tools.map((tool) => tool.name).filter(Boolean);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Connected", `${connector.name} is ready in Boollm. This window will close.`, true));
        } catch (err) {
          transaction.status = "error";
          transaction.error = err.message || "authorization failed";
          saveMcpConnector({
            ...transaction.connector,
            lastTestedAt: Date.now(),
            lastTestStatus: "error",
            lastError: transaction.error,
            needsReconnect: true
          });
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Could not connect", "Return to Boollm and try again.", false));
        }
        return;
      }

      if (req.method === "POST" && p === "/api/email/oauth/start") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!['gmail', 'outlook'].includes(provider)) return json({ error: "unsupported email provider" }, 400);
        const mode = body.mode === "manual" ? "manual" : "managed";
        const saved = config.connectors?.email?.[provider] || {};
        const savedManualClientId = String(saved.manualClientId || (saved.clientSource !== "managed" ? saved.clientId : "") || "").trim();
        const savedClientId = String(saved.clientId || "").trim();
        const submittedClientId = String(body.clientId || "").trim();
        const savedManualClientSecret = String(saved.manualClientSecret || "").trim();
        const submittedClientSecret = String(body.clientSecret || "").trim();
        const managedCredential = managedEmailOAuthCredential(managedEmailOAuthClients, provider);
        const clientId = mode === "managed"
          ? String(managedCredential.clientId || (saved.clientSource === "managed" ? saved.clientId : "") || "").trim()
          : (submittedClientId || savedManualClientId || savedClientId);
        const clientSecret = mode === "managed"
          ? String(managedCredential.clientSecret || saved.oauth?.clientSecret || "").trim()
          : (submittedClientSecret || savedManualClientSecret);
        if (!clientId) {
          const label = provider === "gmail" ? "Google" : "Microsoft";
          return json({
            error: mode === "managed"
              ? `${label} sign-in is not provisioned in this Boollm build. Open Advanced setup to add a public client ID.`
              : `Enter the ${label} OAuth public client ID first.`,
            code: "email_oauth_setup_required",
            provider,
            managedAvailable: !!managedCredential.clientId && (provider !== "gmail" || !!managedCredential.clientSecret)
          }, 400);
        }
        if (provider === "gmail" && !isValidGmailOAuthClientId(clientId)) {
          return json({
            error: "The Google OAuth client ID is invalid. Paste the Desktop client ID ending in .apps.googleusercontent.com, not the GOCSPX client secret.",
            code: "email_oauth_invalid_client_id",
            provider,
            managedAvailable: false
          }, 400);
        }
        if (provider === "gmail" && !clientSecret) {
          return json({
            error: mode === "managed"
              ? "Google sign-in is missing its paired Desktop OAuth client secret. Open Advanced setup and add the client ID and client secret."
              : "Enter the Google Desktop OAuth client secret paired with this client ID.",
            code: "email_oauth_setup_required",
            provider,
            managedAvailable: false
          }, 400);
        }
        const redirectUri = emailOAuthRedirectUri(provider, req.headers.host);
        const transaction = createEmailOAuth(provider, clientId, redirectUri, { clientSecret });
        const manualClientId = mode === "manual" ? clientId : savedManualClientId;
        const manualClientSecret = mode === "manual" ? clientSecret : savedManualClientSecret;
        pendingEmailOAuth.set(transaction.state, {
          ...transaction, clientId, clientSource: mode, manualClientId, manualClientSecret, status: "pending"
        });
        for (const [key, value] of pendingEmailOAuth) {
          if (Date.now() - value.createdAt > 10 * 60 * 1000) pendingEmailOAuth.delete(key);
        }
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        config.connectors.email[provider] = {
          ...saved, clientId, manualClientId, manualClientSecret, clientSource: mode
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

      if (req.method === "GET" && (p === "/email/oauth/callback" || emailOAuthCallbackRequest)) {
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const oauthError = url.searchParams.get("error") || "";
        const transaction = pendingEmailOAuth.get(state);
        if (!transaction || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Authorization expired", "Return to Boollm and connect the email account again.", false));
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
          if (transaction.clientSecret) oauth.clientSecret = transaction.clientSecret;
          config.connectors = config.connectors || {};
          config.connectors.email = config.connectors.email || {};
          const previousConnection = config.connectors.email[transaction.provider] || {};
          const connection = {
            ...previousConnection,
            clientId: transaction.clientId,
            manualClientId: transaction.manualClientId || previousConnection.manualClientId || "",
            manualClientSecret: transaction.manualClientSecret || previousConnection.manualClientSecret || "",
            clientSource: transaction.clientSource || "manual",
            connected: true,
            oauth,
            needsReconnect: false,
            lastCheckStatus: "ok",
            lastCheckedAt: Date.now()
          };
          try {
            connection.account = await getEmailAccount(transaction.provider, connection, () => saveConfig(config));
          } catch (err) {
            throw err;
          }
          connection.id = emailAccountId(transaction.provider, connection.account);
          connection.provider = transaction.provider;
          const accounts = savedEmailAccounts(config).filter((row) =>
            row.id !== connection.id &&
            !(row.provider === connection.provider && String(row.account || "").toLowerCase() === String(connection.account).toLowerCase())
          );
          accounts.push(connection);
          config.connectors.email.accounts = accounts;
          // Keep the provider slot as an OAuth setup template for older configs/UI,
          // but account tokens live only in the account collection.
          config.connectors.email[transaction.provider] = {
            ...previousConnection,
            clientId: connection.clientId,
            manualClientId: connection.manualClientId,
            manualClientSecret: connection.manualClientSecret,
            clientSource: connection.clientSource,
            connected: false,
            account: "",
            oauth: null
          };
          saveConfig(config);
          transaction.status = "complete";
          transaction.account = connection.account;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Email connected", `${connection.account} is ready in Boollm. This window will close.`, true));
        } catch (err) {
          transaction.status = "error";
          transaction.error = err.message || "authorization failed";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(oauthResultPage("Could not connect email", `${transaction.error}. Return to Boollm and check the OAuth client settings.`, false));
        }
        return;
      }

      if (req.method === "POST" && p === "/api/email/disconnect") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!['gmail', 'outlook'].includes(provider)) return json({ error: "unsupported email provider" }, 400);
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        const accountId = String(body.accountId || "").trim().toLowerCase();
        if (accountId) {
          const before = savedEmailAccounts(config);
          const after = before.filter((row) => String(row.id || "").toLowerCase() !== accountId);
          if (after.length === before.length) return json({ error: "email account not found" }, 404);
          config.connectors.email.accounts = after;
          saveConfig(config, { preserveSecrets: false, preserveConnections: false });
          return json({ ok: true, email: publicEmailConnections(config, managedEmailOAuthClients) });
        }
        const previous = config.connectors.email[provider] || {};
        const manualClientId = String(previous.manualClientId || (previous.clientSource !== "managed" ? previous.clientId : "") || "").trim();
        config.connectors.email[provider] = {
          clientId: previous.clientSource === "manual" ? manualClientId : "",
          manualClientId,
          manualClientSecret: "",
          clientSource: previous.clientSource === "manual" ? "manual" : "",
          connected: false,
          account: "",
          oauth: null,
          needsReconnect: false,
          lastCheckStatus: "",
          lastCheckedAt: 0
        };
        saveConfig(config, { preserveSecrets: false, preserveConnections: false });
        return json({ ok: true, email: publicEmailConnections(config, managedEmailOAuthClients) });
      }

      if (req.method === "POST" && p === "/api/email/test") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!['gmail', 'outlook'].includes(provider)) return json({ error: "unsupported email provider" }, 400);
        const accountId = String(body.accountId || "").trim().toLowerCase();
        const connection = accountId
          ? savedEmailAccounts(config).find((row) => String(row.id || "").toLowerCase() === accountId && row.provider === provider)
          : savedEmailAccounts(config).filter((row) => row.provider === provider)[0];
        if (!connection?.connected || !connection.oauth) {
          return json({ error: "Connect this email account first.", code: "email_not_connected" }, 400);
        }
        try {
          connection.account = await getEmailAccount(provider, connection, () => saveConfig(config));
          connection.needsReconnect = false;
          connection.lastCheckStatus = "ok";
          connection.lastCheckedAt = Date.now();
          saveConfig(config);
          return json({ ok: true, account: connection.account, email: publicEmailConnections(config, managedEmailOAuthClients) });
        } catch (err) {
          const message = String(err?.message || "Email connection test failed.").slice(0, 240);
          connection.lastCheckStatus = "error";
          connection.lastCheckedAt = Date.now();
          connection.needsReconnect = /(?:401|403|unauthori[sz]ed|forbidden|invalid_grant|insufficient_scope|expired|reconnect|access token|authorization)/i.test(message);
          saveConfig(config);
          return json({
            error: connection.needsReconnect ? "This email connection needs to be reconnected." : message,
            code: connection.needsReconnect ? "email_reconnect_required" : "email_test_failed"
          }, 400);
        }
      }

      if (req.method === "POST" && p === "/api/email/settings") {
        const body = await readBody(req);
        config.connectors = config.connectors || {};
        config.connectors.email = config.connectors.email || {};
        config.connectors.email.draftOnly = body.draftOnly !== false;
        config.connectors.email.confirmBeforeSend = true;
        saveConfig(config);
        return json({ ok: true, email: publicEmailConnections(config, managedEmailOAuthClients) });
      }

      if (req.method === "POST" && p === "/api/email/draft") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        const accountId = String(body.accountId || "").trim();
        const to = String(body.to || "").trim();
        const subject = String(body.subject || "").trim().slice(0, 240);
        const text = String(body.text || "").trim().slice(0, 50000);
        const attachment = body.attachment?.data ? {
          name: String(body.attachment.name || "attachment").replace(/[\r\n"]/g, "").slice(0, 120),
          type: String(body.attachment.type || "application/octet-stream").slice(0, 120),
          data: String(body.attachment.data || "").replace(/\s+/g, ""),
          inline: body.attachment.inline === true
        } : null;
        if (!["gmail", "outlook"].includes(provider)) return json({ error: "Choose a connected Gmail or Outlook account." }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "Enter a valid recipient email address." }, 400);
        if (!subject || !text) return json({ error: "The email needs a subject and message." }, 400);
        try {
          if (attachment && Buffer.byteLength(attachment.data, "base64") > 5 * 1024 * 1024) return json({ error: "Attachments must be 5 MB or smaller." }, 400);
          const result = await executeTool("email_create_draft", {
            provider,
            account_id: accountId,
            to,
            subject,
            text,
            attachment
          }, { config });
          return json({ ok: true, message: String(result || "Email draft created.") });
        } catch (err) {
          return json({ error: String(err?.message || "Could not create the email draft.").slice(0, 240) }, 400);
        }
      }

      if (req.method === "POST" && p === "/api/email/batch-drafts") {
        const body = await readBody(req);
        const provider = String(body.provider || "").trim().toLowerCase();
        const accountId = String(body.accountId || "").trim();
        const drafts = Array.isArray(body.drafts) ? body.drafts.slice(0, 50) : [];
        const attachment = body.attachment?.data ? {
          name: String(body.attachment.name || "attachment").replace(/[\r\n"]/g, "").slice(0, 120),
          type: String(body.attachment.type || "application/octet-stream").slice(0, 120),
          data: String(body.attachment.data || "").replace(/\s+/g, ""),
          inline: body.attachment.inline === true
        } : null;
        if (!["gmail", "outlook"].includes(provider)) return json({ error: "Choose a connected Gmail or Outlook account." }, 400);
        if (!drafts.length) return json({ error: "Add at least one valid recipient." }, 400);
        if (attachment && Buffer.byteLength(attachment.data, "base64") > 5 * 1024 * 1024) return json({ error: "Attachments must be 5 MB or smaller." }, 400);
        const unique = new Set(),valid = [];
        for (const draft of drafts) {
          const to = String(draft?.to || "").trim().toLowerCase();
          const subject = String(draft?.subject || "").trim().slice(0, 240);
          const text = String(draft?.text || "").trim().slice(0, 50000);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || unique.has(to) || !subject || !text) continue;
          unique.add(to);valid.push({ to, subject, text });
        }
        if (!valid.length) return json({ error: "No valid, unique recipients were found." }, 400);
        const created = [],failed = [];
        for (const draft of valid) {
          try {
            await executeTool("email_create_draft", { provider, account_id: accountId, ...draft, attachment }, { config });
            created.push(draft.to);
          } catch (err) {
            failed.push({ to: draft.to, error: String(err?.message || "Draft failed").slice(0, 160) });
          }
        }
        return json({ ok: created.length > 0, created: created.length, failed, total: valid.length });
      }

      if (req.method === "POST" && p === "/api/sales/plan-pdf") {
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        const body = contentType.includes("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(await readRawBody(req)))
          : await readBody(req);
        const title = String(body.title || "Prospect plan").trim().slice(0, 160);
        const raw = String(body.content || "").trim().slice(0, 180000);
        if (!raw) return json({ error: "This prospect plan has no content to export." }, 400);
        const content = raw
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\*\*/g, "")
          .replace(/^>\s?/gm, "")
          .replace(/^---+\s*$/gm, "")
          .replace(/\{\{([^{}]+)\}\}/g, "[$1]");
        const pdf = simplePdf(title, content);
        const filename = `${title.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "prospect-plan"}.pdf`;
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": pdf.length,
          "content-disposition": `inline; filename="${filename}"`,
          "cache-control": "no-store"
        });
        res.end(pdf);
        return;
      }

      if (req.method === "POST" && p === "/api/mcp/test") {
        const body = await readBody(req);
        let url = String(body.url || "").trim();
        let token = typeof body.token === "string" ? body.token.trim() : "";
        let connector = { url, token };
        let saved = null;
        // testing a saved server by id: fall back to its stored url/token
        if (body.id) {
          saved = (config.connectors?.mcp || []).find((x) => x.id === body.id) || null;
          if (saved) connector = saved;
        }
        try {
          const result = await testMcpConnector(connector, { onRefresh: () => saveConfig(config) });
          if (saved) {
            Object.assign(saved, {
              toolCount: result.toolCount,
              tools: result.tools.map((tool) => tool.name).filter(Boolean).slice(0, 50),
              lastTestedAt: Date.now(),
              lastTestStatus: "ok",
              lastError: "",
              needsReconnect: false
            });
            saveConfig(config);
          }
          json({ ok: true, ...result, tools: result.tools.map((tool) => tool.name).filter(Boolean) });
        } catch (err) {
          const status = err?.mcpStatus || classifyMcpError(err, connector);
          if (saved) {
            Object.assign(saved, {
              toolCount: 0,
              tools: [],
              lastTestedAt: Date.now(),
              lastTestStatus: "error",
              lastError: err.message || "connection failed",
              needsReconnect: true
            });
            saveConfig(config);
          }
          json({ ok: false, error: err.message || "connection failed",
            ...mcpStatusPayload(status) });
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

      if (req.method === "POST" && p === "/api/models/benchmark") {
        const body = await readBody(req);
        const file = String(body.file || body.model || "").trim();
        if (!file || !engine.listLocalModels().includes(file)) {
          json({ error: "installed local model not found" }, 404);
          return;
        }
        try {
          const benchmarkConfig = {
            ...config,
            provider: "local",
            local: { ...(config.local || {}), model: file }
          };
          const started = performance.now();
          let firstTokenAt = 0;
          const target = await resolveTarget(benchmarkConfig);
          const answer = await chatCompletion(target, [
            { role: "system", content: "Follow the requested output format exactly." },
            { role: "user", content: "Write the numbers 1 through 32 separated by single spaces and nothing else." }
          ], undefined, undefined, () => {
            if (!firstTokenAt) firstTokenAt = performance.now();
          });
          const finished = performance.now();
          const output = Number(answer?.usage?.output) || Math.max(1, Math.ceil(String(answer?.content || "").length / 4));
          const generationMs = Math.max(1, finished - (firstTokenAt || started));
          json({
            ok: true,
            file,
            tps: output / (generationMs / 1000),
            firstTokenMs: Math.max(1, (firstTokenAt || finished) - started),
            outputTokens: output,
            measuredAt: Date.now()
          });
        } catch (err) {
          json({ error: err.message || "local model speed test failed" }, 500);
        }
        return;
      }

      if (req.method === "POST" && p === "/api/models/accelerator") {
        try {
          let last = "";
          const hardware = await engine.installGpuEngine((status) => { last = status; });
          json({ ok: true, hardware, recommendation: engine.recommendLocalSettings(hardware), status: last });
        } catch (err) {
          json({ error: err.message || "could not install GPU acceleration" }, 500);
        }
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
        browserTitle = typeof body.title === "string" ? body.title : "";
        json({ ok: true });
        return;
      }
      if (req.method === "POST" && p === "/api/browser/context-snapshot") {
        const body = await readBody(req);
        browserUrl = typeof body.url === "string" ? body.url.slice(0, 4096) : browserUrl;
        browserTitle = typeof body.title === "string" ? body.title.slice(0, 1000) : browserTitle;
        browserSnapshot = {
          at: Date.now(),
          open: body.open !== false,
          url: browserUrl,
          title: browserTitle,
          text: String(body.text || "").slice(0, 120000),
          ocr: String(body.ocr || "").slice(0, 120000)
        };
        json({ ok: true, at: browserSnapshot.at });
        return;
      }
      if (req.method === "POST" && p === "/api/browser/detect-tech") {
        const body = await readBody(req);
        let html = String(body.html || "");
        let finalUrl = String(body.url || browserUrl || "").trim();
        let headers = body.headers && typeof body.headers === "object" ? body.headers : {};
        if (!html && finalUrl) {
          const parsed = new URL(finalUrl);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http:// and https:// pages can be analyzed.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(parsed.toString(), {
              signal: controller.signal,
              headers: { "user-agent": "Boollm Website Tech Detector" }
            });
            finalUrl = response.url || finalUrl;
            headers = Object.fromEntries(response.headers.entries());
            html = await response.text();
          } finally {
            clearTimeout(timer);
          }
        }
        json({ ok: true, report: detectWebsiteTech({ url: finalUrl, html, headers, cookies: body.cookies || "" }) });
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
          "$initial = $env:BOOLLM_PICK_FOLDER; if ($initial -and (Test-Path -LiteralPath $initial)) { $d.SelectedPath = $initial }; " +
          "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
        const ps = spawn("powershell", ["-NoProfile", "-STA", "-Command", psScript], {
          windowsHide: true,
          env: { ...process.env, BOOLLM_PICK_FOLDER: config.projectsDir }
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
        json(summarizeUsage(config.referenceModel, config.budgetLimit || 0));
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

      if (req.method === "POST" && p === "/api/preferences/update") {
        const body = await readBody(req);
        const ok = updatePreference(String(body.id || ""), String(body.text || ""));
        json({ ok }, ok ? 200 : 400);
        return;
      }

      if (req.method === "POST" && p === "/api/preferences/clear") {
        clearPreferences();
        json({ ok: true });
        return;
      }
      if (req.method === "POST" && p === "/api/studio/site-brand") {
        const body = await readBody(req);
        let raw = String(body.url || "").trim();
        if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
        const parsed = new URL(raw);
        if (!/^https?:$/.test(parsed.protocol) || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(parsed.hostname)) {
          throw new Error("Enter a public http or https website.");
        }
        const response = await fetch(parsed.toString(), { redirect: "follow", signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0 Boollm Ad Studio" } });
        if (!response.ok) throw new Error(`Website returned ${response.status}.`);
        const html = (await response.text()).slice(0, 2_000_000);
        const finalUrl = response.url || parsed.toString();
        const meta = websiteMeta(html, finalUrl);
        const requestedLimit = body.assetLimit === "auto" ? 5 : Math.max(1, Math.min(8, Number(body.assetLimit) || 5));
        const visualUrls = [...new Set([meta.imageUrl, ...meta.imageUrls, meta.logoUrl].filter(Boolean))];
        const pageUrls = websiteInternalLinks(html, finalUrl, 8);
        if (visualUrls.length < requestedLimit * 2) {
          const pages = await Promise.all(pageUrls.map(async pageUrl => {
            try {
              const page = await fetch(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0 Boollm Ad Studio" } });
              if (!page.ok || !(page.headers.get("content-type") || "").includes("text/html")) return null;
              const pageFinalUrl = page.url || pageUrl;
              if (new URL(pageFinalUrl).origin !== new URL(finalUrl).origin) return null;
              return websiteMeta((await page.text()).slice(0, 1_000_000), pageFinalUrl);
            } catch { return null; }
          }));
          for (const pageMeta of pages.filter(Boolean)) {
            for (const url of [pageMeta.imageUrl, ...pageMeta.imageUrls, pageMeta.logoUrl].filter(Boolean)) {
              if (!visualUrls.includes(url)) visualUrls.push(url);
            }
          }
        }
        const assets = [];
        for (let offset = 0; offset < Math.min(visualUrls.length, 64) && assets.length < requestedLimit; offset += 8) {
          const downloaded = await Promise.all(visualUrls.slice(offset, offset + 8).map(async url => ({ url, data: await fetchSmallDataUrl(url) })));
          for (const item of downloaded) {
            if (item.data && !assets.some(saved => saved.data === item.data)) assets.push(item);
            if (assets.length >= requestedLimit) break;
          }
        }
        const captureTargets = [finalUrl, ...pageUrls];
        const viewportSizes = [[1280, 720], [960, 720], [430, 820]];
        for (let index = 0; assets.length < requestedLimit && index < requestedLimit * 3; index++) {
          const target = captureTargets[index % captureTargets.length] || finalUrl;
          const [width, height] = viewportSizes[Math.floor(index / Math.max(1, captureTargets.length)) % viewportSizes.length];
          const data = await captureWebsitePageDataUrl(target, width, height);
          if (data && !assets.some(saved => saved.data === data)) assets.push({ url: `${target}#viewport=${width}x${height}`, data });
        }
        json({ ok: true, brand: {
          url: finalUrl, domain: new URL(finalUrl).hostname.replace(/^www\./, ""),
          title: meta.title || new URL(finalUrl).hostname.replace(/^www\./, ""),
          description: meta.description || "", colors: meta.colors.length ? meta.colors : ["#2563eb", "#111827", "#ffffff"],
          asset: assets[0]?.data || "", assets: assets.map(item => item.data), assetSources: assets.map(item => item.url), assetSource: assets[0]?.url || "",
          requestedAssetLimit: requestedLimit
        }});
        return;
      }
      if (req.method === "POST" && p === "/api/studio/veo/start") {
        const body = await readBody(req);
        if (!config.google?.apiKey) { json({ error: "Connect Google AI in Settings before using AI motion." }, 401); return; }
        const prompt = String(body.prompt || "").trim().slice(0, 4000);
        if (!prompt) { json({ error: "A scene prompt is required." }, 400); return; }
        const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
        const imageMatch = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(String(body.image || ""));
        const instance = { prompt };
        if (imageMatch && imageMatch[2].length <= 16_000_000) instance.image = { inlineData: { mimeType: imageMatch[1].toLowerCase(), data: imageMatch[2] } };
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning", {
          method: "POST", signal: AbortSignal.timeout(30000),
          headers: { "content-type": "application/json", "x-goog-api-key": config.google.apiKey },
          body: JSON.stringify({ instances: [instance], parameters: { aspectRatio, resolution: "720p" } })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.name) { json({ error: data?.error?.message || `Google video generation returned ${response.status}.` }, response.status || 502); return; }
        const id = crypto.randomUUID();
        studioVideoOperations.set(id, { name: data.name, createdAt: Date.now(), videoUri: "" });
        json({ ok: true, id, status: "running" }); return;
      }
      if (req.method === "GET" && p === "/api/studio/veo/capability") {
        if (!config.google?.apiKey) {
          json({ ok: true, connected: false, ready: false, status: "missing_key", model: config.google?.model || "" }); return;
        }
        try {
          const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
            signal: AbortSignal.timeout(20000), headers: { "x-goog-api-key": config.google.apiKey }
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            json({ ok: true, connected: true, ready: false, status: response.status === 401 || response.status === 403 ? "invalid_key" : "check_failed", detail: data?.error?.message || "Google AI could not verify this key.", model: config.google.model || "" }); return;
          }
          const models = (data.models || []).map(item => String(item.name || "").replace(/^models\//, ""));
          const veoModel = models.find(name => name === "veo-3.1-fast-generate-preview") || models.find(name => /^veo-3\.1.*generate/i.test(name)) || "";
          json({ ok: true, connected: true, ready: !!veoModel, status: veoModel ? "available" : "veo_unavailable", veoModel, model: config.google.model || "" }); return;
        } catch (error) {
          json({ ok: true, connected: true, ready: false, status: "check_failed", detail: error.message || "Could not reach Google AI.", model: config.google.model || "" }); return;
        }
      }
      if (req.method === "GET" && p === "/api/studio/veo/status") {
        const id = String(url.searchParams.get("id") || ""), operation = studioVideoOperations.get(id);
        if (!operation) { json({ error: "Video job not found." }, 404); return; }
        if (operation.videoUri) { json({ ok: true, status: "ready", download: `/api/studio/veo/file?id=${encodeURIComponent(id)}` }); return; }
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operation.name}`, { signal: AbortSignal.timeout(20000), headers: { "x-goog-api-key": config.google.apiKey } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { json({ error: data?.error?.message || "Could not check the Google video job." }, response.status || 502); return; }
        if (!data.done) { json({ ok: true, status: "running" }); return; }
        if (data.error) { studioVideoOperations.delete(id); json({ error: data.error.message || "Google could not generate this scene." }, 502); return; }
        operation.videoUri = data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || "";
        if (!operation.videoUri) { studioVideoOperations.delete(id); json({ error: "Google finished without returning a video." }, 502); return; }
        json({ ok: true, status: "ready", download: `/api/studio/veo/file?id=${encodeURIComponent(id)}` }); return;
      }
      if (req.method === "GET" && p === "/api/studio/veo/file") {
        const id = String(url.searchParams.get("id") || ""), operation = studioVideoOperations.get(id);
        if (!operation?.videoUri || !config.google?.apiKey) { json({ error: "Generated video is unavailable." }, 404); return; }
        const response = await fetch(operation.videoUri, { redirect: "follow", signal: AbortSignal.timeout(60000), headers: { "x-goog-api-key": config.google.apiKey } });
        if (!response.ok) { json({ error: "Could not download the generated video." }, 502); return; }
        res.writeHead(200, { "content-type": response.headers.get("content-type") || "video/mp4", "content-disposition": "attachment; filename=boolean-ai-scene.mp4", "cache-control": "no-store" });
        const reader = response.body.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
        res.end(); studioVideoOperations.delete(id); return;
      }
      if (req.method === "POST" && p === "/api/preferences/feedback") {
        const body = await readBody(req);
        const saved = recordResponseFeedback(body || {});
        json(saved ? { ok: true } : { error: "invalid feedback" }, saved ? 200 : 400);
        return;
      }

      // Context Optimizer: estimate tokens for a draft before sending
      if (req.method === "POST" && p === "/api/estimate") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        const budget = config.provider === "local" ? (config.local.ctx || 8192) : 128000;
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
        if (resolve) {
          pendingApprovals.delete(body.id);
          const decision = ["accept", "acceptForSession", "decline", "cancel"].includes(body.decision)
            ? body.decision
            : (body.approved ? "accept" : "decline");
          resolve(resolve.codexDecision === true ? decision : decision === "accept" || decision === "acceptForSession");
        }
        json({ ok: true });
        return;
      }

      if (req.method === "POST" && p === "/api/codex/input") {
        const body = await readBody(req);
        const entry = pendingCodexInputs.get(body.id);
        if (entry?.resolve) {
          pendingCodexInputs.delete(body.id);
          entry.resolve(body.answers && typeof body.answers === "object" ? body.answers : {});
        }
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
          // The Codex runner owns interruption through this AbortSignal. A
          // second direct turn/interrupt here races the same request.
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
        clearCodexThreadMapping(t);
        const retryUser = [...t.messages].reverse().find((message) => message?.role === "user");
        if (retryUser && shouldTrackPendingTask(t, t.messages, userTextOnly(retryUser.content))) beginPendingTask(t, retryUser.content);
        else t.pendingTask = null;
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
        clearCodexThreadMapping(t);
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
        resetLoopRecoveryState(savedTask);
        t.messages.push({ role: "user", content });
        t.log.push({ t: "user", text: "Continue", images: [], at: Date.now() });
        savedTask.state = "running";
        savedTask.updatedAt = Date.now();
        t.updatedAt = Date.now();
        persist();
        return streamRun(t, res, { continuation: true });
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
        t.log.push({ t: "user", text: userTextOnly(content), images: imagesOf(content), at: Date.now(), provider: "compare", compareTargets: targets });
        if (config.ui?.learnedMemory !== false) learnFromUserText(userTextOnly(content));
        autoTitleThread(t, content, threads.values());
        t.updatedAt = Date.now();
        persist();
        return streamCompare(t, targets, res);
      }

      if (req.method === "POST" && p === "/api/chat") {
        const body = await readBody(req);
        const t = threads.get(body.threadId) || threads.get(activeThreadId);
        if (body.accessMode !== undefined) {
          const accessModeSnapshot = String(body.accessMode || "").trim().toLowerCase();
          if (!ACCESS_MODES.includes(accessModeSnapshot)) return json({ error: "invalid_access_mode" }, 400);
          if (accessModeSnapshot !== currentAccessMode(config)) {
            return json({ error: "The access setting changed before this task started. Review the access control and send again." }, 409);
          }
        }
        const requestedProvider = PROVIDERS.includes(String(body.provider || "")) ? String(body.provider || "") : "";
        const requestedModel = String(body.model || "").trim();
        const selectedCodingEngine = config.codingEngine || (config.codex?.enabled ? "codex" : "boolean");
        const externalEngineRequested = ["codex", "claude-code"].includes(selectedCodingEngine) && body.sideChat !== true && body.salesWorkflow !== true && body.workflowRun !== true;
        const effectiveProvider = externalEngineRequested ? selectedCodingEngine : (requestedProvider || config.provider);

        if (externalEngineRequested && Array.isArray(body.images) && body.images.length) {
          const send = openNdjsonStream(res);
          send({ type: "error", text: `This ${selectedCodingEngine === "claude-code" ? "Claude Code" : "Codex"} integration does not accept pasted image data yet. Switch the orchestration engine to Boollm for this image turn.` });
          send({ type: "done" });
          res.end();
          return;
        }

        // block image sends when the local model has no vision projector
        if (Array.isArray(body.images) && body.images.length && effectiveProvider === "local"
            && !(config.ui?.autoRouteModels === true && !externalEngineRequested)) {
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
        const asksAboutSavedTask = !!savedTask && isTaskStatusQuestion(visibleUserText);
        const shouldRefineSavedTask = !!savedTask && isTaskRefinement(visibleUserText);
        const shouldResumeSavedTask = !!savedTask && !asksAboutSavedTask && (isExplicitTaskContinuation(visibleUserText) || shouldRefineSavedTask);
        let inspectSavedTask = false;
        if (shouldResumeSavedTask) {
          if (shouldRefineSavedTask) {
            savedTask.context = `${savedTask.context || savedTask.objective || ""}\n\n--- additional user requirement ---\n\n${visibleUserText}`.slice(-24000);
          }
          t.messages.push({ role: "user", content: resumeTaskMessage(savedTask, visibleUserText, { refinement: shouldRefineSavedTask }) });
          savedTask.state = "running";
          savedTask.updatedAt = Date.now();
        } else {
          t.messages.push({ role: "user", content });
          const incomingMode = body.sideChat === true ? "chat" : (asksAboutSavedTask ? "inspect" : turnModeForPendingTask(t.messages, visibleUserText));
          inspectSavedTask = !!savedTask && (asksAboutSavedTask || incomingMode === "inspect");
          if (body.sideChat !== true && (incomingMode === "connector" || (incomingMode === "action" && t.kind === "project" && !!t.projectDir))) beginPendingTask(t, content);
          else if (savedTask) {
            // A status/inspect question mid-build (e.g. "what's done so far?",
            // "what's next?") must NOT discard the active task. If it does, a
            // later "continue"/"next step" has nothing to resume and runs as
            // answer-only chat, so the model narrates the next step and stops.
            // Keep the task interrupted; a genuinely new request re-enters the
            // action branch above and replaces it via beginPendingTask.
            savedTask.state = "interrupted";
            savedTask.updatedAt = Date.now();
          } else {
            t.pendingTask = null;
          }
        }
        t.log.push({ t: "user", text: visibleUserText, images: imagesOf(content), at: Date.now(), provider: effectiveProvider });
        if (config.ui?.learnedMemory !== false) learnFromUserText(visibleUserText);
        autoTitleThread(t, content, threads.values());
        t.updatedAt = Date.now();
        persist();
        if (asksAboutSavedTask) {
          const answer = taskStopAnswer(savedTask);
          const replyProvider = requestedProvider || config.provider || "local";
          const replyModel = requestedModel || currentModel(config);
          const aiLabel = shortAiName(replyProvider, replyModel);
          t.messages.push({ role: "assistant", content: answer });
          t.log.push({ t: "ai", text: answer, at: Date.now(), provider: replyProvider, model: replyModel, aiLabel });
          t.updatedAt = Date.now();
          persist();
          const send = openNdjsonStream(res);
          send({ type: "answer", text: answer, provider: replyProvider, model: replyModel, aiLabel });
          res.end();
          return;
        }
        const sideProvider = body.sideChat === true && PROVIDERS.includes(String(body.sideProvider || "")) ? String(body.sideProvider) : "";
        const sideModel = body.sideChat === true ? String(body.sideModel || "").trim() : "";
        return streamRun(t, res, {
          forceTurnMode: body.sideChat === true ? "chat" : "",
          forceNoArtifact: body.salesWorkflow === true,
          salesWorkflow: body.salesWorkflow === true,
          workflowRun: body.workflowRun === true,
          disableCodex: body.sideChat === true || body.salesWorkflow === true || body.workflowRun === true,
          provider: sideProvider || requestedProvider,
          model: sideProvider ? sideModel : requestedModel,
          inspectSavedTask,
          continuation: shouldResumeSavedTask
        });
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
      clearCodexThreadMapping(t);
      t.pendingTask = null;
      t.updatedAt = Date.now();
      persist();
    }

    // ── shared streaming runner for chat / retry / continue ──
    function openNdjsonStream(res) {
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "connection": "keep-alive"
      });
      res.socket?.setNoDelay?.(true);
      res.flushHeaders?.();
      return (payload) => {
        if (!res.writableEnded) res.write(JSON.stringify(payload) + "\n");
      };
    }

    async function streamRun(t, res, options = {}) {
        const send = openNdjsonStream(res);
        const baseConfig = { ...config, ...(t.projectDir ? { projectsDir: t.projectDir } : {}) };
        let runConfig = options.provider ? { ...baseConfig, provider: options.provider, [options.provider]: { ...(baseConfig[options.provider] || {}) } } : baseConfig;
        if (options.provider && options.model && runConfig[options.provider]) runConfig[options.provider].model = options.model;
        const configuredCodingEngine = config.codingEngine || (config.codex?.enabled ? "codex" : "boolean");
        let selectedCodingEngine = configuredCodingEngine;
        let executionRoute = null;
        let autoRouteContext = null;
        if (configuredCodingEngine === "auto") {
          const latestContent = t.messages.at(-1)?.content;
          const latestText = userTextOnly(latestContent || "");
          const hasImages = imagesOf(latestContent).length > 0;
          const route = routeForTurn(t.messages, {
            latestText,
            hasImages,
            turnMode: options.forceTurnMode || ""
          });
          const taskExecution = t.kind === "project" && !!t.pendingTask?.objective;
          autoRouteContext = { route, latestText, hasImages, taskExecution };
          executionRoute = selectExecutionEngine(config, t.messages, {
            route,
            latestText,
            hasImages,
            turnMode: options.forceTurnMode || "",
            disabled: options.disableCodex === true,
            taskExecution
          });
          selectedCodingEngine = executionRoute.engine;
        }
        let useCodex = selectedCodingEngine === "codex" && options.disableCodex !== true;
        let useClaudeCode = selectedCodingEngine === "claude-code" && options.disableCodex !== true;
        let useExternalEngine = useCodex || useClaudeCode;
        let replyProvider = useCodex ? "codex" : useClaudeCode ? "claude-code" : (runConfig.provider || "local");
        let replyModel = useCodex ? (config.codex?.model || "Codex default") : useClaudeCode ? (config.claudeCode?.model || "sonnet") : currentModel(runConfig);
        if (executionRoute?.automatic && useExternalEngine) {
          send({
            type: "route",
            route: executionRoute.route,
            provider: replyProvider,
            model: replyModel,
            reason: executionRoute.reason,
            engine: selectedCodingEngine
          });
        }

        // keep the system prompt current — restored sessions may predate newer
        // tools/workflow (e.g. create_project), so refresh it every run
        const abort = new AbortController();
        t.abort = abort;
        const needsWriteElevation = needsProjectWriteElevation({
          accessMode: currentAccessMode(runConfig),
          kind: t.kind,
          projectDir: t.projectDir,
          messages: t.messages,
          forceTurnMode: options.forceTurnMode || "",
          forceNoArtifact: options.forceNoArtifact === true
        });
        if (needsWriteElevation) {
          const id = crypto.randomUUID();
          const projectName = path.basename(t.projectDir) || t.title || "this project";
          const summary = `This task needs Read & write access in ${projectName}. Allow Read & write for this task only?`;
          send({
            type: "approval", id, summary, kind: "writeElevation",
            cwd: t.projectDir,
            availableDecisions: ["accept", "decline"]
          });
          const allowed = await new Promise((resolve) => {
            pendingApprovals.set(id, resolve);
            abort.signal.addEventListener("abort", () => {
              if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
            }, { once: true });
            setTimeout(() => {
              if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
            }, 600000).unref?.();
          });
          if (!allowed) {
            const answer = "Kept this task read only. No files were changed.";
            const aiLabel = shortAiName(replyProvider, replyModel);
            t.messages.push({ role: "assistant", content: answer });
            t.log.push({ t: "ai", text: answer, at: Date.now(), provider: replyProvider, model: replyModel, aiLabel });
            if (t.pendingTask && !options.inspectSavedTask) {
              t.pendingTask.state = "interrupted";
              t.pendingTask.updatedAt = Date.now();
            }
            t.abort = null;
            t.updatedAt = Date.now();
            persist();
            send({ type: "answer", text: answer, provider: replyProvider, model: replyModel, aiLabel });
            send({ type: "done" });
            res.end();
            return;
          }
          // This copy is scoped to this stream only. The saved global Read only
          // setting remains untouched, and concrete file/command actions still
          // use the normal per-tool approval path because the turn is Ask mode.
          runConfig = oneTurnProjectWriteConfig(runConfig);
          send({ type: "status", text: "Read & write allowed for this task only." });
        }

        // Refresh restored sessions after the one-turn access decision so the
        // controller, compatibility bridge, and Codex all receive one contract.
        if (t.messages[0]?.role === "system") {
          t.messages[0] = { role: "system", content: systemPrompt(runConfig.projectsDir, runConfig.autoApprove, runConfig) + currentAppContext(t, userTextOnly(t.messages.at(-1)?.content || ""), { inspectSavedTask: options.inspectSavedTask === true }) };
        }
        let runIn = 0, runOut = 0, runEst = false, runCalls = 0, teamUsageSeen = false;
        const runUsageByWorker = new Map();
        let verifiedWorkspaceChangeThisTurn = false;
        const previewRequested = requestsLocalPreview(userTextOnly(t.messages.at(-1)?.content || ""));
        const previewEvidence = [];
        const ctx = {
          config: runConfig,
          projectDir: t.kind === "project" ? t.projectDir || "" : "",
          browserUrl,
          signal: abort.signal,
          objective: options.inspectSavedTask ? "" : t.pendingTask?.objective || "",
          taskContext: options.inspectSavedTask ? "" : t.pendingTask?.context || "",
          controllerState: (() => {
            const saved = options.inspectSavedTask ? null : t.pendingTask?.controller || null;
            if (!t.memoryDigest) return saved;
            return { ...(saved || {}), conversationDigest: t.memoryDigest };
          })(),
          continuation: options.continuation === true,
          threadId: t.id,
          orchestrationState: options.inspectSavedTask ? null : t.orchestration || t.pendingTask?.orchestration || null,
          forceTurnMode: options.forceTurnMode || "",
          forceNoArtifact: options.forceNoArtifact === true,
          salesWorkflow: options.salesWorkflow === true,
          workflowRun: options.workflowRun === true,
          onStatus: (text, detail) => send({ type: "status", text, ...(detail || {}) }),
          onRoute: (route) => {
            if (!route || useExternalEngine) return;
            replyProvider = route.provider || replyProvider;
            replyModel = route.model || replyModel;
            send({ type: "route", ...route });
          },
          onToken: (text) => send({ type: "token", text }),
          onUsage: (u) => {
            runIn += u.input || 0; runOut += u.output || 0; runEst = runEst || !!u.estimated;
            if ((u.input || 0) || (u.output || 0)) runCalls++;
            if (!u.teamWorker) {
              if (u.provider) replyProvider = u.provider;
              if (u.model) replyModel = u.model;
            }
            const role = u.teamWorker ? String(u.role || "Specialist") : "Lead";
            const attempt = u.teamWorker ? Math.max(1, Number(u.attempt) || 1) : 1;
            const usageKey = `${role}\u0000${u.provider || ""}\u0000${u.model || ""}\u0000${attempt}`;
            const workerUsage = runUsageByWorker.get(usageKey) || { role, provider: u.provider || "", model: u.model || "", attempt, input: 0, output: 0, calls: 0, estimated: false };
            workerUsage.input += u.input || 0;
            workerUsage.output += u.output || 0;
            workerUsage.calls += ((u.input || 0) || (u.output || 0)) ? 1 : 0;
            workerUsage.estimated = workerUsage.estimated || !!u.estimated;
            runUsageByWorker.set(usageKey, workerUsage);
            teamUsageSeen = teamUsageSeen || !!u.teamWorker;
            recordUsage(u.provider, u.model, u.input || 0, u.output || 0);
            const breakdown = teamUsageSeen ? [...runUsageByWorker.values()].map((item) => ({ ...item, cost: costOf(item.input, item.output, item.model) })) : undefined;
            send({ type: "tokens", input: runIn, output: runOut, estimated: runEst, calls: runCalls, ...(breakdown ? { breakdown } : {}) });
          },
          onStep: (step) => {
            if (previewRequested) previewEvidence.push(step?.result || "", JSON.stringify(step?.args || {}));
            if (step?.verified === true && step?.name === "apply_patch" && Array.isArray(step?.args?.changes)) {
              const changeRoot = t.projectDir || config.projectsDir || "";
              t.workspaceChanges = mergeWorkspaceChanges(t.workspaceChanges || [], step.args.changes, changeRoot);
              verifiedWorkspaceChangeThisTurn = true;
              t.updatedAt = Date.now();
              invalidateProjectStatus(changeRoot);
              persist();
              send({
                type: "workspaceChanges",
                count: t.workspaceChanges.length,
                changes: normalizeWorkspaceChanges(t.workspaceChanges, changeRoot)
              });
            }
            const entry = { t: "tool", name: step.name, args: step.args || {}, summary: stepSummary(step.name, step.args), result: step.result, verified: step.verified === true };
            t.log.push(entry);
            send({ type: "step", entry, ...((options.salesWorkflow === true || options.workflowRun === true) ? { stepArgs: step.args || {} } : {}) });
            if (step.name === "read_page") send({ type: "browser", action: "read", url: step.args?.url || browserUrl });
            if (/^email_/.test(step.name || "")) {
              const provider = String(step.args?.provider || "").toLowerCase();
              const emailUrl = provider === "gmail"
                ? "https://mail.google.com/"
                : provider === "outlook" ? "https://outlook.live.com/mail/" : "";
              if (emailUrl) send({ type: "browser", action: "open", url: emailUrl });
            }
          },
          onOptimize: (o) => send({ type: "optimized", ...o }),
          onController: (controller) => {
            if (controller?.conversationDigest) t.memoryDigest = controller.conversationDigest;
            if (t.pendingTask && !options.inspectSavedTask) {
              t.pendingTask.controller = controller;
              t.pendingTask.updatedAt = Date.now();
            }
            send({ type: "controller", controller });
          },
          onOrchestration: (event, orchestration) => {
            if (!options.inspectSavedTask) t.orchestration = orchestration;
            if (t.pendingTask && !options.inspectSavedTask) {
              t.pendingTask.orchestration = orchestration;
              t.pendingTask.updatedAt = Date.now();
            }
            send({ type: "orchestration", event, orchestration });
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
            if (t.pendingTask && !options.inspectSavedTask) t.pendingTask.updatedAt = Date.now();
            t.updatedAt = Date.now();
            persist();
          },
          onCapabilityChange: (modelCapabilities) => {
            config.modelCapabilities = modelCapabilities;
            saveConfig(config);
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
            if (currentAccessMode(config) === "full_access") { send({ type: "status", text: `auto-approved: ${summary}` }); return Promise.resolve(true); }
            const id = crypto.randomUUID();
            send({ type: "approval", id, summary });
            return new Promise((resolve) => {
              pendingApprovals.set(id, resolve);
              abort.signal.addEventListener("abort", () => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              });
              setTimeout(() => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              }, 600000).unref?.();
            });
          },
          approveAlways: (summary, meta = {}) => {
            const id = crypto.randomUUID();
            send({ type: "approval", id, summary, ...(meta && typeof meta === "object" ? meta : {}) });
            return new Promise((resolve) => {
              pendingApprovals.set(id, resolve);
              abort.signal.addEventListener("abort", () => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              });
              setTimeout(() => {
                if (pendingApprovals.has(id)) { pendingApprovals.delete(id); resolve(false); }
              }, 600000).unref?.();
            });
          }
        };
        // let the agent delegate focused work to bounded sub-agents
        ctx.runSubagent = (task, options) => runSubagent(ctx, task, options);

        const activateAutoSubscriptionEscalation = async (failureReason = "") => {
          if (configuredCodingEngine !== "auto" || !autoRouteContext || options.disableCodex === true || abort.signal.aborted) return false;
          if (config.ui?.modelRouting?.allowEscalation === false) return false;
          const subscriptions = config.ui?.modelRouting?.subscriptionEngines || {};
          const codexAllowed = autoSubscriptionEnabled(subscriptions, "codex");
          const claudeAllowed = autoSubscriptionEnabled(subscriptions, "claudeCode");
          if (!codexAllowed && !claudeAllowed) return false;
          let codexReady = false;
          let claudeReady = false;
          if (codexAllowed) {
            try {
              await ensureCodexClient();
              const status = publicCodexStatus();
              codexReady = status.ready === true && status.account?.signedIn === true;
            } catch { codexReady = false; }
          }
          if (claudeAllowed) {
            try { claudeReady = publicClaudeStatus({ refresh: true }).ready === true; }
            catch { claudeReady = false; }
          }
          const escalation = selectExecutionEngine(config, t.messages, {
            ...autoRouteContext,
            disabled: false,
            escalationRequired: true,
            codexReady,
            claudeReady
          });
          if (escalation.engine !== "codex" && escalation.engine !== "claude-code") return false;
          executionRoute = escalation;
          selectedCodingEngine = escalation.engine;
          useCodex = selectedCodingEngine === "codex";
          useClaudeCode = selectedCodingEngine === "claude-code";
          useExternalEngine = true;
          replyProvider = useCodex ? "codex" : "claude-code";
          replyModel = useCodex ? (config.codex?.model || "Codex default") : (config.claudeCode?.model || "sonnet");
          const reason = failureReason ? `${escalation.reason} ${String(failureReason).slice(0, 240)}` : escalation.reason;
          send({
            type: "route",
            route: escalation.route,
            provider: replyProvider,
            model: replyModel,
            reason,
            engine: selectedCodingEngine,
            escalated: true
          });
          send({ type: "status", text: `Boollm could not finish or verify this task. Continuing with ${useCodex ? "Codex" : "Claude Code"}...` });
          return true;
        };

        activeChats++;
        lastPing = Date.now();
        let codexTurnStatus = "";
        try {
          let answer;
          for (;;) {
          if (useCodex) {
            const runner = await ensureCodexRunner();
            const codexActivity = new Map();
            const emitActivity = (event = { method: "item/updated" }, status = "in_progress") => {
              const orchestration = codexOrchestrationSnapshot({
                threadId: t.codex?.threadId || t.codexActive?.threadId || "",
                turnId: t.codexActive?.turnId || t.codex?.turnId || "",
                status,
                items: [...codexActivity.values()]
              });
              ctx.onOrchestration(event, orchestration);
            };
            const requestCodexApproval = async (request) => {
              const params = request?.params && typeof request.params === "object" ? request.params : {};
              const supported = new Set(["accept", "acceptForSession", "decline", "cancel"]);
              const availableDecisions = Array.isArray(params.availableDecisions)
                ? params.availableDecisions.map(String).filter((decision) => supported.has(decision))
                : [];
              const networkContext = params.networkApprovalContext && typeof params.networkApprovalContext === "object"
                ? params.networkApprovalContext
                : null;
              const networkTarget = networkContext
                ? Object.values(networkContext).filter((value) => ["string", "number"].includes(typeof value)).map(String).join(": ")
                : "";
              const summary = String(
                request?.summary
                || params.reason
                || (networkTarget ? `Allow network access to ${networkTarget}` : "")
                || (request?.kind === "file" ? "Apply these file changes" : "Run this command")
              );
              if (currentAccessMode(config) === "full_access") {
                send({ type: "status", text: `auto-approved: ${summary}` });
                return Promise.resolve("accept");
              }
              const id = crypto.randomUUID();
              const approvalEvent = {
                type: "approval", id, summary, codex: true, kind: request?.kind || "command",
                codexRequestId: request?.requestId,
                command: params.command || "", cwd: params.cwd || "",
                commandActions: Array.isArray(params.commandActions) ? params.commandActions : [],
                changes: Array.isArray(params.changes) ? params.changes : [],
                networkApprovalContext: networkContext,
                availableDecisions
              };
              send(approvalEvent);
              const decision = await new Promise((resolve) => {
                resolve.codexDecision = true;
                resolve.codexEvent = { ...approvalEvent, threadId: t.id };
                pendingApprovals.set(id, resolve);
                const finish = (decision) => {
                  if (!pendingApprovals.has(id)) return;
                  pendingApprovals.delete(id);
                  resolve(decision);
                };
                abort.signal.addEventListener("abort", () => finish("cancel"), { once: true });
                setTimeout(() => finish("decline"), 600000).unref?.();
              });
              if (!availableDecisions.length || availableDecisions.includes(decision)) return decision;
              if (decision === "acceptForSession" && availableDecisions.includes("accept")) return "accept";
              return availableDecisions.includes("decline") ? "decline" : (availableDecisions[0] || "cancel");
            };
            let result;
            try {
              result = await runner.runCodexTurn({
              messages: previewRequested ? withBoollmPreviewHandoff(t.messages) : t.messages,
              mapping: t.codex || {},
              model: config.codex?.model || "",
              effort: config.codex?.reasoningEffort || "medium",
              // Match Boollm's native behavior: project chats work in their
              // own folder, while an ordinary New chat can create a project
              // beneath the configured projects workspace instead of being
              // silently downgraded to read-only.
              projectDir: t.projectDir || config.projectsDir || "",
              workspaceChanges: booleanWorkspaceChanges(t, t.projectDir || config.projectsDir || "", threads),
              networkAccess: config.ui?.aiBrowser !== false,
              // Keep Full access frictionless for in-root work, while still
              // receiving untrusted command requests so the host can reject
              // explicit reads/writes outside the canonical allowlist.
              approvalPolicy: currentAccessMode(runConfig) === "full_access" ? "untrusted" : "on-request",
              sandboxPolicy: currentAccessMode(runConfig) === "read_only"
                ? {
                    type: "readOnly",
                    access: {
                      type: "restricted",
                      includePlatformDefaults: false,
                      readableRoots: [path.resolve(t.projectDir || config.projectsDir || "")]
                    }
                  }
                : undefined,
              sandboxEnvironment: codexProcessEnvironment,
              getWorkspaceChanges: () => booleanWorkspaceChanges(t, t.projectDir || config.projectsDir || "", threads),
              signal: abort.signal,
              onStatus: ctx.onStatus,
              onToken: ctx.onToken,
              onUsage: ctx.onUsage,
              onStep: ctx.onStep,
              onPlan: (plan) => {
                for (const [index, step] of plan.entries()) {
                  const status = String(step?.status || "pending").toLowerCase();
                  codexActivity.set(`plan-${index}`, {
                    id: `plan-${index}`,
                    type: "plan_step",
                    title: String(step?.step || step?.text || `Step ${index + 1}`),
                    status: status === "completed" ? "completed" : status === "inprogress" || status === "in_progress" ? "in_progress" : "pending"
                  });
                }
                emitActivity({ method: "turn/plan/updated" });
              },
              onItem: ({ method, item }) => {
                if (!item?.id || ["agentMessage", "reasoning"].includes(item.type)) return;
                codexActivity.set(item.id, {
                  id: item.id,
                  type: String(item.type || "activity"),
                  title: String(item.command || item.query || item.tool || item.type || "Activity").slice(0, 180),
                  status: method === "item/completed" ? "completed" : "in_progress"
                });
                emitActivity({ method, itemId: item.id });
              },
              onMapping: (mapping) => {
                t.codex = { threadId: mapping.threadId || "", turnId: mapping.turnId || mapping.lastTurnId || "", model: mapping.model || config.codex?.model || "", status: mapping.status || "", updatedAt: Date.now() };
                t.updatedAt = Date.now();
                persist();
              },
              onIds: ({ threadId, turnId }) => { t.codexActive = { threadId, turnId }; },
              onApproval: requestCodexApproval,
              onPermissions: async (request) => {
                const decision = await requestCodexApproval({ kind: "permissions", summary: request?.params?.reason || "Allow the requested Codex permissions", params: request?.params });
                return decision === "accept" || decision === "acceptForSession"
                  ? { permissions: request?.params?.permissions || {}, scope: decision === "acceptForSession" ? "session" : "turn" }
                  : { permissions: {}, scope: "turn" };
              },
              onUserInput: (request) => {
                const id = crypto.randomUUID();
                const pending = {
                  threadId: t.id,
                  codexRequestId: request.requestId,
                  questions: request.questions || [],
                  isBlocking: request.isBlocking !== false
                };
                send({ type: "codexInput", id, ...pending });
                return new Promise((resolve) => {
                  pendingCodexInputs.set(id, { ...pending, resolve });
                  const finish = () => {
                    if (!pendingCodexInputs.has(id)) return;
                    pendingCodexInputs.delete(id);
                    resolve({});
                  };
                  abort.signal.addEventListener("abort", finish, { once: true });
                  const timeout = request.isBlocking === false && request.autoResolutionMs ? request.autoResolutionMs : 600000;
                  setTimeout(finish, timeout).unref?.();
                });
              },
              onRequestResolved: ({ requestId }) => {
                const approvalIds = [];
                const inputIds = [];
                for (const [id, resolve] of pendingApprovals) {
                  if (String(resolve?.codexEvent?.codexRequestId ?? "") !== String(requestId ?? "")) continue;
                  pendingApprovals.delete(id);
                  approvalIds.push(id);
                  resolve("cancel");
                }
                for (const [id, entry] of pendingCodexInputs) {
                  if (String(entry?.codexRequestId ?? "") !== String(requestId ?? "")) continue;
                  pendingCodexInputs.delete(id);
                  inputIds.push(id);
                  entry.resolve({});
                }
                if (approvalIds.length || inputIds.length) send({ type: "codexRequestResolved", approvalIds, inputIds });
              }
              });
            } catch (error) {
              const terminalStatus = abort.signal.aborted ? "interrupted" : "failed";
              emitActivity({ method: `turn/${terminalStatus}` }, terminalStatus);
              throw error;
            }
            codexTurnStatus = result.status;
            emitActivity({ method: `turn/${codexTurnStatus}` }, codexTurnStatus);
            if (result.status === "failed") throw new Error(result.error || "Codex stopped with an error.");
            answer = result.content;
            break;
          } else if (useClaudeCode) {
            const latestUser = [...t.messages].reverse().find((message) => message?.role === "user");
            const result = await claudeTurnRunner({
              command: config.claudeCode?.command || "claude",
              input: previewRequested
                ? currentTurnInstructionText(withBoollmPreviewHandoff([latestUser || { role: "user", content: "" }]).at(-1) || "")
                : currentTurnInstructionText(latestUser || ""),
              projectDir: t.projectDir || config.projectsDir || "",
              workspaceChanges: booleanWorkspaceChanges(t, t.projectDir || config.projectsDir || "", threads),
              mapping: t.claudeCode || {},
              model: config.claudeCode?.model || "sonnet",
              accessMode: currentAccessMode(runConfig),
              signal: abort.signal,
              onStatus: ctx.onStatus,
              onToken: ctx.onToken,
              onUsage: ctx.onUsage,
              onStep: ctx.onStep,
              onMapping: (mapping) => {
                t.claudeCode = mapping;
                t.updatedAt = Date.now();
                persist();
              }
            });
            codexTurnStatus = result.status || "completed";
            answer = result.answer;
            break;
          } else {
            try {
              answer = await runTurn(ctx, t.messages);
            } catch (error) {
              if (await activateAutoSubscriptionEscalation(`Boollm error: ${error?.message || error}`)) continue;
              throw error;
            }
            const booleanTurnStatus = ctx.orchestrationResult?.thread?.turns?.at(-1)?.status || "completed";
            if (booleanTurnStatus !== "completed"
                && await activateAutoSubscriptionEscalation(`Boollm ended with ${booleanTurnStatus}.`)) continue;
            break;
          }
          }
          if (previewRequested) {
            const previewUrl = await firstReachableLocalPreview([...previewEvidence, answer]);
            if (previewUrl) {
              send({ type: "status", text: `Opening verified preview: ${previewUrl}` });
              send({ type: "browser", action: "open", url: previewUrl });
            }
          }
          if (verifiedWorkspaceChangeThisTurn) {
            const report = workspaceChangesReport(booleanWorkspaceChanges(t, t.projectDir || config.projectsDir || "", threads));
            if (!String(answer || "").includes("Boollm Changes:")) answer = `${String(answer || "").trim()}\n\n${report}`.trim();
          }
          if (String(answer || "").trim()) {
            if (useExternalEngine) t.messages.push({ role: "assistant", content: answer });
            const aiLabel = useCodex ? "Codex" : useClaudeCode ? "Claude Code" : shortAiName(replyProvider, replyModel);
            t.log.push({ t: "ai", text: answer, at: Date.now(), provider: replyProvider, model: replyModel, aiLabel });
            // Usage must reach the UI before `answer`, which is the stream's
            // terminal record. Local model performance uses the exact output
            // count together with first-token timing measured on this PC.
            if (runIn || runOut) {
              const breakdown = teamUsageSeen ? [...runUsageByWorker.values()].map((item) => ({ ...item, cost: costOf(item.input, item.output, item.model) })) : undefined;
              const usage = { t: "usage", input: runIn, output: runOut, estimated: runEst, calls: runCalls, ...(breakdown ? { breakdown } : {}) };
              t.log.push(usage);
              send({ type: "usage", ...usage });
            }
            const turnStatus = useExternalEngine ? (codexTurnStatus || "completed") : (ctx.orchestrationResult?.thread?.turns?.at(-1)?.status || "completed");
            send({ type: turnStatus === "completed" ? "answer" : "paused", text: answer, provider: replyProvider, model: replyModel, aiLabel, turnStatus });
          } else if (useExternalEngine && codexTurnStatus === "interrupted") {
            const aiLabel = useClaudeCode ? "Claude Code" : "Codex";
            send({ type: "paused", text: `${aiLabel} stopped safely. You can continue this task when ready.`, provider: replyProvider, model: replyModel, aiLabel, turnStatus: "interrupted" });
          }
          if (t.pendingTask && !options.inspectSavedTask) {
            const turnStatus = useExternalEngine ? codexTurnStatus : ctx.orchestrationResult?.thread?.turns?.at(-1)?.status;
            t.pendingTask.state = turnStatus === "completed" ? "completed" : (turnStatus || "interrupted");
            t.pendingTask.updatedAt = Date.now();
          }
          if (runIn || runOut) {
            // Budget warning after each turn that records cloud usage
            const budget = checkBudget(config.budgetLimit || 0);
            if (budget.level !== "ok") {
              send({ type: "budget", level: budget.level, spent: Math.round(budget.spent * 10000) / 10000, limit: budget.limit, pct: Math.round(budget.pct * 100) });
            }
          }
        } catch (err) {
          if (abort.signal.aborted) ctx.orchestration?.interruptTurn("Stopped by the user.");
          else ctx.orchestration?.failTurn(err?.message || err);
          if (t.pendingTask && !options.inspectSavedTask) {
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
          t.codexActive = null;
          if (t.rollbackToUser) { t.rollbackToUser = false; if (abort.signal.aborted) rollbackLastUserTurn(t); }
          t.updatedAt = Date.now();
          lastPing = Date.now();
        }
        persist();
        send({ type: "done" });
        res.end();
    }

    async function streamCompare(t, targets, res) {
      const send = openNdjsonStream(res);
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
        { role: "system", content: "" },
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
  server.on("close", () => { stopCodexClient().catch(() => {}); });

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
          serverPort = server.address().port;
          resolve({ server, proxyServer, port: serverPort });
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
    if (!fs.existsSync(icon)) icon = path.join(dir, "Boollm.exe"); // fall back to exe icon
  } else {
    script = appPath("assets", "set-window-icon.ps1");
    icon = appPath("assets", "saz.ico");
  }
  if (fs.existsSync(script) && fs.existsSync(icon)) {
    const ps = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", script, "-IconPath", icon], { detached: true, stdio: "ignore" });
    ps.unref();
  }
}
