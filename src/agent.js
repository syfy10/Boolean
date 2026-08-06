import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { resolveTarget, resolveProviderTarget, chatCompletion } from "./providers.js";
import { CLOUD, currentAccessMode } from "./config.js";
import {
  modelCapabilityProfile,
  nativeToolSupport,
  parseBooleanPatch,
  recordNativeToolSupport
} from "./model-capabilities.js";
import { summarizeLearnedPreferences } from "./preferences.js";
import { detectWindowsSettingsRequest } from "./system-actions.js";
import { createAgentController } from "./controller.js";
import { booleanAgentPolicy } from "./agent-policy.js";
import { createCodexOrchestrator } from "./orchestrator.js";
import { autoModelQualityRank, nextAutoModelTarget, noteAutoModelOutcome, selectAutoModelRoute, handoffCandidates } from "./model-router.js";

const CLOUD_FALLBACK_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function cloudFallbackAllowed(config, primaryTarget, err, emitted) {
  if (emitted || primaryTarget?.provider === "local") return false;
  const fb = config?.cloudFallback || {};
  if (!fb.enabled || !fb.provider || fb.provider === "local" || fb.provider === primaryTarget?.provider) return false;
  if (!CLOUD[fb.provider] || !config?.[fb.provider]?.apiKey) return false;
  return err?.code === "cloud_transport_error" || CLOUD_FALLBACK_STATUSES.has(err?.status);
}

function cloudLabel(target) {
  return CLOUD[target?.provider] || target?.provider || "Cloud";
}

export function parseAutoVerificationVerdict(content) {
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [text, fenced].filter(Boolean)) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value?.verified === "boolean") {
        return {
          verified: value.verified,
          reason: String(value.reason || (value.verified ? "Independent review passed." : "Independent review failed.")).slice(0, 500)
        };
      }
    } catch {}
  }
  return { verified: false, reason: "The independent reviewer returned an inconclusive verdict." };
}

function containsUnexecutedCompatibilityAction(content) {
  return /```\s*boolean_patch\b/i.test(String(content || ""));
}

async function verifyAutoCompletion(config, route, workerTarget, objective, answer, controller, signal, onStatus) {
  const workerQuality = autoModelQualityRank(workerTarget);
  const reviewer = handoffCandidates(config, route).find((candidate) =>
    (candidate.provider !== workerTarget?.provider || candidate.model !== workerTarget?.model)
    && autoModelQualityRank(candidate) >= workerQuality
  );
  if (!reviewer) {
    // No second model exists to review. "Could not verify" is NOT "verification
    // failed" — treating it as a failure makes a single-model auto task re-answer
    // forever (it can never be verified), so accept the result and flag it unverified.
    return { verified: true, unverified: true, reason: "Accepted without independent verification — no second connected model was available to review." };
  }
  const resolved = await resolveProviderTarget(config, reviewer.provider, onStatus);
  const reviewerTarget = reviewer.model ? { ...resolved, model: reviewer.model } : resolved;
  onStatus?.(`Auto is verifying the work with ${reviewerTarget.model || reviewerTarget.provider}...`);
  try {
    const evidence = controller.snapshot();
    const review = await chatCompletion(reviewerTarget, [
      {
        role: "system",
        content: "You are Boolean's independent completion verifier. Review the claimed result against the concrete controller evidence. Do not propose edits and do not trust the worker's claim by itself. Return only compact JSON: {\"verified\":true|false,\"reason\":\"specific evidence-based reason\"}. Mark verified false if work, testing, or requested deliverables are missing, failed, merely described, or cannot be established from the evidence."
      },
      {
        role: "user",
        content: [
          `ORIGINAL TASK:\n${String(objective || "").slice(0, 4000)}`,
          `WORKER: ${workerTarget?.provider || "unknown"}/${workerTarget?.model || "default"}`,
          `CLAIMED FINAL RESPONSE:\n${String(answer || "").slice(0, 8000)}`,
          `CONTROLLER EVIDENCE:\n${JSON.stringify(evidence).slice(0, 12000)}`
        ].join("\n\n")
      }
    ], undefined, signal);
    const verdict = parseAutoVerificationVerdict(review?.content);
    return { ...verdict, reviewer: reviewerTarget };
  } catch (error) {
    // The reviewer could not run — accept rather than loop re-answering. Flag it so
    // the caller reports the result as not independently verified.
    return {
      verified: true,
      unverified: true,
      reason: `Accepted without independent verification — the reviewer could not complete: ${String(error?.message || error).slice(0, 200)}`,
      reviewer: reviewerTarget
    };
  }
}

const ARTIFACT_INTENT_TIMEOUT_MS = 12000;

// Keyword lists cannot separate "1 thing we can change" from "change this thing",
// so the narrow overlap where the build words fire but the sentence reads as a
// question gets one cheap model call instead of another regex. Every failure path
// keeps the safe answer (advice): wrongly starting work is the expensive mistake,
// and a wrongly conversational turn costs only a follow-up message.
async function resolveArtifactIntent(config, text, signal) {
  const request = String(text || "").trim();
  if (!request) return { action: false, reason: "empty request" };
  const candidate = handoffCandidates(config, "fast")[0];
  if (!candidate) return { action: false, reason: "no connected model was available to classify intent" };
  const aborter = new AbortController();
  const abort = () => aborter.abort();
  signal?.addEventListener?.("abort", abort);
  const timer = setTimeout(abort, ARTIFACT_INTENT_TIMEOUT_MS);
  try {
    const resolved = await resolveProviderTarget(config, candidate.provider);
    const target = candidate.model ? { ...resolved, model: candidate.model } : resolved;
    const reply = await chatCompletion(target, [
      {
        role: "system",
        content: "Classify one message sent to a coding assistant. Answer with only compact JSON: {\"intent\":\"action\"} when the user is telling the assistant to change, build, fix, or run something now. {\"intent\":\"advice\"} when the user is asking a question, or asking for ideas, opinions, options, or an explanation. A question that merely mentions a possible change is advice, not action."
      },
      { role: "user", content: request.slice(0, 1200) }
    ], undefined, aborter.signal);
    const intent = String(reply?.content || "").match(/"intent"\s*:\s*"(action|advice)"/i)?.[1]?.toLowerCase();
    if (!intent) return { action: false, reason: "the intent check returned no verdict; treated as a question", target };
    return { action: intent === "action", reason: `intent check: ${intent}`, target };
  } catch (error) {
    return { action: false, reason: `intent check unavailable (${String(error?.message || error).slice(0, 120)}); treated as a question` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

async function chatCompletionWithFallback(config, primaryTarget, messages, tools, signal, onToken, onStatus) {
  const startedAt = Date.now();
  let emitted = false;
  const localRequest = primaryTarget?.provider === "local";
  let writingStarted = false;
  if (localRequest) onStatus?.("Model loaded - evaluating your request...");
  const trackedToken = typeof onToken === "function"
    ? (text) => {
        if (text) {
          emitted = true;
          if (localRequest && !writingStarted) {
            writingStarted = true;
            onStatus?.("Writing your answer...");
          }
        }
        onToken(text);
      }
    : onToken;
  try {
    const message = await chatCompletion(primaryTarget, messages, tools, signal, trackedToken);
    noteAutoModelOutcome(primaryTarget, { ok: true, latencyMs: Date.now() - startedAt });
    return { target: primaryTarget, message };
  } catch (err) {
    noteAutoModelOutcome(primaryTarget, { ok: false, latencyMs: Date.now() - startedAt, error: err?.message || err });
    const autoSelection = config?.__autoModelRoute;
    const autoCandidate = !emitted && autoSelection?.enabled
      && (err?.code === "cloud_transport_error" || err?.code === "local_transport_error" || CLOUD_FALLBACK_STATUSES.has(err?.status))
      ? nextAutoModelTarget(autoSelection, primaryTarget)
      : null;
    if (!autoCandidate && !cloudFallbackAllowed(config, primaryTarget, err, emitted)) throw err;
    const fb = config.cloudFallback || {};
    const provider = autoCandidate?.provider || fb.provider;
    const model = autoCandidate?.model || fb.model;
    const fallbackTarget = await resolveProviderTarget(config, provider, onStatus);
    const target = model ? { ...fallbackTarget, model } : fallbackTarget;
    if (target.provider === primaryTarget.provider && target.model === primaryTarget.model) throw err;
    onStatus?.(autoCandidate
      ? `${cloudLabel(primaryTarget)} is unavailable - Auto is trying ${cloudLabel(target)}...`
      : `${cloudLabel(primaryTarget)} is unavailable - trying backup ${cloudLabel(target)}...`);
    const fallbackStartedAt = Date.now();
    try {
      const message = await chatCompletion(target, messages, tools, signal, onToken);
      noteAutoModelOutcome(target, { ok: true, latencyMs: Date.now() - fallbackStartedAt });
      if (autoCandidate && Array.isArray(autoSelection.alternates)) {
        autoSelection.alternates = autoSelection.alternates.filter((candidate) =>
          candidate.provider !== target.provider || candidate.model !== target.model
        );
      }
      return { target, message };
    } catch (fallbackError) {
      noteAutoModelOutcome(target, { ok: false, latencyMs: Date.now() - fallbackStartedAt, error: fallbackError?.message || fallbackError });
      throw fallbackError;
    }
  }
}

// Map the UI budget preset ("small"|"normal"|"large") to per-run token and
// time caps. 0 means unlimited — the coding-agent loop continues until done.
const BUDGET_PRESETS = {
  small:  { tokens: 50_000,  timeMs: 120_000 },
  normal: { tokens: 150_000, timeMs: 600_000 },
  // Long runs still need a hard ceiling. Checkpoint and continue instead of
  // allowing a stuck paid-cloud loop to spend indefinitely.
  large:  { tokens: 400_000, timeMs: 1_800_000 }
};
function perRunTokenBudget(config) {
  const preset = config?.ui?.codingAgent?.budget || "normal";
  return BUDGET_PRESETS[preset]?.tokens ?? 0;
}
function perRunTimeBudgetMs(config) {
  const preset = config?.ui?.codingAgent?.budget || "normal";
  return BUDGET_PRESETS[preset]?.timeMs ?? 0;
}

function connectorSummary(config) {
  const c = config?.connectors || {};
  const mcp = (c.mcp || []).filter((x) => x.enabled !== false).map((x) => x.name || x.id).filter(Boolean);
  const agents = (c.agents || []).filter((x) => x.enabled !== false).map((x) => x.name || x.id).filter(Boolean);
  const email = ["gmail", "outlook"].filter((name) => c.email?.[name]?.connected)
    .map((name) => `${name === "gmail" ? "Gmail" : "Outlook"} (${c.email[name].account || "connected"})`);
  const parts = [];
  if (email.length) parts.push(`Email accounts connected: ${email.join(", ")}`);
  if (mcp.length) parts.push(`MCP servers configured: ${mcp.join(", ")}`);
  if (agents.length) parts.push(`Agent connectors configured: ${agents.join(", ")}`);
  return parts.join(" | ");
}

function cleanSystemPrompt(projectsDir, fullAccess, connectors, learned, config = null) {
  return booleanAgentPolicy();
}

export function systemPrompt(projectsDir = "", fullAccess = false, config = null) {
  return cleanSystemPrompt(projectsDir, fullAccess, connectorSummary(config), "", config);
}

// Prefer Boolean project rules, while retaining the two legacy Boollm paths
// so existing projects continue to work after the product rename.
// These files teach the project's coding style, commands, architecture, and constraints
// so it doesn't need to re-discover them every turn. Capped to 4 KB.
const MAX_RULES_BYTES = 4096;
export function loadProjectRules(projectDir) {
  try {
    if (!projectDir || !fs.existsSync(projectDir)) return "";
    const candidates = [
      path.join(projectDir, "BOOLEAN.md"),
      path.join(projectDir, ".boolean", "rules.md"),
      path.join(projectDir, "BOOLLM.md"),
      path.join(projectDir, ".boollm", "rules.md")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        let text = fs.readFileSync(candidate, "utf8").trim();
        if (!text) return "";
        // Strip a leading markdown H1 title to avoid redundancy.
        text = text.replace(/^#\s+.+\r?\n?/, "").trim();
        if (text.length > MAX_RULES_BYTES) text = text.slice(0, MAX_RULES_BYTES) + "\n…(rules truncated)";
        const relative = path.relative(projectDir, candidate).replaceAll("\\", "/");
        const label = relative === "BOOLLM.md" || relative === ".boollm/rules.md"
          ? `${relative} (legacy)`
          : relative;
        return `PROJECT RULES (from ${label}):\n${text}`;
      }
    }
  } catch { /* ignore */ }
  return "";
}

// Compact file map for project chats. Small local models rarely explore a
// codebase on their own, so every project run starts with this orientation
// instead of a blind folder path. Capped so it stays a few hundred tokens.
export function projectBrief(projectDir) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__",
    ".venv", "venv", "bin", "obj", "coverage", ".idea", ".vscode"]);
  const MAX_ENTRIES = 80;
  try {
    if (!projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return "";
    const lines = [];
    let count = 0;
    const walk = (dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries = entries
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= MAX_ENTRIES) { lines.push(prefix + "…more files not shown — use list_dir"); return; }
        if (SKIP.has(e.name.toLowerCase())) { if (e.isDirectory()) lines.push(prefix + e.name + "/ (skipped)"); continue; }
        count++;
        if (e.isDirectory()) {
          lines.push(prefix + e.name + "/");
          if (depth < 2) walk(path.join(dir, e.name), prefix + "  ", depth + 1);
        } else {
          lines.push(prefix + e.name);
        }
      }
    };
    walk(projectDir, "", 0);
    const header = [
      "",
      "",
      `PROJECT: This chat is bound to the folder ${projectDir}.`,
      "Work only on files in THIS folder. Choose the tools, order of work, level of inspection, and verification that fit the request.",
      "Use the project rules below when present. Boolean does not require a particular planning, preview, editing, or testing sequence."
    ];
    const rules = loadProjectRules(projectDir);
    if (rules) header.push(rules);
    if (!lines.length) return [...header, "The folder is currently empty."].join("\n");
    return [...header, "File map:", ...lines].join("\n");
  } catch {
    return "";
  }
}

// Fallback protocol for models/servers without native tool support:
// the model is asked to emit a fenced ```tool block containing JSON.
const ARTIFACT_TOOL_NAMES = new Set([
  "create_project", "list_dir", "read_file", "write_file", "run_project", "run_command", "read_page",
  "create_artifact", "generate_image", "run_guarded", "record_debug_evidence", "remember"
]);
const ARTIFACT_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => ARTIFACT_TOOL_NAMES.has(tool.function.name));
const RESEARCH_TOOL_NAMES = new Set(["web_search", "research_web"]);
const SALES_RESEARCH_TOOL_NAMES = new Set([
  "web_search",
  "research_web",
  "browser_open",
  "browser_click",
  "visible_browser_open",
  "visible_browser_control"
]);
const SALES_RESEARCH_FAILURE = /\b(?:no results?|empty|failed|failure|unavailable|network|timed out|could not|unable|blocked|error)\b/i;
const SALES_RESEARCH_TOTAL_LIMIT = 8;
const SALES_RESEARCH_FAILURE_LIMIT = 2;
const SALES_PRIMARY_EVIDENCE_CONTRADICTION = /\b(?:could not|couldn't|unable to|failed to|did not)\s+(?:load|open|access|retrieve|verify|read|confirm)[\s\S]{0,90}\b(?:site|website|domain|page|greenscan)|\b(?:site|website|domain)\s+(?:was\s+)?(?:not confirmed|unavailable|unverified)|\binferred from (?:the )?domain\b|\b(?:not even|no)\s+confirmation[\s\S]{0,90}\b(?:site|website|domain|greenscan)|\bsite not confirmed\b/i;
const SALES_PLAN_SECTION = /^(?:(?:#{1,4}\s+)|(?:\*\*\s*))?([1-5])[.)-]\s+/gmi;
const RESEARCH_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => RESEARCH_TOOL_NAMES.has(tool.function.name));
const INSPECT_TOOL_NAMES = new Set([
  "list_dir", "read_file", "find_files", "search_files", "repository_map", "find_symbol",
  "git_status", "git_diff", "git_log", "list_subagent_results", "read_process",
  "read_page", "inspect_page_layout", "screenshot_page", "visible_browser_read",
  "list_connectors", "mcp_list_tools", "cloudflare_list_resources", "cloud_hosting_list_resources", "notepad_read", "email_list", "email_read",
  "windows_system_info", "remember"
]);
const INSPECT_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => INSPECT_TOOL_NAMES.has(tool.function.name));
const COMPATIBILITY_INSPECT_TOOL_NAMES = new Set([
  "list_dir", "read_file", "find_files", "search_files", "repository_map", "find_symbol",
  "git_status", "git_diff", "remember"
]);
const ACTION_TOOL_NAMES = new Set(TOOL_DEFINITIONS
  .map((tool) => String(tool.function?.name || "").toLowerCase())
  .filter((name) => name && !RESEARCH_TOOL_NAMES.has(name)));
// A chat becomes a project workspace only through the UI's New project or
// Open folder actions. Never let a model silently turn an ordinary chat into a
// project or operate on config.projectsDir as an implicit workspace.
const PROJECT_WORKSPACE_TOOL_NAMES = new Set([
  "create_project", "list_dir", "read_file", "write_file", "run_project",
  "run_command", "find_files", "search_files", "repository_map", "find_symbol", "git_status",
  "git_diff", "git_log", "github_workflow", "run_guarded",
  "record_debug_evidence", "run_subagent", "list_subagent_results",
  "apply_subagent_result", "discard_subagent_result"
]);

function explicitlyNamedToolMode(text) {
  const names = String(text || "").toLowerCase().match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
  const known = names.filter((name) => ACTION_TOOL_NAMES.has(name));
  if (!known.length) return "";
  if (known.some((name) => !INSPECT_TOOL_NAMES.has(name) && !/^(?:email_|mcp_|cloudflare_|cloud_hosting_|agent_connector_|list_connectors$)/.test(name))) return "action";
  if (known.some((name) => /^(?:email_|mcp_|cloudflare_|cloud_hosting_|agent_connector_|list_connectors$)/.test(name) && !INSPECT_TOOL_NAMES.has(name))) return "connector";
  return "inspect";
}

function compactChatPrompt(config = null) {
  return "";
}

function compactResearchPrompt(config = null) {
  return "";
}

function compactInspectPrompt(config = null) {
  return "";
}

function preservedAppContext(content) {
  const text = String(content || "");
  const marker = "\n\nCURRENT APP CONTEXT:\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) return text.slice(idx).trim();
  if (text.startsWith("CURRENT APP CONTEXT:\n")) return text.trim();
  return "";
}

function withTurnModeSystem(messages, mode, config) {
  const copy = messages.map((message) => ({ ...message }));
  const policy = systemPrompt("", false, config);
  const systemIndex = copy.findIndex((message) => message?.role === "system");
  if (systemIndex >= 0) {
    const existing = String(copy[systemIndex].content || "").trim();
    if (!existing.includes("BOOLEAN OPERATING POLICY")) {
      copy[systemIndex].content = existing ? `${existing}\n\n${policy}` : policy;
    }
  } else {
    copy.unshift({ role: "system", content: policy });
  }
  return copy;
}

function fallbackToolPrompt(definitions = TOOL_DEFINITIONS, options = {}) {
  const compact = !!options.compact;
  const tools = compact
    ? definitions.map((t) => `${t.function.name}: ${t.function.description || ""}`.trim())
    : definitions.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }));
  return [
    "",
    "COMPATIBILITY TOOL PROTOCOL: To use a Boolean tool, reply with ONLY one fenced block like this:",
    "```tool",
    '{"name": "run_command", "arguments": {"command": "Get-Date"}}',
    "```",
    "Bare JSON, trailing JSON, prose instructions, and mutation commands are not executed.",
    "Continue using the available tools as needed to complete and verify the requested outcome. Boolean's shared loop guard pauses repeated calls that stop making progress.",
    compact ? "Available tools (name: purpose). Use the obvious JSON arguments for the selected tool:" : "Available tools (JSON schema):",
    compact ? tools.map((line) => `- ${line}`).join("\n") : JSON.stringify(tools, null, 2)
  ].join("\n");
}

function withFallbackToolProtocol(messages, definitions = TOOL_DEFINITIONS, options = {}) {
  const copy = messages.map((message) => ({ ...message }));
  const systemIndex = copy.findIndex((message) => message?.role === "system");
  if (systemIndex >= 0 && !String(copy[systemIndex].content || "").includes("TOOL PROTOCOL")) {
    copy[systemIndex].content = `${copy[systemIndex].content}\n${fallbackToolPrompt(definitions, options)}`;
  }
  return copy;
}

function patchModePrompt(reviewOnly = false) {
  if (reviewOnly) {
    return [
      "",
      "BOOLEAN REVIEW MODE: This model has no native tool access. Review the available evidence and answer plainly.",
      "Do not claim to edit files, run commands, browse, test, or deploy."
    ].join("\n");
  }
  return [
    "",
    "BOOLEAN COMPATIBILITY MODE: This model uses Boolean's validated text tool bridge instead of native function calls.",
    "Use the provided fenced tool-call protocol to inspect files, edit, run terminal commands, browse, test, and deploy when the task and approval policy allow it.",
    "To change files, return exactly ONE fenced boolean_patch block and no vague editing instructions:",
    "```boolean_patch",
    '{"edits":[{"path":"src/file.js","old":"exact existing text","new":"exact replacement"}]}',
    "```",
    "For a new file use {\"path\":\"relative/path\",\"content\":\"complete file content\"}.",
    "Paths must be relative to the open project. Existing-file old text must match exactly and uniquely.",
    "Boolean validates the complete patch before applying any edit. After editing, use the provided tools to test and verify the result."
  ].join("\n");
}

function withCompatibilityProtocol(messages, definitions, options = {}) {
  const copy = messages.map((message) => ({ ...message }));
  const systemIndex = copy.findIndex((message) => message?.role === "system");
  const protocol = [
    patchModePrompt(options.reviewOnly === true),
    definitions.length ? fallbackToolPrompt(definitions, { compact: true }) : ""
  ].filter(Boolean).join("\n");
  if (systemIndex >= 0 && !/BOOLEAN (?:COMPATIBILITY|REVIEW) MODE/.test(String(copy[systemIndex].content || ""))) {
    copy[systemIndex].content = `${copy[systemIndex].content}\n${protocol}`;
  }
  return copy;
}

const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

// Small models often emit tool calls as a fenced JSON block in plain text even
// when native tool calling is available, so this is checked in both modes.
export function parseFallbackToolCall(text, options = {}) {
  const candidates = [];
  const fenced = text.match(/```(?:tool|json)?\s*\n?(\{[\s\S]*?\})\s*```/);
  if (fenced) candidates.push({ text: fenced[1], fenced: true });
  const trimmed = text.trim();
  // Some providers ignore the requested fence and return a plain tool object,
  // sometimes after one sentence of commentary. It is safe to accept that in
  // strict compatibility mode because both the global known-tool catalog and
  // this turn's allowed-tool set are checked below before anything executes.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push({ text: trimmed, fenced: false });
  const trailing = trimmed.match(/(\{[\s\S]*"name"\s*:\s*"(?:[^"]+)"[\s\S]*\})\s*$/);
  if (trailing) candidates.push({ text: trailing[1], fenced: false });
  const allowed = options.allowedNames instanceof Set ? options.allowedNames : KNOWN_TOOLS;

  for (const candidate of candidates) {
    // Tolerate only surplus closing braces at the very end. This repairs the
    // common text-generation slip without attempting to reinterpret malformed
    // arguments or execute prose as a command.
    let repaired = String(candidate.text || "").trim();
    for (let surplus = 0; surplus <= 2; surplus++) {
      try {
        const obj = JSON.parse(repaired);
        if (obj && KNOWN_TOOLS.has(obj.name) && allowed.has(obj.name)) {
          // Compatibility-mode file mutations deliberately require the fenced
          // protocol (or boolean_patch) so prose examples can never become an
          // edit. Inspection/check commands may recover from a missing fence;
          // their normal approval and workspace boundaries still apply.
          if (options.strict && !candidate.fenced && ["write_file", "edit_file"].includes(obj.name)) break;
          const args = obj.arguments || obj.parameters || {};
          if (args && typeof args === "object" && !Array.isArray(args)) {
            return { name: obj.name, arguments: args };
          }
        }
        break;
      } catch {
        if (!repaired.endsWith("}")) break;
        repaired = repaired.slice(0, -1).trimEnd();
      }
    }
  }
  return null;
}

function compatibilityToolDefinitions(definitions = []) {
  return definitions.filter((tool) => COMPATIBILITY_INSPECT_TOOL_NAMES.has(String(tool.function?.name || "")));
}

function preflightBooleanPatch(edits) {
  for (const edit of edits) {
    if (edit.kind === "create") {
      if (fs.existsSync(edit.absolute)) throw new Error(`Patch refused: '${edit.path}' already exists.`);
      continue;
    }
    if (!fs.existsSync(edit.absolute)) throw new Error(`Patch refused: '${edit.path}' does not exist.`);
    const current = fs.readFileSync(edit.absolute, "utf8");
    const occurrences = current.split(edit.old).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Patch refused: exact old text in '${edit.path}' matched ${occurrences} times; expected exactly once.`);
    }
  }
}

function saveCapabilityResult(config, target, supported, reason, onCapabilityChange) {
  const previous = nativeToolSupport(config, target);
  recordNativeToolSupport(config, target, supported, reason);
  if (previous !== supported) {
    try { onCapabilityChange?.(config.modelCapabilities); } catch { /* capability caching must not block a task */ }
  }
}

function convertNativeToolHistoryToText(messages) {
  const ids = new Map();
  const converted = [];
  for (const m of messages || []) {
    if (m?.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) {
        if (call?.id) ids.set(call.id, call.function?.name || "tool");
      }
      if (typeof m.content === "string" && m.content.trim()) {
        converted.push({ role: "assistant", content: m.content });
      }
      continue;
    }
    if (m?.role === "tool") {
      const name = ids.get(m.tool_call_id) || "tool";
      converted.push({ role: "user", content: `TOOL RESULT for ${name}:\n${m.content || ""}` });
      continue;
    }
    converted.push(m);
  }
  messages.splice(0, messages.length, ...converted);
}

function errorChainText(err) {
  const parts = [];
  let current = err;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.body) parts.push(current.body);
    if (current.message) parts.push(current.message);
  }
  return parts.join(" ");
}

function looksLikeNoToolSupport(err) {
  const text = errorChainText(err);
  return /does not support tools|tools? (is|are) not supported|no tool|unknown field.{0,20}tools|messages parameter is illegal|"?code"?\s*:?\s*"?1214"?/i
    .test(text);
}

function looksLikeMalformedNativeToolCall(err) {
  const text = errorChainText(err);
  return /failed to parse tool call arguments|tool call arguments.{0,40}(?:invalid|json|parse)|json\.exception\.parse_error/i
    .test(text);
}

function looksLikeRejectedNativeToolPrompt(err) {
  const text = errorChainText(err);
  return /prompt parameter was not received normally|prompt parameter.{0,60}(?:invalid|illegal|missing|not received)/i
    .test(text);
}

function looksLikeUnsupportedImageContent(err) {
  const text = errorChainText(err);
  return /"?code"?\s*:\s*"?1210"?|messages?\.content\.type.{0,80}(?:invalid|allowed values?.{0,20}text)|image_url.{0,50}(?:unsupported|invalid|not allowed)/i
    .test(text);
}

function withTextOnlyContent(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const text = message.content
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text || ""))
      .filter(Boolean)
      .join("\n\n");
    return { ...message, content: text || "An image was captured, but this model accepts text only. Continue using the tool result and page text." };
  });
}

function persistScreenshotTextFallback(messages) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    const text = message.content
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text || ""))
      .filter(Boolean)
      .join("\n\n");
    if (/^Here is the screenshot you captured\b/i.test(text)) {
      message.content = `${text}\n\nThe selected model accepts text only, so continue from the screenshot tool result and page text.`;
    }
  }
}

// rough token estimate for context-budget trimming. ~3.3 chars/token is
// deliberately conservative (code and shell output are token-dense) so the
// estimate errs on the side of trimming more, never overflowing the window.
function approxTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
  }
  return Math.ceil(chars / 3.3);
}

function fitReserveForMode(mode = "balanced") {
  return mode === "full" ? 1000 : 2000;
}

function localContextWindow(config, target) {
  return Math.max(2048, Number(target?.ctx || config?.local?.ctx || 8192) || 8192);
}

function localBudgetFromContext(ctxWindow, mode = "balanced") {
  const windowTokens = Math.max(2048, Number(ctxWindow) || 8192);
  const fitReserve = fitReserveForMode(mode);
  if (windowTokens <= 8192) {
    // Local requests include tool schemas and controller text that are not part
    // of chat history. Keep the sent message history well under the engine
    // window so small 8k models do not reject ordinary follow-up turns.
    return mode === "full" ? 3072 : 4096;
  }
  const toolHeadroom = Math.min(7000, Math.max(3500, Math.floor(windowTokens * 0.18)));
  return Math.max(4096, windowTokens - toolHeadroom - 600 + fitReserve);
}

export function contextBudgetForTarget(config, target, mode = "balanced", projectDir = "") {
  if (config?.provider === "local" || target?.provider === "local") {
    return localBudgetFromContext(localContextWindow(config, target), mode);
  }
  return projectDir ? 48000 : 128000;
}

export function contextLimitFromError(err) {
  const text = `${err?.body || ""}\n${err?.message || ""}`;
  try {
    const parsed = JSON.parse(String(err?.body || "{}"));
    const nCtx = parsed?.error?.n_ctx ?? parsed?.n_ctx;
    if (Number.isFinite(Number(nCtx))) return Number(nCtx);
  } catch { /* fall through to regex parsing */ }
  const patterns = [
    /"n_ctx"\s*:\s*(\d+)/i,
    /\bn_ctx\b[^\d]{0,16}(\d+)/i,
    /available context size[^\d]{0,16}(\d+)/i,
    /context size[^\d]{0,16}(\d+)/i,
    /maximum context length[^\d]{0,16}(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function plainMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.split(/\n\nCURRENT APP CONTEXT\b/)[0].trim();
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").split(/\n\nCURRENT APP CONTEXT\b/)[0].trim();
  }
  return "";
}

// File attachments are appended to the user's visible instruction so the
// provider can read them. They are evidence, not authority for the current
// turn: a pasted report that says "read only" or "replace the logo" must not
// silently change how Boolean routes the instruction above it.
const ATTACHED_FILE_BLOCK = /\r?\n\s*\r?\nAttached file [^\r\n]+:\s*\r?\n```[\s\S]*$/i;

export function currentTurnInstructionText(messageOrText) {
  const text = typeof messageOrText === "string"
    ? String(messageOrText).split(/\n\nCURRENT APP CONTEXT\b/)[0].trim()
    : plainMessageText(messageOrText);
  const attachmentIndex = text.search(ATTACHED_FILE_BLOCK);
  return (attachmentIndex >= 0 ? text.slice(0, attachmentIndex) : text).trim();
}

const ARTIFACT_ACTION = /\b(build|create|make|implement|code|develop|set up|setup|finish|fix|edit|update|write|change|modify|replace|swap|apply|use|put|switch|rebrand|restyle|regenerate)\b/i;
const ARTIFACT_TARGET = /\b(game|app|application|website|web ?site|web page|api|project|program|script|code|files?|folders?|desktop tool|server|logos?|icons?|assets?|images?|svg|png|html|css|brands?|branding|headers?|pwa)\b/i;
const ACTION_ONLY_FOLLOWUP = /\b(?:make|build|create|implement|finish|do|replace|swap|apply|use|put|switch|rebrand|restyle|regenerate)\s+(?:it|this|that|those|them|all that|all of (?:it|that|those|them))(?:\s+for me)?\b/i;
const ANSWER_ONLY_ARTIFACT = /\b(?:ideas?|examples?|recommendations?|suggestions?|list of|which|whether|why|what (?:game|app|website)|how (?:can|could|would|do|does|to)|should (?:we|i|you)|would it)\b/i;
const ANSWER_ONLY_REQUEST = /\b(?:do\s*not|don't|dont|no)\s+(?:make\s+)?(?:changes?|edits?|updates?|modify|write|touch|code)\b|\b(?:just|only)\s+(?:tell|explain|describe|summari[sz]e|review|show|list|answer)\b|\b(?:tell|explain|describe|summari[sz]e|review|show|list)\s+(?:me\s+)?(?:about|what|where|how|everything|the current|this project)\b/i;
// A question ABOUT a change is not an instruction to make it. The verb lists
// above cannot tell them apart — "1 thing we can change" and "change this thing"
// share every keyword — so this reads sentence FORM instead, which is far more
// stable than vocabulary. "Can you add X" is a question only in punctuation, so
// polite commands are excluded before the advisory shapes are tested.
const POLITE_COMMAND = /^\s*(?:so\s+|ok(?:ay)?[,\s]+|now\s+)?(?:please\s+)?(?:can|could|would|will)\s+(?:you|u|we)\b|\bplease\s+(?:add|build|change|create|edit|fix|implement|make|update|write|remove|delete|move|rename|replace|run|deploy|do)\b|\bgo\s+ahead\b|\bdo\s+it\b/i;
const ADVISORY_REQUEST = new RegExp([
  // opens with an interrogative or an opinion word
  "^\\s*(?:what|why|which|who|when|where|how|should|is|are|was|were|do|does|did|any|thoughts?|opinion)\\b",
  // asks for a quantity of ideas: "give 1 thing", "list a few improvements"
  "\\b(?:give|list|name|show|suggest|recommend|share)\\s+(?:me\\s+)?(?:\\d+|a|an|one|two|three|some|a few|the top|your)?\\s*(?:thing|things|idea|ideas|change|changes|improvement|improvements|suggestion|suggestions|option|options|recommendation|recommendations|way|ways|thought|thoughts)\\b",
  // "what would you change", "where should we start"
  "\\b(?:what|which|where|how)\\s+(?:would|should|could|do|can)\\s+(?:you|we|i)\\b",
  // "your thoughts", "any advice"
  "\\b(?:your|any)\\s+(?:thoughts?|opinion|advice|recommendations?|suggestions?)\\b",
  // "worth doing?", "is it worth changing"
  "\\bworth\\s+(?:doing|changing|adding|fixing|building)\\b",
  // trailing question mark on a sentence that is not a polite command
  "\\?\\s*$"
].join("|"), "i");

/** True when the message asks for an opinion or idea rather than ordering work. */
export function looksLikeAdviceRequest(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (POLITE_COMMAND.test(value)) return false;
  return ADVISORY_REQUEST.test(value);
}

/**
 * The build keywords fired, but the sentence reads like a question. These are the
 * only turns worth spending a model call on — everything else is already decided
 * confidently by form plus keywords.
 */
export function artifactIntentAmbiguous(messages) {
  const latest = currentTurnInstructionText(
    [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === "user")
  );
  if (!latest || ANSWER_ONLY_REQUEST.test(latest)) return false;
  if (!ARTIFACT_ACTION.test(latest) || !ARTIFACT_TARGET.test(latest)) return false;
  return looksLikeAdviceRequest(latest) || ANSWER_ONLY_ARTIFACT.test(latest);
}
const INSPECT_REQUEST = /\b(?:project|repo(?:sitory)?|codebase|files?|folder|git|diff|changes?|status|progress|roadmap|implementation|what (?:was|is|has been) (?:changed|done|built|implemented)|where (?:are we|is the project)|last (?:deploy|build|update))\b/i;
const CONTEXTUAL_INSPECTION_REQUEST = /\b(?:review|inspect|analy[sz]e|assess|audit|evaluate|improve|improvements?|recommend(?:ation)?s?|suggest(?:ion)?s?)\b[\s\S]{0,100}\b(?:this|the|it|current|local|running)?\s*(?:app|application|site|website|project|code|ui|layout|version)\b|\bhow (?:can|could|would|should|do)\s+(?:you\s+)?improve\b/i;
const LOCAL_PROJECT_CONTEXT = /(?:[a-z]:\\[^\r\n`]+|(?:^|[\s`])(?:\.{0,2}[\\/])?(?:src|app|public|outputs?|projects?|build|dist)[\\/][^\s`]+|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|(?:project|source|local-ready copy|production build)\s*:)/i;
const RESEARCH_REQUEST = /\b(?:current|latest|today|tonight|tomorrow|yesterday|right now|live|news|headline|weather|forecast|score|won|winner|match|game|fixture|schedule|stock|stocks|market|price|earnings|dividend|available|availability|search|look up|lookup|web|internet|source|sources|cite)\b/i;
const AGENT_REQUEST = /\b(?:deploy|package|build|create|make|implement|fix|edit|update|write|install|download|move|delete|rename|open|run|test|connect|configure|settings|notepad|browser|email|reply|mcp|cloudflare|github|commit|push|schedule|task|project|folder|file|windows)\b/i;
const CONNECTOR_CONTEXT = /\b(?:mcp|connector|cloudflare|cloudflare workers?|cloudflare pages|stocksignal|stockunc|robinhood|trade ideas?|signals?|strategy feeds?|watchlist|positions?|orders?|(?:stock|market|trading)\s+scanners?|scanners?\s+(?:feeds?|signals?|strateg(?:y|ies)|watchlists?))\b/i;
const CONNECTOR_ACTION_REQUEST = /\b(?:check|checking|connected|connection|connect|use|call|pull|fetch|get|see|refresh|try again|any (?:other|new|more)|trade ideas?|signals?|scanner|strategy feeds?|watchlist|positions?|orders?|buy|sell|trade|place|submit|execute|cancel|close|send|post|publish|upload|download|create|add|remove|delete|move|update|change|approve|confirm)\b/i;
const CONNECTOR_DATA_ACTION = /\b(?:pull|fetch|get|give|show|list|all|any (?:other|new|more)|trade ideas?|signals?|scanner|strategy feeds?|watchlist|positions?|orders?)\b/i;
const CONNECTOR_MUTATION_ACTION = /\b(?:buy|sell|trade|place|submit|execute|cancel|close|send|post|publish|upload|create|add|remove|delete|move|update|change|approve|confirm)\b/i;
const CONNECTOR_PROGRESS_FOLLOWUP = /\b(?:are you (?:checking|doing|working)|did you check|doing it now|checking it|check now|what happened|still checking|try again|refresh it)\b/i;
const EMAIL_CLEANUP_CONFIRMATION = /^(?:yes(?:\s+(?:do it|please|go ahead))?|go ahead|do it|proceed|confirm(?:ed)?|okay(?:\s+(?:do it|go ahead))?|ok(?:\s+(?:do it|go ahead))?|continue|run it|run the (?:next|second) batch)[.!? ]*$/i;
const EMAIL_CLEANUP_BATCH_REQUEST = /\b(?:do|run|process|move|trash|continue)\b[\s\S]{0,80}\b(?:second|next|remaining)\b[\s\S]{0,60}\b(?:batch|messages?|candidates?)\b/i;
const EMAIL_CLEANUP_PENDING_PROMPT = /\b(?:confirm|go ahead|proceed|second batch|next batch|remaining candidates?|cleanup batch|move[\s\S]{0,50}trash|trash[\s\S]{0,50}(?:messages?|candidates?))\b/i;
// text that signals the model is describing MORE work instead of finishing it —
// small models often narrate the next step rather than doing it and then stop
const MORE_WORK_INTENT = /\b(?:i\s*(?:'ll|will|am going to|need to|can|should|have to)\s+(?:now\s+|then\s+|also\s+)?(?:add|create|build|write|implement|update|make|set ?up|style|wire|continue|proceed|finish|start|handle|generate|scaffold|develop|do|read|open|check|look|inspect|trace|examine|review|view|search|find|scan|explore|investigate|verify|test|run)|next step|next[,:]|let'?s\s+(?:now\s+)?(?:add|create|build|write|implement|continue|proceed|finish|do|read|open|check|look|inspect|start)|let us\s+(?:now\s+)?(?:add|create|build|continue|proceed|finish|do|read|check|look)|still (?:need|have) to|remaining\b|to-?do\b|step \d+\b|going to\s+(?:add|create|build|write|implement|make|finish|do|read|check|look|inspect)|shall i\b|would you like me to\b|after (?:that|this)\b|proceed to\b)/i;

// A pure announcement of an imminent step ("let me read the files now",
// "I'll check agent.js") with no deliverable and no tool call. Small/mid models
// narrate the next action and then stop; this catches that so the loop can push
// them to actually take the step instead of accepting the narration as an answer.
const ANNOUNCE_ACTION = /\b(?:let me|let'?s|i'?ll|i will|i'?m going to|i am going to|allow me to|first,?\s*i'?ll|now i'?ll)\s+(?:just\s+|now\s+|actually\s+|first\s+|then\s+|go\s+(?:ahead\s+)?(?:and\s+)?|start by\s+|begin by\s+|quickly\s+)?(?:read|open|check|look|inspect|trace|examine|review|view|see|find|search|grep|scan|explore|investigate|get|start|begin|continue|proceed|add|create|build|write|implement|update|edit|fix|run|wire|load|pull|fetch|call|connect|place|execute|submit|send|install|deploy|publish)\b/i;

// True when a response is a short bare announcement of an imminent step with no
// deliverable — the "let me read the files now" stall. The loop uses this to
// push the model to actually call a tool instead of accepting the narration.
export function announcesUnperformedAction(text) {
  const value = String(text || "").trim();
  if (!value || value.length >= 400) return false;
  return ANNOUNCE_ACTION.test(value);
}

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolCallForResult(messages, resultIndex) {
  const result = messages[resultIndex];
  const callId = String(result?.tool_call_id || "");
  for (let i = resultIndex - 1; i >= Math.max(0, resultIndex - 4); i--) {
    for (const call of messages[i]?.tool_calls || []) {
      if (!callId || String(call.id || "") === callId) return call;
    }
  }
  return null;
}

// Preserve a reviewed cleanup plan across short confirmations such as "go
// ahead". This keeps second and later batches out of answer-only chat mode.
export function emailCleanupContinuationAction(messages) {
  const source = Array.isArray(messages) ? messages : [];
  let latestIndex = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i]?.role === "user" && !/^SYSTEM PREFLIGHT:/i.test(plainMessageText(source[i]))) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 1) return null;
  const latest = currentTurnInstructionText(source[latestIndex]);
  if (!latest || /^(?:no|stop|cancel|never|do not|don't|dont)\b/i.test(latest)) return null;
  const confirmed = EMAIL_CLEANUP_CONFIRMATION.test(latest) ||
    (latest.length <= 180 && /\bconfirm(?:ing|ed)?\b/i.test(latest) && /\bgo ahead\b/i.test(latest));
  if (!confirmed && !EMAIL_CLEANUP_BATCH_REQUEST.test(latest)) return null;

  const assistantContext = [];
  for (let i = latestIndex - 1; i >= 0 && assistantContext.length < 3; i--) {
    if (source[i]?.role !== "assistant") continue;
    const text = plainMessageText(source[i]);
    if (text) assistantContext.push(text);
  }
  if (!EMAIL_CLEANUP_PENDING_PROMPT.test(assistantContext.join("\n"))) return null;

  for (let i = latestIndex - 1; i >= Math.max(1, latestIndex - 18); i--) {
    if (source[i]?.role !== "tool") continue;
    const call = toolCallForResult(source, i);
    const toolName = String(call?.function?.name || "");
    if (toolName !== "email_cleanup_preview" && toolName !== "email_cleanup_trash") continue;
    const text = String(source[i].content || "");
    const data = parsedJsonObject(text) || {};
    const callArgs = parsedJsonObject(call?.function?.arguments) || {};
    const planId = String(data.planId || callArgs.plan_id || text.match(/"planId"\s*:\s*"([^"]+)"/i)?.[1] || "").trim();
    const provider = String(data.provider || callArgs.provider || text.match(/"provider"\s*:\s*"(gmail|outlook)"/i)?.[1] || "").toLowerCase();
    const remaining = Number(data.remainingCandidates ?? data.remainingCount ?? data.candidateCount ?? 0);
    if (!planId || !["gmail", "outlook"].includes(provider) || !Number.isFinite(remaining) || remaining <= 0) return null;
    return {
      name: "email_cleanup_trash",
      args: { provider, plan_id: planId, batch_size: Math.min(250, Math.floor(remaining)) },
      remaining
    };
  }
  return null;
}

export function classifyTurnMode(messages, options = {}) {
  const latest = currentTurnInstructionText(options.latestText ?? [...(messages || [])].reverse().find((message) => message?.role === "user"));
  const artifactActionRequired = options.artifactActionRequired ?? requiresArtifactAction(messages);
  if (emailCleanupContinuationAction(messages)) return "connector";
  if (options.connectorActionRequired || requiresConnectorContinuationAction(messages)) return "connector";
  const explicitToolMode = explicitlyNamedToolMode(latest);
  if (explicitToolMode) return explicitToolMode;
  // Advice about "this app/site/project" is not generic chat when the open
  // conversation already established a local artifact. Route it through the
  // read-only inspection tools so the model can examine the actual files
  // instead of promising to review them and ending the turn.
  if (!options.directAction && CONTEXTUAL_INSPECTION_REQUEST.test(latest)) {
    const priorContext = (messages || [])
      .slice(-10)
      .filter((message) => plainMessageText(message) !== latest)
      .map(plainMessageText)
      .join("\n");
    if (options.projectDir || LOCAL_PROJECT_CONTEXT.test(priorContext)) return "inspect";
  }
  if (ANSWER_ONLY_REQUEST.test(latest) && !options.directAction) {
    if (options.projectDir || INSPECT_REQUEST.test(latest)) return "inspect";
    return RESEARCH_REQUEST.test(latest) ? "research" : "chat";
  }
  if (options.directAction || artifactActionRequired) return "action";
  if (RESEARCH_REQUEST.test(latest)) return "research";
  if (INSPECT_REQUEST.test(latest) && /\b(?:status|progress|review|inspect|check|show|list|tell|explain|summari[sz]e|what|where)\b/i.test(latest)) return "inspect";
  // AGENT_REQUEST is deliberately broad (it matches "task", "project", "file"),
  // so a question that merely mentions one of those words must not become an action.
  if (AGENT_REQUEST.test(latest) && !ANSWER_ONLY_ARTIFACT.test(latest) && !looksLikeAdviceRequest(latest)) return "action";
  return "chat";
}

export function isLightweightLocalChat(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 140) return false;
  return /^(?:hi|hello|hey|howdy|good (?:morning|afternoon|evening)|thanks|thank you|what can you do(?: for me)?|tell me a (?:short )?(?:story|joke)|how are you)[.!?]*$/i.test(value);
}

export function toolDefinitionsForTurnMode(mode, artifactActionRequired = false, completedToolWork = false, projectBound = false) {
  // Keep the full catalog visible on every normal main-chat turn. The model
  // should decide whether a tool is useful; Boolean's controller, approvals,
  // and tool implementations remain the authority for whether a requested
  // action may execute. Project filesystem tools are the one deliberate
  // boundary: the user must first create or open a project from the UI.
  return TOOL_DEFINITIONS.filter((tool) => {
    const name = String(tool.function?.name || "");
    if (name === "create_project") return false;
    return projectBound || !PROJECT_WORKSPACE_TOOL_NAMES.has(name);
  });
}

function isRealUserRequest(message) {
  if (message?.role !== "user") return false;
  const text = plainMessageText(message).trim();
  return !!text
    && !/^SYSTEM PREFLIGHT:/i.test(text)
    && !/^BOOLEAN CONTINUATION:/i.test(text)
    && !/^TOOL RESULT for /i.test(text)
    && !/^Screenshot captured by the requested tool\./i.test(text);
}

export function focusedMessagesForTurn(messages, mode) {
  const focused = focusConversation(messages);
  if (mode === "action") return withRecentTaskStatusMemory(focused, messages);
  if (mode === "connector") {
    // Connector requests are usually self-contained ("connect to X", "check
    // connector Y"). Do not make the provider reread a long project chat before
    // it can perform the first local connector lookup. Preserve the newest real
    // request plus a short rolling tail so later tool results still have enough
    // context to finish the same turn.
    const system = focused[0];
    const request = [...focused].reverse().find(isRealUserRequest)
      || [...(messages || [])].reverse().find(isRealUserRequest);
    const requestIndex = request ? focused.lastIndexOf(request) : -1;
    const currentTurn = requestIndex >= 0 ? focused.slice(requestIndex + 1) : focused.slice(1);
    const recent = currentTurn.slice(-4);
    const tail = recent.filter((message) => message !== request);
    return [system, ...(request ? [request] : []), ...tail];
  }
  const system = focused[0];
  const keep = mode === "research" || mode === "inspect" ? 10 : 6;
  const recent = focused.slice(1).slice(-keep);
  if (mode !== "research" && mode !== "inspect") return [system, ...recent];

  // A read-only inspection can produce several assistant/tool pairs before the
  // model has enough evidence to answer. Keep the latest real user request
  // alongside the rolling tool tail so the request cannot fall out of context
  // and leave the model looking at an unexplained file snippet.
  const request = [...focused].reverse().find(isRealUserRequest)
    || [...(messages || [])].reverse().find(isRealUserRequest);
  const summaries = focused.slice(1).filter((message) => message?.role === "system").slice(-1);
  const tail = recent.filter((message) => message !== request && !summaries.includes(message));
  return [system, ...summaries, ...(request ? [request] : []), ...tail];
}

const STATUS_FOLLOWUP = /\b(?:finish|continue|do|build|make|implement|fix|handle|work on|start)\b[\s\S]{0,80}\b(?:\d+(?:\s*[-–]\s*\d+)?|remaining|missing|those|that|them|next)\b/i;
const STATUS_REPORT_HINT = /\b(?:real status|roadmap|status|implemented|built|not started|missing|remaining|line \d+|files changed|checks|deploy)\b/i;
const STATUS_TABLE_HINT = /\|\s*(?:roadmap item|item|status|what changed|files?|checks?)\s*\|/i;

export function recentTaskStatusMemory(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return "";
  let latestUserIndex = -1;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]?.role === "user" && !/^SYSTEM PREFLIGHT:/i.test(plainMessageText(messages[i]))) {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 1) return "";
  const latest = currentTurnInstructionText(messages[latestUserIndex]);
  if (!STATUS_FOLLOWUP.test(latest)) return "";

  for (let i = latestUserIndex - 1; i > Math.max(0, latestUserIndex - 12); i--) {
    if (messages[i]?.role !== "assistant") continue;
    const text = plainMessageText(messages[i]).trim();
    if (!text || text.length < 80) continue;
    if (!STATUS_TABLE_HINT.test(text) && !STATUS_REPORT_HINT.test(text)) continue;
    const compact = text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return compact.length > 3000 ? `${compact.slice(0, 3000)}\n[status report clipped]` : compact;
  }
  return "";
}

function withRecentTaskStatusMemory(focused, fullMessages) {
  const status = recentTaskStatusMemory(fullMessages);
  if (!status) return focused;
  const note = [
    "RECENT TASK STATUS FROM THIS CHAT:",
    status,
    "",
    "Use this status report as source-of-truth for shorthand follow-ups such as item numbers, ranges, 'those', 'remaining', or 'finish 7-9'.",
    "Resolve the user's latest follow-up from this report before inspecting files. Do not reread the whole project just to rediscover this same status; inspect only the targeted files needed to implement or verify the referenced missing work."
  ].join("\n");
  const copy = focused.map((message) => ({ ...message }));
  if (copy[0]?.role === "system") copy.splice(1, 0, { role: "system", content: note });
  else copy.unshift({ role: "system", content: note });
  return copy;
}

// Keep the model in charge of implementation details, but recognize the narrow
// case where a user clearly asked Boolean to produce a software/file artifact.
// This is used only to retry a model that answered with a tutorial and made no
// tool call; it does not route or execute an action itself.
export function requiresArtifactAction(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .map(plainMessageText)
    .filter(Boolean);
  const latestUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === "user");
  const latest = currentTurnInstructionText(latestUser);
  if (ANSWER_ONLY_REQUEST.test(latest)) return false;
  if (ARTIFACT_ACTION.test(latest) && ARTIFACT_TARGET.test(latest)
      && !ANSWER_ONLY_ARTIFACT.test(latest) && !looksLikeAdviceRequest(latest)) return true;
  if (!ACTION_ONLY_FOLLOWUP.test(latest)) return false;
  return users.slice(-4, -1).some((text) => ARTIFACT_TARGET.test(text));
}

export function requiresConnectorContinuationAction(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const latestUser = [...source].reverse().find((message) => message?.role === "user");
  const latest = currentTurnInstructionText(latestUser);
  if (!latest) return false;
  const recent = source
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-8, -1)
    .map(plainMessageText)
    .filter(Boolean)
    .join("\n");
  const connectorMentioned = CONNECTOR_CONTEXT.test(latest) || CONNECTOR_CONTEXT.test(recent);
  if (!connectorMentioned) return false;
  return CONNECTOR_ACTION_REQUEST.test(latest) || CONNECTOR_PROGRESS_FOLLOWUP.test(latest);
}

export function requiresConnectorToolResult(messages) {
  if (!requiresConnectorContinuationAction(messages)) return false;
  const source = Array.isArray(messages) ? messages : [];
  const latestUser = [...source].reverse().find((message) => message?.role === "user");
  const latest = currentTurnInstructionText(latestUser);
  if (CONNECTOR_DATA_ACTION.test(latest) || CONNECTOR_MUTATION_ACTION.test(latest)) return true;
  const recent = source
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-8, -1)
    .map(plainMessageText)
    .filter(Boolean)
    .join("\n");
  return CONNECTOR_PROGRESS_FOLLOWUP.test(latest) && /\b(?:pull|fetch|get|scanner|strategy feeds?|trade ideas?|signals?|watchlist|positions?|orders?)\b/i.test(recent);
}

export function isExplicitTaskContinuation(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /^(?:(?:yes|ok(?:ay)?|right)\s*,?\s*)?(?:please\s+)?(?:continue|resume|keep going|go on|finish|finish it|try again|retry|go ahead|carry on|keep working|move forward|do it|start(?:\s+(?:please|it|now|building(?:\s+it)?|working(?:\s+on\s+it)?))?|begin(?:\s+(?:it|now|building|working))?|(?:go to\s+)?(?:the\s+)?next step|continue where you left off|run the (?:next|second) batch)\b/i.test(value);
}

// A stopped build often receives a short correction instead of the literal
// word "continue" (for example, "just name it chess"). Keep this narrower
// than normal action routing: the server only uses it when an interrupted
// task already exists, and the text must clearly refer to that task.
export function isTaskRefinement(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 240) return false;
  if (ANSWER_ONLY_REQUEST.test(value) || /^(?:what|why|where|when|who|how|is|are|did|does|can|could|would)\b/i.test(value)) return false;
  return /^(?:(?:just|also|and|but|please)\s+)*(?:(?:name|call|title)\s+(?:it|this|that)\b|(?:save|put|move|place|open|run|test|deploy|install)\s+(?:it|this|that)\b|(?:make|change|set|keep|use|add|remove|include|exclude|rename)\b[\s\S]{0,120}\b(?:it|this|that|game|app|site|website|project|file|folder|color|name|title|size|style|theme)\b)/i.test(value);
}

export function requiresExplicitActionToolResult(messages) {
  const source = Array.isArray(messages) ? messages : [];
  if (emailCleanupContinuationAction(source)) return true;
  const latestUser = [...source].reverse().find((message) => message?.role === "user");
  const latest = currentTurnInstructionText(latestUser).toLowerCase();
  const pattern = /\b(?:call|use|run|invoke|execute)\s+(?:the\s+)?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
  for (const match of latest.matchAll(pattern)) {
    const prefix = latest.slice(Math.max(0, match.index - 18), match.index);
    if (/\b(?:do not|don't|dont|never|without)\s*$/.test(prefix)) continue;
    if (ACTION_TOOL_NAMES.has(match[1])) return true;
  }
  return false;
}

function withActionNudge(messages, bootstrapContext = "", projectBound = false) {
  return messages;
}

function conversationDomain(text) {
  const s = String(text || "").toLowerCase();
  if (/\b(stock|stocks|market|nasdaq|dow|s&p|share price|earnings)\b/.test(s)) return "finance";
  if (/\b(fifa|soccer|football|nba|nfl|nhl|mlb|score|match|game|tournament)\b/.test(s)) return "sports";
  if (/\b(weather|forecast|temperature|rain|snow)\b/.test(s)) return "weather";
  if (/\b(news|headline|breaking)\b/.test(s)) return "news";
  if (/\b(display|desplay|screen|resolution|brightness|windows settings|bluetooth|wifi|network settings)\b/.test(s)) return "windows";
  if (/\b(email|gmail|outlook|reply|inbox)\b/.test(s)) return "email";
  if (/\b(code|coding|api|website|project|function|bug|program)\b/.test(s)) return "code";
  if (/\b(notepad|note|notes)\b/.test(s)) return "notes";
  return "";
}

// Keep enough recent context for normal follow-ups without dragging an entire
// old search session into every answer. This is especially important for small
// local models, which otherwise latch onto old tool results and ignore the user.
function focusConversation(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return messages;
  const system = messages[0];
  let latestIndex = -1;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]?.role === "user" && !/^SYSTEM PREFLIGHT:/i.test(plainMessageText(messages[i]))) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) return messages;
  const latest = messages[latestIndex];
  const latestText = plainMessageText(latest).toLowerCase();
  if (!latestText) return messages;

  if (/^(hi|hello|hey|good (morning|afternoon|evening)|start over|new topic)[.!? ]*$/.test(latestText)) {
    return [system, ...messages.slice(latestIndex)];
  }

  const userIndexes = [];
  for (let i = 1; i <= latestIndex; i++) {
    if (messages[i]?.role === "user" && !/^SYSTEM PREFLIGHT:/i.test(plainMessageText(messages[i]))) userIndexes.push(i);
  }
  const previousUserIndex = userIndexes.length > 1 ? userIndexes[userIndexes.length - 2] : -1;
  if (/^(ready|ok|okay|yes|no|thanks|thank you)[.!? ]*$/.test(latestText) ||
      /\b(what are (you|u) saying|that'?s not|thats not|you misunderstood|not what i asked)\b/.test(latestText)) {
    return previousUserIndex > 0 ? [system, ...messages.slice(previousUserIndex)] : [system, ...messages.slice(latestIndex)];
  }

  const currentDomain = conversationDomain(latestText);
  if (currentDomain && userIndexes.length > 1) {
    // Check a window of recent user messages (up to 3) for domain consistency.
    // Only cut if the majority are a different domain, not just one outlier.
    const windowSize = Math.min(3, userIndexes.length - 1);
    let differentCount = 0;
    for (let w = 0; w < windowSize; w++) {
      const prevIdx = userIndexes[userIndexes.length - 2 - w];
      if (prevIdx < 0) break;
      const prevDomain = conversationDomain(plainMessageText(messages[prevIdx]));
      if (prevDomain && prevDomain !== currentDomain) differentCount++;
    }
    // Only cut if at least half the window is a different domain (majority signal)
    if (differentCount >= Math.ceil(windowSize / 2)) return [system, ...messages.slice(latestIndex)];
  }

  let start = Math.max(1, latestIndex - 11);
  while (start < latestIndex && messages[start]?.role !== "user") start++;
  const recent = messages.slice(start).filter((message) =>
    !(message?.role === "user" && /^SYSTEM PREFLIGHT:/i.test(plainMessageText(message)))
  );
  // If we cut any messages, inject a summary so the dropped context survives
  const droppedForFocus = messages.slice(1, start).filter((message) =>
    !(message?.role === "user" && /^SYSTEM PREFLIGHT:/i.test(plainMessageText(message)))
  );
  const droppedSummary = summarizeDropped(droppedForFocus);
  if (droppedSummary) {
    return [system, { role: "system", content: droppedSummary }, ...recent];
  }
  return [system, ...recent];
}

function summarizeDropped(dropped) {
  if (!Array.isArray(dropped) || dropped.length === 0) return '';
  const keyPoints = [];
  let lastUserCorrection = '';
  let lastUserTopic = '';
  const decisions = [];  // user decisions/choices extracted from dropped messages
  const fileChanges = []; // file names mentioned in dropped messages (tool results)
  let lastError = ''; // most recent error/failure seen in dropped tool output

  for (const m of dropped) {
    const text = plainMessageText(m);
    if (!text) continue;

    // Track user corrections
    if (m.role === 'user' && /\b(not what i asked|thats not|that'?s not|you misunderstood|no\b.*(?:i said|i meant|i wanted)|correction|actually\b)/i.test(text)) {
      if (!lastUserCorrection) lastUserCorrection = text.slice(0, 200);
    }

    // Track user decisions/preferences (e.g., "use X not Y", "I prefer", "make it", "change to")
    if (m.role === 'user') {
      const trimmed = text.trim();
      if (!/^(ok|okay|yes|no|thanks|thank you|ready|continue|go ahead|keep going|sure|right|cool|nice|great|good|perfect)[.!? ]*$/i.test(trimmed)) {
        if (!lastUserTopic) lastUserTopic = trimmed.slice(0, 200);
      }
      // Extract explicit decisions
      const decisionMatch = trimmed.match(/(?:i want|i'd like|use |choose |go with|let'?s (?:use|go|make)|prefer|switch to|change (?:it|this|to)|make (?:it|sure)|don'?t (?:use|do)|stop)(?: to)?\b(.{1,150})/i);
      if (decisionMatch && decisions.length < 3) {
        decisions.push(decisionMatch[0].slice(0, 200));
      }
    }

    // Extract file names from tool calls/results in dropped messages
    if (m.role === 'tool' && typeof m.content === 'string') {
      const fileMentions = text.match(/\b(?:edited|changed|created|wrote|modified|saved|deleted|updated)\s+[\w./\\-]+\.\w+/gi);
      if (fileMentions && fileChanges.length < 5) {
        fileChanges.push(...fileMentions.slice(0, 5 - fileChanges.length));
      }
      const errMatch = text.match(/\b(?:error|failed|failure|exception|cannot|not found|denied|traceback|refused)\b[^\n]{0,160}/i);
      if (errMatch) lastError = errMatch[0].slice(0, 200);
    }

    // Extract key answers from assistant messages (first sentence of substantial replies)
    if (m.role === 'assistant' && text.length > 80) {
      const firstLine = text.split(/[.\n]/)[0]?.trim();
      if (firstLine && firstLine.length > 30 && !firstLine.startsWith('{') && !firstLine.startsWith('I\'ll') && !firstLine.startsWith('Let me') && keyPoints.length < 2) {
        keyPoints.push('Earlier answer: ' + firstLine.slice(0, 200));
      }
    }
  }

  // Build the summary
  if (lastUserTopic) keyPoints.unshift('Last topic: ' + lastUserTopic);
  if (lastUserCorrection) keyPoints.push('User correction: ' + lastUserCorrection);
  if (decisions.length) keyPoints.push('User decisions: ' + decisions.join('; '));
  if (fileChanges.length) keyPoints.push('Files worked on: ' + fileChanges.slice(0, 4).join(', '));
  if (lastError) keyPoints.push('Last error seen: ' + lastError);

  if (!keyPoints.length) return '';
  return 'CONTEXT SUMMARY (from earlier in this conversation):\n' + keyPoints.join('\n') + '\n';
}// clip a tool result inside the SENT copy (minimal mode) without touching history
function clipMsg(m, maxChars) {
  if (m.role === "tool" && typeof m.content === "string" && m.content.length > maxChars) {
    return { ...m, content: m.content.slice(0, maxChars) + "\n...[trimmed by Context Optimizer]" };
  }
  return m;
}

/**
 * Context Optimizer: return a COPY of the conversation trimmed to a token budget
 * so a prompt can never exceed the model's window (a hard error on the local
 * engine) AND to save tokens. Keeps the system message + a recent contiguous
 * suffix starting at a user turn (tool_call/tool pairs stay intact). The full
 * history is untouched for display; only what fits is sent.
 *
 * mode: "full" (use most of the window), "balanced" (default), "minimal"
 * (aggressive — cap context small and clip large tool outputs).
 * Returns { msgs, sentTokens, fullTokens, budget }.
 */
export function fitToContext(messages, budgetTokens, mode = "balanced") {
  const source = [...messages];
  const fullTokens = approxTokens(source);
  const reserve = fitReserveForMode(mode);
  let budget = Math.max(2048, budgetTokens - reserve);
  if (mode === "minimal") budget = Math.min(budget, 3200);

  let work = source;
  if (mode === "minimal") work = source.map((m, i) => (i === 0 ? m : clipMsg(m, 800)));
  else if (mode === "balanced") work = source.map((m, i) => (i === 0 ? m : clipMsg(m, 6000)));

  const done = (msgs) => ({ msgs, sentTokens: approxTokens(msgs), fullTokens, budget });
  if (approxTokens(work) <= budget) return done(work);

  const system = work[0];
  let rest = work.slice(1);
  const droppedMessages = [];
  while (rest.length > 1 && approxTokens([system, ...rest]) > budget) {
    droppedMessages.push(rest.shift());
  }
  while (rest.length && rest[0].role !== "user") {
    droppedMessages.push(rest.shift());
  }

  if (rest.length === 0) {
    const last = work[work.length - 1];
    const clipped = typeof last.content === "string"
      ? { ...last, content: last.content.slice(0, budget * 3) + "\n...[truncated to fit context]" }
      : last;
    return done([system, clipped]);
  }

  // Inject a rolling summary of dropped context so key decisions/corrections survive
  const droppedSummary = summarizeDropped(droppedMessages);
  if (droppedSummary) {
    // Several llama.cpp chat templates (including Qwen) allow exactly one
    // system message and require it to be the first item. Keep the summary in
    // that first message instead of creating a second system turn.
    const mergedSystem = {
      ...system,
      content: [typeof system?.content === "string" ? system.content.trim() : "", droppedSummary.trim()]
        .filter(Boolean)
        .join("\n\n")
    };
    return done([mergedSystem, ...rest]);
  }
  return done([system, ...rest]);
}

// exported so the /api/estimate endpoint can preview token cost before sending
export function estimateContext(messages, budgetTokens, mode) {
  const originalFull = approxTokens(messages);
  const artifactActionRequired = requiresArtifactAction(messages);
  const connectorActionRequired = requiresConnectorContinuationAction(messages);
  const latestUser = [...(messages || [])].reverse().find((message) => message?.role === "user");
  const directAction = detectWindowsSettingsRequest(currentTurnInstructionText(latestUser));
  const turnMode = classifyTurnMode(messages, { artifactActionRequired, connectorActionRequired, directAction });
  const r = fitToContext(focusedMessagesForTurn(messages, turnMode), budgetTokens, mode);
  return { full: originalFull, sent: r.sentTokens, saved: Math.max(0, originalFull - r.sentTokens), budget: r.budget };
}

export function controllerStopAnswerFromToolResult(result) {
  if (!/^blocked:/i.test(String(result || ""))) return "";
  const reason = String(result || "").split(/\r?\n/)[0].replace(/^blocked:\s*/i, "").trim();
  const loopGuard = /\b(?:loop guard|tool budget reached|too many inspection|repeated the same kind of inspection)\b/i.test(reason);
  return loopGuard
    ? "Paused to avoid repeating the same checks. Work is saved."
    : "Paused for safety. Work is saved.";
}

export function recoverableToolErrorResult(name, err) {
  const message = String(err?.message || err || "the tool could not complete").trim();
  return [
    `recoverable tool error (${name || "unknown_tool"}): ${message}`,
    "The task is still active. Do not end the response with this raw error.",
    "If the intended correction is unambiguous, correct the tool arguments and retry now.",
    "If a required value is ambiguous, ask the user one short, specific question that includes the likely correction."
  ].join("\n");
}

function controllerStopReason(result) {
  if (!/^blocked:/i.test(String(result || ""))) return "";
  return String(result || "").split(/\r?\n/)[0].replace(/^blocked:\s*/i, "").trim();
}

function isLoopRecoveryStop(reason) {
  return /\b(?:loop guard|tool budget reached|too many inspection|repeated the same kind of inspection)\b/i.test(String(reason || ""));
}

function directActionAnswer(action, result) {
  if (action?.name !== "email_cleanup_trash") return String(result || "");
  const data = parsedJsonObject(result);
  if (!data) return String(result || "");
  const moved = Math.max(0, Number(data.movedToTrash || 0));
  const skipped = Math.max(0, Number(data.skipped || 0));
  const remaining = Math.max(0, Number(data.remainingCandidates || 0));
  if (!moved) {
    return `No messages were moved to Trash${skipped ? `; ${skipped} were skipped by the safety re-check` : ""}.`;
  }
  const lines = [
    `Done. **${moved} messages** moved to Trash${skipped ? ` (${skipped} skipped)` : ""}.`,
    `- **Run ID:** \`${data.runId}\``,
    `- **Remaining candidates:** ${remaining}`,
    "Nothing was permanently deleted. The batch can be restored with its run ID."
  ];
  if (remaining) lines.push(`There are ${remaining} reviewed candidates left. Click **Move next batch to Trash** below, or type \`move next batch to trash\`.`);
  else lines.push("This cleanup plan has no remaining candidates.");
  return lines.join("\n");
}

export function teamworkAssignments(config = {}) {
  const teamwork = config?.ui?.codingAgent?.teamwork || {};
  const mode = ["assist", "team"].includes(String(teamwork.mode || "").toLowerCase())
    ? String(teamwork.mode).toLowerCase()
    : "solo";
  if (mode === "solo") return [];
  const primary = String(config.provider || "local");
  const connected = Object.keys(CLOUD).filter((provider) => {
    const entry = config?.[provider] || {};
    return !!entry.apiKey && !!entry.model;
  });
  if (primary === "local" && config?.local?.model) connected.unshift("local");
  else if (primary && !connected.includes(primary)) connected.unshift(primary);
  const costRank = (provider) => {
    if (provider === "local") return 0;
    const model = String(config?.[provider]?.model || "").toLowerCase();
    if (/\b(?:nano|mini|flash-lite|lite|haiku|small)\b/.test(model)) return 1;
    if (/\b(?:flash|turbo|fast)\b/.test(model)) return 2;
    return 3;
  };
  if (teamwork.useLowCost !== false) connected.sort((a, b) => costRank(a) - costRank(b));
  const preferred = String(teamwork.workerProvider || "auto");
  const ordered = [
    ...(preferred !== "auto" && connected.includes(preferred) ? [preferred] : []),
    ...connected.filter((provider) => provider !== primary),
    primary
  ].filter((provider, index, all) => provider && all.indexOf(provider) === index);
  if (!ordered.length) return [];
  const roles = mode === "assist"
    ? [{ role: "Reviewer", task: "Map the likely files and tests, identify risks, and give the lead a concise implementation recommendation. Do not edit files." }]
    : [
        { role: "Mapper", task: "Map the repository around the request. Identify exact files, symbols, existing patterns, and likely dependencies. Do not edit files." },
        { role: "Test analyst", task: "Inspect the relevant tests and failure paths. Propose exact reproduction and verification checks. Do not edit files." },
        { role: "Reviewer", task: "Review the requested change for architecture, regressions, security, and edge cases. Give the lead specific recommendations. Do not edit files." }
      ];
  const count = mode === "assist" ? 1 : Math.max(2, Math.min(3, Number(teamwork.maxWorkers) || 3));
  return roles.slice(0, count).map((item, index) => {
    const provider = ordered[index % ordered.length];
    return {
      ...item,
      provider,
      model: provider === "local" ? String(config?.local?.model || config?.model || "") : String(config?.[provider]?.model || "")
    };
  });
}

// Questions about a stopped or paused run must be answered before Boolean
// resumes it. This intentionally wins over continuation wording in mixed
// messages such as "so do it, why did you stop?".
export function isTaskStatusQuestion(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  return /\b(?:what happened|what went wrong|why\s+(?:(?:did|does)\s+)?(?:it|this|that|u|you|boolean)\s+(?:stop|stopped|pause|paused|end|ended|quit)|why\s+(?:was|is)\s+(?:it|this|that)\s+(?:stopped|paused|ended)|(?:are|r)\s+(?:u|you)\s+(?:still\s+)?(?:working|running|stuck|stopped)|(?:tell|explain)\s+me\s+why\s+(?:it|this|that|u|you)\s+(?:stopped|paused|ended))\b/i.test(value);
}

export function taskStopAnswer(task) {
  const controller = task?.controller || {};
  const rawReason = String(controller.lastFailure || "").trim();
  let reason = rawReason;
  if (/loop guard|repeated the same kind of inspection|repeated inspection/i.test(rawReason)) {
    reason = "Boolean's loop guard detected repeated inspections without a progress step, so it paused to prevent an endless loop.";
  } else if (/tool budget/i.test(rawReason)) {
    reason = "the run reached its tool budget and paused instead of continuing indefinitely.";
  } else if (!reason && controller.phase === "blocked") {
    reason = "the task reached a blocker that it could not safely resolve on its own.";
  } else if (!reason) {
    reason = "the previous run ended or was interrupted before it saved a specific failure reason.";
  }
  return `It stopped because ${reason}\n\nI did not restart it. Say **Resume** when you want Boolean to continue from the saved checkpoint.`;
}

export async function runBoundedWorkers(items, limit, handler) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(list.length || 1, Number(limit) || 1));
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await handler(list[index], index);
    }
  }));
  return results;
}

function compactTeamReport(value, maxChars = 2400) {
  const text = String(value || "No report returned.")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.max(600, maxChars - 220));
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
  return `${head.slice(0, cut > 500 ? cut + 1 : head.length).trim()}\n\n[Worker report compacted by Boolean; the lead retains the workspace and saved evidence.]`;
}

/**
 * Run one user turn through the agent loop, executing tools until the model
 * produces a final text answer.
 *
 * @param {object} ctx { config, approve, onStatus }
 * @param {Array} messages full conversation history (mutated in place)
 * @returns {Promise<string>} the model's final answer
 */
export async function runTurn(ctx, messages) {
  // The provider still owns the answer and tool choices. Boolean supplies the
  // operating policy and enforces hard permission boundaries, but does not
  // replace a model's substantive response with an opinionated workflow.
  const { config, onStatus, onToken: rawOnToken, onStep, onUsage, signal } = ctx;
  const emitStep = (entry) => { if (onStep) onStep(entry); };
  const checkpoint = () => { if (ctx.onCheckpoint) ctx.onCheckpoint(); };
  const latestUser = [...messages].reverse().find((message) => message?.role === "user");
  ctx.latestUserText = currentTurnInstructionText(latestUser);
  const orchestration = createCodexOrchestrator({
    threadId: ctx.threadId,
    persisted: ctx.orchestrationState,
    onEvent: (event, snapshot) => {
      ctx.orchestrationResult = snapshot;
      ctx.onOrchestration?.(event, snapshot);
    }
  });
  orchestration.startTurn(ctx.latestUserText, { cwd: ctx.projectDir || "", mode: ctx.forceTurnMode || "auto" });
  ctx.orchestrationResult = orchestration.snapshot();
  let agentMessageItem = null;
  // Supplying a token callback changes several OpenAI-compatible providers to
  // streaming mode. Preserve the caller's original transport choice; when the
  // caller does stream, mirror those deltas into the orchestration timeline.
  const onToken = typeof rawOnToken === "function" ? (delta) => {
    if (delta) {
      if (!agentMessageItem) agentMessageItem = orchestration.startItem("agent_message", { title: "Response" });
      orchestration.delta(agentMessageItem.id, delta);
    }
    rawOnToken(delta);
  } : undefined;
  ctx.orchestration = orchestration;
  const finishOrchestration = (answer, status = "completed") => {
    const value = String(answer || "").trim();
    if (agentMessageItem) orchestration.completeItem(agentMessageItem.id, { content: value });
    else if (value) {
      agentMessageItem = orchestration.startItem("agent_message", { title: "Response", content: value });
      orchestration.completeItem(agentMessageItem.id, { content: value });
    }
    if (status === "interrupted") orchestration.interruptTurn(value || "Interrupted by the user.");
    else if (status === "failed") orchestration.failTurn(value || "The task failed.");
    else orchestration.completeTurn(value);
    return answer;
  };
  const wrapApproval = (name) => {
    const approve = ctx[name];
    if (typeof approve !== "function") return;
    ctx[name] = async (summary) => {
      const item = orchestration.requestApproval(summary, { mode: name });
      try {
        const approved = await approve(summary);
        orchestration.resolveApproval(item.id, approved);
        return approved;
      } catch (error) {
        orchestration.resolveApproval(item.id, false);
        throw error;
      }
    };
  };
  wrapApproval("approve");
  wrapApproval("approveAlways");
  const forceChat = ctx.forceTurnMode === "chat";
  let artifactActionRequired = forceChat || ctx.forceNoArtifact === true ? false : requiresArtifactAction(messages);
  // The keywords and the sentence form disagree on this turn. Sub-agents inherit
  // the lead's decision, so only a top-level turn spends the classification call.
  if (!artifactActionRequired && !forceChat && ctx.forceNoArtifact !== true
      && !ctx.subagentDepth && artifactIntentAmbiguous(messages)) {
    const intent = await resolveArtifactIntent(config, ctx.latestUserText, signal);
    artifactActionRequired = intent.action === true;
    emitStep({
      name: "intent_check",
      args: { provider: intent.target?.provider || "", model: intent.target?.model || "" },
      result: `${intent.reason} — treating this turn as ${artifactActionRequired ? "a request to make the change" : "a question to answer"}.`
    });
    if (artifactActionRequired) onStatus("reading that as a request to make the change...");
  }
  const connectorActionRequired = forceChat ? false : requiresConnectorContinuationAction(messages);
  const connectorToolResultRequired = forceChat ? false : requiresConnectorToolResult(messages);
  const explicitActionToolResultRequired = forceChat ? false : requiresExplicitActionToolResult(messages);
  const emailCleanupAction = forceChat ? null : emailCleanupContinuationAction(messages);
  const directAction = forceChat ? null : (emailCleanupAction || detectWindowsSettingsRequest(ctx.latestUserText));
  const turnMode = forceChat ? "chat" : classifyTurnMode(messages, {
    latestText: ctx.latestUserText,
    artifactActionRequired,
    connectorActionRequired,
    projectDir: ctx.projectDir,
    directAction
  });
  const autoModelRoute = selectAutoModelRoute(config, messages, {
    turnMode,
    latestText: ctx.latestUserText,
    projectDir: ctx.projectDir,
    disabled: ctx.disableAutoRoute === true
  });
  // This is a per-turn copy of config in the server runner. It gives request
  // retries the same approved candidate pool without changing saved settings.
  config.__autoModelRoute = autoModelRoute;
  const lightweightLocalChat = config?.provider === "local"
    && turnMode === "chat"
    && isLightweightLocalChat(ctx.latestUserText);
  if (artifactActionRequired && !ctx.projectDir) {
    const answer = "Open a folder or create a project first, then ask me to build or change it. I will keep this as a normal chat and will not create a project workspace automatically.";
    messages.push({ role: "assistant", content: answer });
    return finishOrchestration(answer);
  }
  const controller = createAgentController({
    objective: ctx.objective || ctx.latestUserText,
    taskContext: ctx.taskContext || "",
    answerOnly: forceChat || lightweightLocalChat,
    artifactRequired: artifactActionRequired,
    actionRequired: connectorToolResultRequired || explicitActionToolResultRequired,
    projectDir: ctx.projectDir,
    currentUserText: ctx.latestUserText,
    effectiveAccessMode: currentAccessMode(ctx.config),
    loopStop: ctx.config?.ui?.codingAgent?.stopLoop === true,
    autopilot: ctx.config?.ui?.codingAgent?.autopilot === true,
    persisted: ctx.controllerState,
    tokenBudget: perRunTokenBudget(config),
    timeBudgetMs: perRunTimeBudgetMs(config)
  });
  const publishController = () => {
    const snapshot = controller.snapshot();
    ctx.controllerResult = snapshot;
    if (ctx.onController) ctx.onController(snapshot);
  };
  const noteControllerTool = (name, args, result) => {
    controller.noteTool(name, args, result);
    publishController();
  };
  // Duplicate inspection is a transition to synthesis, not a failure that
  // should start another recovery cycle.
  let synthesizeFromExistingEvidence = false;
  let salesResearchCalls = 0;
  let salesResearchClosed = false;
  let salesEvidenceCorrectionAttempts = 0;
  let salesPrimaryEvidence = "";
  const salesResearchFailures = new Map();
  const executeControllerTool = async (name, args) => {
    const toolItem = orchestration.startItem("tool_call", {
      title: name.replaceAll("_", " "),
      detail: String(args?.path || args?.url || args?.command || args?.query || ""),
      metadata: { tool: name }
    });
    // `remember` is a no-side-effect memory write handled by the controller; it is
    // never loop-guarded and never touches the filesystem.
    if (name === "remember") {
      const note = String(args?.note || args?.text || "").trim();
      controller.addNote(note);
      publishController();
      const result = note ? `Noted: ${note}` : "Nothing to remember.";
      orchestration.completeItem(toolItem.id, { detail: result });
      return result;
    }
    const salesResearchTool = ctx.salesWorkflow === true && SALES_RESEARCH_TOOL_NAMES.has(name);
    if (salesResearchTool) {
      const failures = salesResearchFailures.get(name) || 0;
      if (salesResearchClosed || salesResearchCalls >= SALES_RESEARCH_TOTAL_LIMIT) {
        salesResearchClosed = true;
        return "Sales research budget reached. Do not call another research or browser tool. Finish the prospect plan now from the collected evidence, label anything unverified, and complete the Personalize and Approve sections.";
      }
      if (failures >= SALES_RESEARCH_FAILURE_LIMIT) {
        return `The ${name} research path has already failed twice. Do not retry this mechanism. Use evidence already collected or one different available mechanism, then finish the plan with unverified items labeled.`;
      }
      salesResearchCalls++;
    }
    const gate = controller.allowTool(name, args);
    if (!gate.allowed) {
      if (gate.synthesize === true) {
        synthesizeFromExistingEvidence = true;
        const result = `Enough evidence is already available from the earlier ${name.replaceAll("_", " ")} result. Do not inspect again. Answer the user's request now from the collected evidence, concisely and directly.`;
        orchestration.completeItem(toolItem.id, { detail: result });
        return result;
      }
      const blocked = controller.noteBlockedTool(name, args, gate.reason);
      publishController();
      if (blocked.stop) {
        const result = `blocked: ${gate.reason}\nBoolean has blocked repeated attempts. Stop now and explain this blocker plainly instead of trying another equivalent action.`;
        orchestration.failItem(toolItem.id, gate.reason);
        return result;
      }
      orchestration.failItem(toolItem.id, gate.reason);
      return `error: ${gate.reason}`;
    }
    try {
      const result = await executeTool(name, args, ctx);
      if (salesResearchTool && /browser_open|visible_browser_open/.test(name)
          && /\bHTTP\s+2\d\d\b/i.test(String(result || ""))) {
        salesPrimaryEvidence = String(result || "").slice(0, 6000);
      }
      if (salesResearchTool && SALES_RESEARCH_FAILURE.test(String(result || ""))) {
        salesResearchFailures.set(name, (salesResearchFailures.get(name) || 0) + 1);
      }
      orchestration.completeItem(toolItem.id, { detail: String(result || "").slice(0, 1200) });
      return result;
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) throw err;
      const result = recoverableToolErrorResult(name, err);
      orchestration.failItem(toolItem.id, err?.message || err);
      onStatus("the tool needs corrected input - continuing...");
      return result;
    }
  };
  const controllerStopAnswer = (result) => {
    return controllerStopAnswerFromToolResult(result);
  };
  const withController = (source) => {
    const copy = source.map((message) => ({ ...message }));
    const live = controller.prompt();
    if (!live) return copy;
    const systemIndex = copy.findIndex((message) => message?.role === "system");
    if (systemIndex >= 0) {
      const existing = String(copy[systemIndex].content || "")
        .replace(/\n\nCURRENT TASK CONTRACT\n[\s\S]*$/, "")
        .trim();
      copy[systemIndex].content = `${existing}\n\nCURRENT TASK CONTRACT\n${live}`;
    } else {
      copy.unshift({ role: "system", content: `CURRENT TASK CONTRACT\n${live}` });
    }
    return copy;
  };
  publishController();
  if (directAction) {
    onStatus(`running ${directAction.name}...`);
    const result = await executeControllerTool(directAction.name, directAction.args);
    noteControllerTool(directAction.name, directAction.args, result);
    emitStep({ name: directAction.name, args: directAction.args, result });
    const stoppedByController = controllerStopAnswer(result);
    if (stoppedByController) {
      messages.push({ role: "assistant", content: stoppedByController });
      return finishOrchestration(stoppedByController, "failed");
    }
    if (directAction.name === "email_cleanup_trash") {
      const callId = `direct_${Date.now()}`;
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name: directAction.name, arguments: JSON.stringify(directAction.args) }
        }]
      });
      messages.push({ role: "tool", tool_call_id: callId, content: String(result || "") });
    }
    const pageLabel = String(directAction.args.page || "Windows").replace(/_/g, " ");
    const answer = /^Opened Windows Settings:/i.test(result)
      ? `${result} Tell me the exact ${pageLabel} setting you want changed.`
      : directActionAnswer(directAction, result);
    messages.push({ role: "assistant", content: answer });
    controller.updateDigest(answer, ctx.latestUserText || "");
    controller.evaluateCompletion(answer);
    publishController();
    return finishOrchestration(answer);
  }

  let bootstrapContext = "";
  const teamAssignments = !ctx.subagentDepth && artifactActionRequired && ctx.projectDir
    ? teamworkAssignments(config)
    : [];
  // Specialists are expensive and highly visible, so they no longer start on the
  // classification alone. The handoff runs once the turn has actually changed
  // something, which means a misread question costs nothing instead of three
  // model calls and a row of worker chips the user never asked for.
  let teamHandoffPending = teamAssignments.length > 0;
  const runTeamHandoff = async () => {
    teamHandoffPending = false;
    const teamMode = String(config?.ui?.codingAgent?.teamwork?.mode || "assist");
    const recordTeamWorker = (assignment, state, detail, attempt = 1, meta = {}) => {
      const worker = { role: assignment.role, provider: assignment.provider, model: assignment.model, state, attempt, ...meta };
      controller.noteTeamWorker(worker, detail);
      publishController();
      emitStep({ name: "team_worker", args: worker, result: detail });
    };
    const fallbackFor = (assignment) => teamAssignments.find((candidate) =>
      candidate.provider !== assignment.provider && candidate.model
    ) || null;
    const maxParallel = Math.max(1, Math.min(teamAssignments.length, Number(config?.ui?.codingAgent?.teamwork?.maxWorkers) || 3, 3));
    const workerBudget = Number(config?.ui?.codingAgent?.teamwork?.taskBudget || 0.5);
    const workerMaxTurns = workerBudget <= 0.25 ? 4 : workerBudget <= 1 ? 6 : 8;
    for (const assignment of teamAssignments) {
      recordTeamWorker(assignment, "queued", "Waiting for an available Team worker slot.", 1, {
        objective: ctx.latestUserText, workspace: ctx.projectDir, maxTurns: workerMaxTurns
      });
    }
    onStatus(`${teamMode === "team" ? "Team" : "Assist"} running up to ${maxParallel} specialist${maxParallel === 1 ? "" : "s"} in parallel...`);
    const reports = await runBoundedWorkers(teamAssignments, maxParallel, async (assignment) => {
      const label = `${assignment.role} · ${assignment.model || assignment.provider}`;
      const task = [
        `You are the ${assignment.role} supporting a lead coding agent.`,
        `User objective: ${ctx.latestUserText}`,
        `Exact allowed workspace: ${ctx.projectDir}`,
        `Worker budget: at most ${workerMaxTurns} model turns. Reuse this workspace; do not search parent folders or rediscover the project.`,
        assignment.task,
        "Use repository_map and targeted inspection when useful. Return only a concise evidence-backed handoff: files/symbols, findings, risks, and exact recommended checks."
      ].join("\n\n");
      try {
        const answer = await runSubagent(ctx, task, {
          provider: assignment.provider,
          model: assignment.model,
          role: assignment.role,
          attempt: 1,
          silentSteps: true,
          maxTurns: workerMaxTurns,
          onLifecycle: (state, detail, meta) => recordTeamWorker(assignment, state, detail, 1, meta)
        });
        const report = compactTeamReport(answer);
        recordTeamWorker(assignment, "done", report, 1);
        return `### ${label}\nStatus: completed on attempt 1.\n${report}`;
      } catch (err) {
        const reason = String(err?.message || err);
        const fallback = ctx.signal?.aborted ? null : fallbackFor(assignment);
        if (!fallback) {
          recordTeamWorker(assignment, ctx.signal?.aborted ? "cancelled" : "failed", reason, 1);
          return `### ${label}\nStatus: unavailable after attempt 1.\nWorker unavailable: ${reason}`;
        }
        const retry = { ...fallback, role: assignment.role, task: assignment.task };
        const retryLabel = `${retry.role} · ${retry.model || retry.provider}`;
        try {
          const answer = await runSubagent(ctx, task, {
            provider: retry.provider,
            model: retry.model,
            role: retry.role,
            attempt: 2,
            silentSteps: true,
            maxTurns: workerMaxTurns,
            onLifecycle: (state, detail, meta) => recordTeamWorker(retry, state === "working" ? "retrying" : state, state === "working" ? `Fallback started after: ${reason}` : detail, 2, meta)
          });
          const report = compactTeamReport(answer);
          recordTeamWorker(retry, "done", report, 2);
          return `### ${retryLabel}\nStatus: completed using fallback attempt 2 after ${label} failed.\n${report}`;
        } catch (retryErr) {
          const retryReason = String(retryErr?.message || retryErr);
          recordTeamWorker(retry, ctx.signal?.aborted ? "cancelled" : "failed", retryReason, 2);
          return `### ${retryLabel}\nStatus: unavailable after fallback attempt 2.\nFirst failure: ${reason}\nFallback failure: ${retryReason}`;
        }
      }
    });
    messages.push({
      role: "user",
      content: [
        "BOOLEAN TEAM HANDOFF",
        "These specialists worked in parallel. Use their evidence, resolve disagreements yourself, make the implementation, and run final verification. Do not merely repeat their reports.",
        ...reports
      ].join("\n\n")
    });
    onStatus("specialist reports ready - lead model is integrating them...");
  };
  let target = autoModelRoute.enabled
    ? await resolveProviderTarget(config, autoModelRoute.target.provider, onStatus)
    : await resolveTarget(config, onStatus);
  if (autoModelRoute.enabled && autoModelRoute.target.model) target = { ...target, model: autoModelRoute.target.model };
  if (autoModelRoute.enabled) {
    const detail = {
      route: autoModelRoute.route,
      provider: target.provider,
      model: target.model,
      reason: autoModelRoute.reason,
      preference: autoModelRoute.preference
    };
    onStatus(`Auto -> ${autoModelRoute.route} -> ${target.model || target.provider}`, { autoRoute: detail });
    emitStep({ name: "model_route", args: detail, result: autoModelRoute.reason });
    ctx.onRoute?.(detail);
  }
  // Model routing: with routing="cloud-plan", the first planning step runs on the
  // configured cloud model (stronger reasoning), then execution continues locally.
  let planTarget = null;
  if ((config?.ui?.codingAgent?.routing || "auto") === "cloud-plan") {
    try {
      const fb = config.cloudFallback || {};
      if (fb.provider) {
        const t = await resolveProviderTarget(config, fb.provider, onStatus);
        const candidate = fb.model ? { ...t, model: fb.model } : t;
        if (!(candidate.provider === target.provider && candidate.model === target.model)) planTarget = candidate;
      }
    } catch { planTarget = null; }
  }
  let localRecoveryAttempted = false;
  let localCompactTools = target?.provider === "local" && localContextWindow(config, target) <= 8192;
  let capabilityProfile = modelCapabilityProfile(config, target);
  let compatibilityMode = localCompactTools || capabilityProfile.mode === "patch" || capabilityProfile.mode === "review";
  let reviewOnlyCompatibility = capabilityProfile.mode === "review";
  let useNativeTools = !compatibilityMode;
  let compactToolProtocol = localCompactTools;
  const adoptExecutionTarget = (nextTarget) => {
    if (!nextTarget || (nextTarget.provider === target.provider && nextTarget.model === target.model)) return;
    target = nextTarget;
    localCompactTools = target?.provider === "local" && localContextWindow(config, target) <= 8192;
    capabilityProfile = modelCapabilityProfile(config, target);
    compatibilityMode = localCompactTools || capabilityProfile.mode === "patch" || capabilityProfile.mode === "review";
    reviewOnlyCompatibility = capabilityProfile.mode === "review";
    useNativeTools = !compatibilityMode;
    compactToolProtocol = localCompactTools;
    if (autoModelRoute.enabled) {
      const detail = {
        route: autoModelRoute.route,
        provider: target.provider,
        model: target.model,
        reason: "Kept the successful fallback model for the rest of this tool loop."
      };
      ctx.onRoute?.(detail);
    }
  };
  if (compatibilityMode && artifactActionRequired) {
    onStatus(reviewOnlyCompatibility
      ? `${target.model || "This model"} is in review/chat-only mode`
      : `${target.model || "This model"} is using Boolean's compatibility tool bridge`);
  }
  if (reviewOnlyCompatibility && (artifactActionRequired || explicitActionToolResultRequired)) {
    const answer = `${target.model || "The selected model"} is in Review/chat-only mode and cannot use Boolean's terminal, file-edit, browser, or deployment tools. The requested command was not run. Switch to a Full coding or Compatible coding model, then retry the same task; Boolean will not substitute unrelated cloud or connector inspections.`;
    messages.push({ role: "assistant", content: answer });
    return finishOrchestration(answer, "failed");
  }
  const emitUsage = (msg, usedTarget = target) => {
    if (msg?.usage) controller.addUsage(msg.usage);
    if (onUsage && msg?.usage) onUsage({ provider: usedTarget.provider || config.provider, model: usedTarget.model, ...msg.usage });
  };
  // Project tool loops can accumulate huge page dumps and file reads in one
  // turn. A focused cloud cap keeps the model on the current bug while the
  // complete transcript and checkpoints remain saved for recovery.
  const contextMode = config.ui?.contextMode || "balanced";
  let ctxBudget = contextBudgetForTarget(config, target, contextMode, ctx.projectDir);
  const { onOptimize } = ctx;
  let optimizeSent = false; // report once per turn
  const looksLikeContextOverflow = (err) =>
    /exceed.{0,30}context|context size|n_ctx|maximum context length/i.test((err.body || "") + (err.message || ""));

  const stopped = () => {
    const bail = "(stopped by user)";
    messages.push({ role: "assistant", content: bail });
    return finishOrchestration(bail, "interrupted");
  };

  // a screenshot tool stashes captured images on ctx; surface them to the model
  // as a follow-up user message so vision models can actually see the page
  const flushPendingImages = () => {
    if (!ctx.pendingImages || !ctx.pendingImages.length) return;
    const imgs = ctx.pendingImages.splice(0, ctx.pendingImages.length);
    messages.push({ role: "user", content: [
      { type: "text", text: "Screenshot captured by the requested tool." },
      ...imgs.map((url) => ({ type: "image_url", image_url: { url } }))
    ] });
  };

  // Explicit answer-only surfaces (currently Side chat) stay tool-free and use
  // the lightweight one-call path. Normal main chat continues into the agent
  // loop with the open tool catalog so a routing guess cannot strand the model
  // without a capability it discovers it needs.
  if (turnMode === "chat" && (forceChat || lightweightLocalChat)) {
    let contextRecoveryAttempted = false;
    let transportRecoveryAttempted = false;
    let textFallbackAttempted = false;
    let emptyRetryAttempted = false;
    for (;;) {
      if (signal?.aborted) return stopped();
      try {
        const originalFull = approxTokens(messages);
        const fit = fitToContext(focusedMessagesForTurn(messages, turnMode), ctxBudget, contextMode);
        if (!optimizeSent && onOptimize) {
          optimizeSent = true;
          onOptimize({ mode: contextMode, sent: fit.sentTokens, full: originalFull,
            saved: Math.max(0, originalFull - fit.sentTokens), budget: fit.budget });
        }
        const modelMessages = withController(withTurnModeSystem(fit.msgs, turnMode, config));
        const completion = await chatCompletionWithFallback(
          config, target, modelMessages, undefined, signal, onToken, onStatus
        );
        const msg = completion.message;
        emitUsage(msg, completion.target);
        const answer = String(msg?.content || "").trim();
        if (!answer && !emptyRetryAttempted) {
          emptyRetryAttempted = true;
          onStatus("the model returned no text - retrying once in plain-text mode...");
          continue;
        }
        if (!answer) throw new Error("The selected model returned an empty response.");
        controller.updateDigest(answer, ctx.latestUserText || "");
        controller.evaluateCompletion(answer);
        messages.push({ role: "assistant", content: answer });
        publishController();
        checkpoint();
        return finishOrchestration(answer);
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) return stopped();
        if (!contextRecoveryAttempted && looksLikeContextOverflow(err) && ctxBudget > 4096) {
          contextRecoveryAttempted = true;
          ctxBudget = Math.max(3072, Math.floor(ctxBudget * 0.65));
          onStatus("conversation too long for the model - trimming older history and retrying...");
          continue;
        }
        if (!transportRecoveryAttempted && config.provider === "local" && err?.code === "local_transport_error" && !err.partial) {
          transportRecoveryAttempted = true;
          onStatus("local model disconnected - restarting the engine and retrying...");
          target = await resolveTarget(config, onStatus);
          continue;
        }
        if (!textFallbackAttempted && looksLikeUnsupportedImageContent(err)) {
          textFallbackAttempted = true;
          persistScreenshotTextFallback(messages);
          onStatus("this model accepts text only - continuing with the screenshot's page text...");
          continue;
        }
        throw err;
      }
    }
  }

  // Keep working until the model produces a final answer or the user stops it.
  // The old fixed ceiling stranded longer coding tasks after only 12 tool calls.
  // A repeated-action guard below still stops models that are genuinely stuck.
  let turn = 0;
  let actionNudgeActive = artifactActionRequired;
  let completedToolWork = false;
  let emptyResponseRetries = 0;
  let textOnlyContentFallback = false;
  let autoContinues = 0;
  let completionNudges = 0;
  // Independent verification (codingEngine:auto) runs at most this many times per
  // run. A failed verdict re-nudges once, but it can never loop the model into
  // re-answering until the token budget dies.
  let autoVerifications = 0;
  const MAX_AUTO_VERIFICATIONS = 2;
  let controllerRecoveries = 0;
  let announceNudges = 0;
  let forceToolCallNext = false;
  let activeToolDefinitions = [];
  let compatibilityInspectionCount = 0;
  let compatibilityPatchApplied = false;
  let compatibilityPatchErrors = 0;
  const MAX_COMPATIBILITY_PATCH_RETRIES = 3;
  // Finishing an action the model has already started is baseline agent behavior,
  // not an optional Autopilot feature. Keep these counters consecutive (real tool
  // progress resets them below) so long productive tasks can continue while a
  // genuinely narrating/stalled model still gets bounded correction attempts.
  const autopilot = config?.ui?.codingAgent?.autopilot === true;
  const MAX_AUTO_CONTINUE = autopilot ? 6 : 3;
  const MAX_CONTROLLER_RECOVERIES = 4;
  const MAX_LOOP_RECOVERIES = 0;
  const MAX_EMPTY_RESPONSE_RETRIES = 8;
  const MAX_ANNOUNCE_NUDGES = 4;
  // Auto model handoff: when the primary model gives up on an unfinished, action-
  // required task while Auto orchestration (or Autopilot) is active, hand the SAME task (with its saved controller
  // state and history) to the next connected model to finish — instead of pausing.
  // Bounded, and each model is tried at most once, so it can't cycle forever.
  const MAX_MODEL_HANDOFFS = 3;
  let modelHandoffs = 0;
  const modelKey = (t) => `${t?.provider || ""}|${t?.model || ""}`.toLowerCase();
  const triedModelKeys = new Set([modelKey(target)]);
  // A blocked or errored tool result is not progress — a repeatedly-blocked action
  // must NOT reset the loop-recovery guard, or it would recover forever and never
  // terminate. Mirrors the controller's own failure prefixes.
  const toolResultFailed = (result) =>
    /^(?:error:|blocked:|recoverable tool error)/i.test(String(result || "").trim());
  // Real tool progress clears the stall budgets. These caps are meant to bound
  // CONSECUTIVE stalls (narration with no action), not the whole run — otherwise a
  // long task exhausts them early and later legitimate nudges are denied, leaving
  // it abandoned half-done. The per-run token/time budget is the true runaway guard.
  const resetStallCounters = (result) => {
    emptyResponseRetries = 0;
    if (toolResultFailed(result)) return;
    autoContinues = 0;
    announceNudges = 0;
    completionNudges = 0;
    controllerRecoveries = 0;
  };
  const handleControllerStop = (result) => {
    const stoppedByController = controllerStopAnswer(result);
    if (!stoppedByController) return "";
    const reason = controllerStopReason(result);
    if (isLoopRecoveryStop(reason) && controllerRecoveries < MAX_LOOP_RECOVERIES && !signal?.aborted) {
      controllerRecoveries++;
      if (autopilot) autoContinues++;
      messages.push({ role: "user", content: controller.continuationPrompt(reason) +
        " Continue inside this same run. Do not ask the user to type continue. Do not repeat the blocked inspection; use saved evidence and take the next progress action." });
      publishController();
      onStatus("continuing from saved evidence...");
      return "__continue__";
    }
    messages.push({ role: "assistant", content: stoppedByController });
    return stoppedByController;
  };
  agentLoop: for (;;) {
    turn++;
    if (signal?.aborted) return stopped();
    // The turn has changed a file, so this really is build work: bring the
    // specialists in now, between clean turns, where appending their handoff
    // cannot break an assistant/tool message pair.
    if (teamHandoffPending && controller.snapshot().mutationCount > 0) await runTeamHandoff();
    // Check per-run token/time budget and user cancellation
    const budget = controller.checkBudget();
    if (budget.budgeted) {
      const bail = `(stopped: ${budget.reason})`;
      messages.push({ role: "assistant", content: bail });
      publishController();
      checkpoint();
      // A budget checkpoint is an unfinished terminal result for this model,
      // not a successful answer. Mark the orchestration failed so the server's
      // Auto engine can immediately continue the saved task with an approved
      // Codex or Claude subscription instead of rendering a misleading pause.
      return finishOrchestration(bail, "failed");
    }
    // bounded runs (used by sub-agents) stop after their turn budget
    if (ctx.maxTurns && turn > ctx.maxTurns) {
      const partial = String(messages.filter((m) => m.role === "assistant").map((m) => m.content).filter((c) => typeof c === "string").pop() || "").trim();
      const bail = partial || "(sub-agent reached its step limit without a final answer)";
      messages.push({ role: "assistant", content: bail });
      return bail;
    }
    let msg;
    try {
      const originalFull = approxTokens(messages);
      const fit = fitToContext(focusedMessagesForTurn(messages, turnMode), ctxBudget, contextMode);
      if (!optimizeSent && onOptimize) {
        optimizeSent = true;
        onOptimize({ mode: contextMode, sent: fit.sentTokens, full: originalFull,
          saved: Math.max(0, originalFull - fit.sentTokens), budget: fit.budget });
      }
      let modelMessages = actionNudgeActive ? withActionNudge(fit.msgs, bootstrapContext, !!ctx.projectDir) : fit.msgs;
      modelMessages = withTurnModeSystem(modelMessages, turnMode, config);
      modelMessages = withController(modelMessages);
      if (textOnlyContentFallback) modelMessages = withTextOnlyContent(modelMessages);
      // Explicit answer-only surfaces such as Side chat remain intentionally
      // tool-free. Every normal main-chat turn receives the open catalog.
      const availableTools = forceChat || synthesizeFromExistingEvidence
        ? []
        : toolDefinitionsForTurnMode(turnMode, artifactActionRequired, completedToolWork, !!ctx.projectDir);
      const compatibilityInspections = compatibilityMode && !reviewOnlyCompatibility
        ? availableTools
        : [];
      activeToolDefinitions = compatibilityMode ? compatibilityInspections : availableTools;
      if (compatibilityMode) {
        modelMessages = withCompatibilityProtocol(modelMessages, compatibilityInspections, {
          reviewOnly: reviewOnlyCompatibility
        });
      } else if (!useNativeTools && availableTools.length) {
        modelMessages = withFallbackToolProtocol(modelMessages, availableTools, { compact: compactToolProtocol });
      }
      const requireInitialNativeTool = connectorActionRequired;
      // Route the planning step (first turn / planning phase) to the cloud model
      // when configured; execution steps stay on the local model.
      const routeBase = (planTarget && !completedToolWork && (turn === 1 || controller.phase === "planning"))
        ? planTarget : target;
      if (routeBase === planTarget) onStatus(`planning with ${planTarget.model || planTarget.provider}...`);
      // Force an actual tool call this turn when either the initial connector step
      // requires it, or a nudge fired because the model announced/promised an action
      // but never took it. Without this, `forceToolCallNext` was dead — the nudge was
      // only polite text a weak model could ignore, so it kept narrating and stopped.
      const forceToolThisTurn = (requireInitialNativeTool && !completedToolWork) || forceToolCallNext;
      const requestTarget = forceToolThisTurn && useNativeTools && availableTools.length
        ? { ...routeBase, toolChoice: "required" }
        : routeBase;
      forceToolCallNext = false;
      const completion = await chatCompletionWithFallback(
        config,
        requestTarget,
        modelMessages,
        useNativeTools && availableTools.length ? availableTools : undefined,
        signal,
        onToken,
        onStatus
      );
      msg = completion.message;
      if (routeBase === target) adoptExecutionTarget(completion.target);
      localRecoveryAttempted = false;
      emitUsage(msg, completion.target);
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) return stopped();
      // prompt still too big for the engine — trim harder and retry automatically
      if (looksLikeContextOverflow(err) && ctxBudget > 4096) {
        const reportedLimit = contextLimitFromError(err);
        if (reportedLimit && target?.provider === "local") {
          target = { ...target, ctx: reportedLimit };
          if (reportedLimit <= 8192) {
            localCompactTools = true;
            useNativeTools = false;
            compatibilityMode = true;
            reviewOnlyCompatibility = false;
          }
        }
        const limitBudget = reportedLimit
          ? contextBudgetForTarget(config, target?.provider === "local" ? { ...target, ctx: reportedLimit } : target, contextMode, ctx.projectDir)
          : Math.floor(ctxBudget * 0.7);
        const nextBudget = Math.min(Math.floor(ctxBudget * 0.7), limitBudget);
        if (nextBudget >= ctxBudget) throw err;
        ctxBudget = Math.max(3072, nextBudget);
        onStatus("conversation too long for the model - trimming older history and retrying...");
        continue;
      }
      if (config.provider === "local" && err?.code === "local_transport_error" && !err.partial && !localRecoveryAttempted) {
        localRecoveryAttempted = true;
        onStatus("local model disconnected - restarting the engine and retrying...");
        target = await resolveTarget(config, onStatus);
        continue;
      }
      if (!textOnlyContentFallback && looksLikeUnsupportedImageContent(err)) {
        textOnlyContentFallback = true;
        persistScreenshotTextFallback(messages);
        onStatus("this model accepts text only - continuing with the screenshot's page text...");
        continue;
      }
      const malformedNativeCall = useNativeTools && looksLikeMalformedNativeToolCall(err);
      const rejectedNativePrompt = useNativeTools && looksLikeRejectedNativeToolPrompt(err);
      if (useNativeTools && (looksLikeNoToolSupport(err) || malformedNativeCall || rejectedNativePrompt)) {
        useNativeTools = false;
        compatibilityMode = true;
        reviewOnlyCompatibility = false;
        saveCapabilityResult(config, target, false,
          rejectedNativePrompt ? "provider rejected native tool prompt"
            : malformedNativeCall ? "model returned malformed native tool call"
              : "provider reported no native tool support",
          ctx.onCapabilityChange);
        if (rejectedNativePrompt) compactToolProtocol = true;
        onStatus(rejectedNativePrompt
          ? "the provider rejected native tools - switching to the compatibility tool bridge..."
          : malformedNativeCall
            ? "the model's native tool call was malformed - switching to the compatibility tool bridge..."
            : `model '${target.model}' lacks native tool support - using the compatibility tool bridge`);
        convertNativeToolHistoryToText(messages);
        continue;
      }
      throw err;
    }

    // Native tool calls (OpenAI format: arguments is a JSON string)
    if (useNativeTools && msg.tool_calls?.length) {
      const parsedCalls = [];
      let malformedCall = false;
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        let args = call.function?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            malformedCall = true;
            break;
          }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          malformedCall = true;
          break;
        }
        parsedCalls.push({ call, name, args });
      }
      if (malformedCall) {
        useNativeTools = false;
        compatibilityMode = true;
        reviewOnlyCompatibility = false;
        saveCapabilityResult(config, target, false, "model returned malformed native tool call", ctx.onCapabilityChange);
        onStatus("the model's native tool call was malformed - switching to the compatibility tool bridge...");
        continue;
      }
      saveCapabilityResult(config, target, true, "native tool call completed", ctx.onCapabilityChange);
      messages.push(msg);
      for (const { call, name, args } of parsedCalls) {
        onStatus(`running ${name}…`);
        const result = await executeControllerTool(name, args);
        noteControllerTool(name, args, result);
        const toolContent = result;
        emitStep({ name, args, result });
        completedToolWork = true;
        resetStallCounters(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id || `call_${turn}`,
          content: toolContent
        });
        const stoppedByController = handleControllerStop(result);
        if (stoppedByController === "__continue__") {
          checkpoint();
          continue agentLoop;
        }
        if (stoppedByController) return stoppedByController;
        checkpoint();
      }
      flushPendingImages();
      continue;
    }

    const assistantContent = msg.content || "";

    if (compatibilityMode && !reviewOnlyCompatibility) {
      try {
        const edits = parseBooleanPatch(assistantContent, ctx.projectDir);
        if (edits) {
          preflightBooleanPatch(edits);
          messages.push({ role: "assistant", content: assistantContent });
          const results = [];
          for (const edit of edits) {
            const name = edit.kind === "create" ? "write_file" : "edit_file";
            const args = edit.kind === "create"
              ? { path: edit.absolute, content: edit.content }
              : { path: edit.absolute, old_string: edit.old, new_string: edit.new };
            onStatus(`applying compatibility edit to ${edit.path}...`);
            const result = await executeControllerTool(name, args);
            noteControllerTool(name, args, result);
            emitStep({ name: "boolean_patch", args: { path: edit.path, kind: edit.kind }, result });
            results.push(`${edit.path}: ${result}`);
            if (/^(?:error|blocked|failed|user declined)/i.test(String(result || "").trim())) {
              throw new Error(`Patch stopped at '${edit.path}': ${String(result || "").trim()}`);
            }
          }
          compatibilityPatchApplied = true;
          completedToolWork = true;
          resetStallCounters();
          messages.push({
            role: "user",
            content: `BOOLEAN PATCH RESULT:\n${results.join("\n")}\nContinue the task. Use the compatibility tools to run the requested tests and verification before summarizing.`
          });
          checkpoint();
          continue;
        }
      } catch (err) {
        compatibilityPatchErrors++;
        const reason = String(err?.message || err);
        if (compatibilityPatchErrors < MAX_COMPATIBILITY_PATCH_RETRIES) {
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({
            role: "user",
            content: `BOOLEAN PATCH REJECTED (${compatibilityPatchErrors}/${MAX_COMPATIBILITY_PATCH_RETRIES}): ${reason}\nUse the saved evidence to return one corrected fenced boolean_patch block, or use read_file/edit_file through the compatibility tool protocol if the exact target changed.`
          });
          onStatus(`the proposed patch did not match the project - recovering (${compatibilityPatchErrors}/${MAX_COMPATIBILITY_PATCH_RETRIES})...`);
          continue;
        }
        compatibilityPatchApplied = true;
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: `BOOLEAN PATCH RECOVERY: ${reason}\nThe bulk patch path was exhausted, but the task is still active. Use repository_map, read_file, and edit_file through the compatibility tool protocol to make smaller grounded edits, then run verification. Do not repeat the rejected patch.`
        });
        onStatus("switching from the rejected bulk patch to smaller grounded edits...");
        checkpoint();
        continue;
      }
    }

    // Text-protocol tool calls (checked in both modes — small models often
    // write a JSON block instead of using native tool calls)
    const allowedNames = new Set(activeToolDefinitions.map((tool) => tool.function.name));
    const call = activeToolDefinitions.length
      ? parseFallbackToolCall(assistantContent, { strict: compatibilityMode, allowedNames })
      : null;
    if (call) {
      messages.push({ role: "assistant", content: assistantContent });
      onStatus(`running ${call.name}…`);
      const result = await executeControllerTool(call.name, call.arguments);
      noteControllerTool(call.name, call.arguments, result);
      const toolResultContent = result;
      emitStep({ name: call.name, args: call.arguments, result });
      completedToolWork = true;
      if (compatibilityMode) compatibilityInspectionCount++;
      resetStallCounters(result);
      messages.push({
        role: "user",
        content: `TOOL RESULT for ${call.name}:\n${toolResultContent}`
      });
      const stoppedByController = handleControllerStop(result);
      if (stoppedByController === "__continue__") {
        flushPendingImages();
        checkpoint();
        continue;
      }
      if (stoppedByController) return stoppedByController;
      flushPendingImages();
      checkpoint();
      continue;
    }

    // A small model may understand a build request yet answer with a tutorial
    // instead of using its tools. Give it one explicit corrective retry, while
    // leaving normal questions and brainstorming untouched.
    if (!assistantContent.trim()) {
      emptyResponseRetries++;
      if (emptyResponseRetries <= MAX_EMPTY_RESPONSE_RETRIES) {
        actionNudgeActive = artifactActionRequired;
        onStatus(completedToolWork
          ? `the model paused before finishing - continuing automatically (${emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})...`
          : "the model returned no answer - retrying...");
        continue;
      }
      throw new Error("The model returned an empty response repeatedly after Boolean retried automatically. The task remains checkpointed.");
    }

    // The model announced an inspection or action ("let me read the files now")
    // but emitted no tool call this turn, then stopped. Small/mid models do this
    // constantly. Catch it independent of task classification — as long as tools
    // are available and the response is a short bare announcement with nothing
    // done — and push the model to actually take the step instead of accepting
    // the narration as a final answer.
    if (activeToolDefinitions.length && !signal?.aborted
        && announceNudges < MAX_ANNOUNCE_NUDGES
        && announcesUnperformedAction(assistantContent)) {
      announceNudges++;
      forceToolCallNext = true;
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "user",
        content: compatibilityMode
          ? "BOOLEAN CONTINUATION:\nTake the announced step now. Return exactly one fenced tool call using the BOOLEAN TOOL PROTOCOL already provided. Do not describe what you will do - call the tool in this turn."
          : "BOOLEAN CONTINUATION:\nTake the announced step now by calling the tool directly. Do not describe what you will do - do it in this turn."
      });
      onStatus("taking the announced step...");
      continue;
    }

    // Build tasks: if the model stops with text that describes MORE work to do
    // (instead of doing it), nudge it to keep going rather than ending half-done.
    // Bounded, and only for artifact/build tasks that have already started.
    if (artifactActionRequired && completedToolWork && autoContinues < MAX_AUTO_CONTINUE
        && MORE_WORK_INTENT.test(assistantContent) && !signal?.aborted) {
      autoContinues++;
      forceToolCallNext = true;
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({ role: "user", content: "Continue now — make the next change with your tools instead of describing it. Keep going in this same run until the requested work is complete." });
      onStatus("continuing until the project is finished...");
      continue;
    }

    // A failed discovery/search service does not erase primary evidence that
    // was successfully read from the supplied company website. Sales results
    // are saved as durable plans, so correct this contradiction before the UI
    // ever accepts or stores the answer.
    const salesPlanSections = ctx.salesWorkflow === true
      ? new Set([...assistantContent.matchAll(SALES_PLAN_SECTION)].map((match) => match[1]))
      : new Set();
    const salesPlanIncomplete = ctx.salesWorkflow === true && salesPlanSections.size < 5;
    if (ctx.salesWorkflow === true && salesPrimaryEvidence
        && (SALES_PRIMARY_EVIDENCE_CONTRADICTION.test(assistantContent) || salesPlanIncomplete)
        && salesEvidenceCorrectionAttempts < 2 && !signal?.aborted) {
      salesEvidenceCorrectionAttempts++;
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "user",
        content: [
          "EVIDENCE CONSISTENCY CHECK FAILED.",
          "The supplied company website opened successfully with HTTP 2xx and its primary page evidence is authoritative.",
          "Rewrite the complete five-section prospect plan now. Use the verified website facts for Understand and Target.",
          "Use explicit numbered headings 1 through 5: Understand, Target, Research, Personalize, Approve. Do not return a summary instead.",
          "Do not say the website was unavailable, unverified, inferred from its domain, or not confirmed.",
          "Mark only outside prospect-company discovery as limited if those searches failed.",
          "Keep Personalize and Approve complete, state that nothing was sent, and do not call more tools.",
          "",
          "VERIFIED PRIMARY WEBSITE EVIDENCE:",
          salesPrimaryEvidence
        ].join("\n")
      });
      onStatus("correcting the plan against verified website evidence...");
      continue;
    }

    let completion = containsUnexecutedCompatibilityAction(assistantContent)
      ? { complete: false, reason: "The model returned an unexecuted compatibility patch instead of a final result." }
      : controller.evaluateCompletion(assistantContent);
    if (completion.complete && config?.codingEngine === "auto" && controller.actionRequired
        && !signal?.aborted && autoVerifications < MAX_AUTO_VERIFICATIONS) {
      autoVerifications++;
      const verdict = await verifyAutoCompletion(
        config,
        autoModelRoute.route,
        target,
        ctx.latestUserText,
        assistantContent,
        controller,
        signal,
        onStatus
      );
      emitStep({
        name: "independent_verification",
        args: { provider: verdict.reviewer?.provider || "", model: verdict.reviewer?.model || "" },
        result: verdict.reason
      });
      if (!verdict.verified) completion = { complete: false, reason: verdict.reason };
      else if (verdict.unverified) onStatus("Finishing without independent verification.");
      else onStatus(`Verified by ${verdict.reviewer?.model || verdict.reviewer?.provider || "a different model"}.`);
    }
    if (!completion.complete && controller.actionRequired && completionNudges < MAX_AUTO_CONTINUE && !signal?.aborted) {
      completionNudges++;
      if (autoModelRoute.enabled && autoModelRoute.allowEscalation !== false) {
        const stronger = nextAutoModelTarget(autoModelRoute, target);
        if (stronger) {
          const resolved = await resolveProviderTarget(config, stronger.provider, onStatus);
          target = stronger.model ? { ...resolved, model: stronger.model } : resolved;
          triedModelKeys.add(modelKey(target));
          autoModelRoute.alternates = autoModelRoute.alternates.filter((candidate) =>
            candidate.provider !== target.provider || candidate.model !== target.model
          );
          localCompactTools = target?.provider === "local" && localContextWindow(config, target) <= 8192;
          capabilityProfile = modelCapabilityProfile(config, target);
          compatibilityMode = localCompactTools || capabilityProfile.mode === "patch" || capabilityProfile.mode === "review";
          reviewOnlyCompatibility = capabilityProfile.mode === "review";
          useNativeTools = !compatibilityMode;
          compactToolProtocol = localCompactTools;
          const detail = {
            route: autoModelRoute.route,
            provider: target.provider,
            model: target.model,
            reason: `Escalated after verification failed: ${completion.reason}`
          };
          onStatus(`Auto escalated to ${target.model || target.provider} after verification failed`, { autoRoute: detail });
          emitStep({ name: "model_route", args: detail, result: detail.reason });
          ctx.onRoute?.(detail);
        }
      }
      // The task is action-required and not actually done (e.g. claimed complete but
      // changed no files). Force a real tool call next turn so the model does the work
      // instead of narrating another "I'll continue" and stopping.
      forceToolCallNext = true;
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({ role: "user", content: controller.continuationPrompt(completion.reason) });
      publishController();
      onStatus(controller.phase === "recovering" ? "recovering from the failed step..." : "verifying the result before finishing...");
      continue;
    }
    if (!completion.complete) {
      // Auto handoff: the current model has given up on an unfinished, action-
      // required task. On autopilot, hand the SAME task to the next connected model
      // (with the full saved controller state and history) so it can finish, instead
      // of pausing. Each model is tried at most once and the total is bounded.
      const handoffEnabled = (autopilot || config?.codingEngine === "auto")
        && config?.ui?.codingAgent?.autoHandoff !== false
        && controller.actionRequired
        && !signal?.aborted
        && modelHandoffs < MAX_MODEL_HANDOFFS;
      const nextModel = handoffEnabled
        ? handoffCandidates(config, autoModelRoute.route).find((candidate) => !triedModelKeys.has(modelKey(candidate)))
        : null;
      if (nextModel) {
        modelHandoffs++;
        const previousLabel = target.model || target.provider;
        const resolved = await resolveProviderTarget(config, nextModel.provider, onStatus);
        target = nextModel.model ? { ...resolved, model: nextModel.model } : resolved;
        triedModelKeys.add(modelKey(target));
        // Reconfigure tool mode for the new model, mirroring initial setup.
        localCompactTools = target?.provider === "local" && localContextWindow(config, target) <= 8192;
        capabilityProfile = modelCapabilityProfile(config, target);
        compatibilityMode = localCompactTools || capabilityProfile.mode === "patch" || capabilityProfile.mode === "review";
        reviewOnlyCompatibility = capabilityProfile.mode === "review";
        useNativeTools = !compatibilityMode;
        compactToolProtocol = localCompactTools;
        // Give the fresh model a full correction budget and clear stall state.
        completionNudges = 0;
        compatibilityPatchApplied = false;
        compatibilityPatchErrors = 0;
        resetStallCounters();
        forceToolCallNext = true;
        const detail = {
          route: autoModelRoute.route,
          provider: target.provider,
          model: target.model,
          reason: `Handed off after ${previousLabel} stopped without finishing: ${completion.reason}`
        };
        onStatus(`${previousLabel} stopped — handing the task to ${target.model || target.provider} to finish…`, { autoRoute: detail });
        emitStep({ name: "model_route", args: detail, result: detail.reason });
        ctx.onRoute?.(detail);
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({ role: "user", content:
          "The previous model stopped before finishing this task. You are a different model taking over the SAME task — do not restart it or re-summarize what was done. "
          + "Continue from the saved progress in WORKING MEMORY and complete the remaining work now using the tools. "
          + controller.continuationPrompt(completion.reason) });
        publishController();
        checkpoint();
        continue;
      }
      const paused = `(paused: ${completion.reason} Work is saved.)`;
      messages.push({ role: "assistant", content: paused });
      publishController();
      checkpoint();
      return finishOrchestration(paused, "failed");
    }

    // Final answer — update conversation digest so it persists across turns
    controller.updateDigest(assistantContent, ctx.latestUserText || "");
    messages.push({ role: "assistant", content: assistantContent });
    publishController();
    checkpoint();
    return finishOrchestration(assistantContent);
  }

}

/**
 * Run a bounded sub-agent for one delegated task. Shares the parent's model,
 * config, and tool bridges, but gets its own message history, cannot spawn
 * further sub-agents, and is capped so it can't run away.
 */
export async function runSubagent(parentCtx, task, options = {}) {
  const cfg = parentCtx.config || {};
  const workspaceDir = options.workspaceDir || parentCtx.projectDir || cfg.projectsDir;
  const provider = options.provider && (options.provider === "local" || CLOUD[options.provider])
    ? options.provider
    : cfg.provider;
  const providerEntry = provider && cfg[provider] ? {
    [provider]: { ...cfg[provider], ...(options.model ? { model: options.model } : {}) }
  } : {};
  const childConfig = {
    ...cfg,
    ...providerEntry,
    provider,
    projectsDir: workspaceDir,
    ui: {
      ...(cfg.ui || {}),
      codingAgent: {
        ...(cfg.ui?.codingAgent || {}),
        budget: Number(cfg.ui?.codingAgent?.teamwork?.taskBudget || 0.5) <= 0.25
          ? "small"
          : Number(cfg.ui?.codingAgent?.teamwork?.taskBudget || 0.5) <= 1 ? "normal" : "large",
        teamwork: { ...(cfg.ui?.codingAgent?.teamwork || {}), mode: "solo" }
      }
    }
  };
  const sys = "";
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: String(task || "").trim() }
  ];
  const workerAbort = new AbortController();
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 90_000);
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const stallMs = Math.max(100, Math.min(timeoutMs - 25, Number(options.stallMs) || 30_000));
  let lastProgressAt = startedAt;
  let stalled = false;
  const lifecycle = (state, detail) => options.onLifecycle?.(state, detail, {
    objective: String(task || "").slice(0, 500), workspace: workspaceDir,
    startedAt, lastProgressAt, deadlineAt, maxTurns: Math.max(3, Number(options.maxTurns) || 6)
  });
  const markProgress = (detail = "Worker made progress.") => {
    lastProgressAt = Date.now();
    if (stalled) {
      stalled = false;
      lifecycle("working", detail);
    }
  };
  lifecycle("working", `${options.role || "Specialist"} started in the assigned workspace.`);
  const timeout = setTimeout(() => workerAbort.abort(new Error("Specialist timed out")), timeoutMs);
  const watchdog = setInterval(() => {
    if (!stalled && !workerAbort.signal.aborted && Date.now() - lastProgressAt >= stallMs) {
      stalled = true;
      lifecycle("stalled", `No tool or model progress for ${Math.ceil(stallMs / 1000)} seconds; waiting until the worker deadline.`);
    }
  }, Math.max(25, Math.min(1000, Math.floor(stallMs / 2))));
  const abortFromParent = () => {
    lifecycle("draining", "Lead task stopped; saving the worker checkpoint and draining this session.");
    workerAbort.abort(parentCtx.signal?.reason || new Error("Lead task stopped"));
  };
  if (parentCtx.signal) {
    if (parentCtx.signal.aborted) abortFromParent();
    else parentCtx.signal.addEventListener("abort", abortFromParent, { once: true });
  }
  const childCtx = {
    ...parentCtx,
    config: childConfig,
    projectDir: workspaceDir,
    onToken: null,                 // don't stream sub-agent tokens into the main answer
    onOptimize: null,
    onImage: null,
    pendingImages: [],
    runSubagent: null,             // no nesting
    subagentDepth: (parentCtx.subagentDepth || 0) + 1,
    maxTurns: Math.max(3, Number(options.maxTurns) || (childConfig.ui.codingAgent.budget === "small" ? 4 : childConfig.ui.codingAgent.budget === "large" ? 8 : 6)),
    signal: workerAbort.signal,
    onStep: (step) => { markProgress("Worker completed a tool step."); if (!options.silentSteps) parentCtx.onStep?.(step); },
    onStatus: (t) => { markProgress(String(t || "Worker status updated.")); parentCtx.onStatus?.(`${options.role || "sub-agent"}: ${t}`); },
    onUsage: (usage) => {
      markProgress("Worker model response received.");
      parentCtx.onUsage?.({
        ...usage,
        role: options.role || "Specialist",
        attempt: Math.max(1, Number(options.attempt) || 1),
        teamWorker: true
      });
    },
    onController: null,            // workers cannot overwrite the lead's durable controller
    onCheckpoint: null             // only the lead owns the durable task heartbeat
  };
  try {
    const answer = await runTurn(childCtx, messages);
    if (workerAbort.signal.aborted) {
      throw workerAbort.signal.reason instanceof Error
        ? workerAbort.signal.reason
        : new Error("Specialist stopped");
    }
    return answer;
  } finally {
    clearTimeout(timeout);
    clearInterval(watchdog);
    parentCtx.signal?.removeEventListener?.("abort", abortFromParent);
  }
}
