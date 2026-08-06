import path from "node:path";

const MAX_CAPABILITY_RECORDS = 80;

function clean(value) {
  return String(value || "").trim();
}

export function modelCapabilityKey(config, target = {}) {
  const provider = clean(target.provider || config?.provider || "unknown").toLowerCase();
  const settings = config?.[provider] || {};
  const base = clean(target.base || settings.baseUrl || "").replace(/\/+$/, "").toLowerCase();
  const model = clean(target.model || settings.model || "").toLowerCase();
  return `${provider}|${base}|${model}`;
}

export function canonicalCapabilityModelId(config, target = {}) {
  const provider = clean(target.provider || config?.provider || "unknown").toLowerCase() || "unknown";
  const settings = config?.[provider] || {};
  const model = clean(target.model || settings.model || "default").replace(/^\/+|\/+$/g, "") || "default";
  return `${provider}/${model}`;
}

function inferredNativeToolSupport(config, target = {}) {
  const provider = clean(target.provider || config?.provider).toLowerCase();
  const model = clean(target.model || config?.[provider]?.model).toLowerCase();
  const base = clean(target.base || config?.[provider]?.baseUrl).toLowerCase();
  // Z.AI's GLM-5-Turbo Coding Plan endpoint currently rejects Boolean's
  // OpenAI-compatible native function catalog. Keep this scoped to the exact
  // provider/endpoint/model combination; a future successful native call
  // overwrites the inference in the persisted capability record.
  if (provider === "zaicoding" && model === "glm-5-turbo") return false;
  if (/api\.z\.ai\/api\/coding\/paas\/v4\/?$/.test(base) && model === "glm-5-turbo") return false;
  return null;
}

export function recordedModelCapability(config, target = {}) {
  const key = modelCapabilityKey(config, target);
  const record = config?.modelCapabilities?.[key];
  if (record && typeof record === "object") return { key, ...record };
  return { key };
}

export function nativeToolSupport(config, target = {}) {
  const record = recordedModelCapability(config, target);
  if (typeof record.nativeTools === "boolean") return record.nativeTools;
  return inferredNativeToolSupport(config, target);
}

export function recordNativeToolSupport(config, target = {}, supported, reason = "") {
  if (!config || typeof supported !== "boolean") return null;
  const key = modelCapabilityKey(config, target);
  const current = config.modelCapabilities && typeof config.modelCapabilities === "object"
    ? config.modelCapabilities
    : {};
  const next = {
    ...(current[key] || {}),
    nativeTools: supported,
    reason: clean(reason).slice(0, 240),
    testedAt: Date.now()
  };
  current[key] = next;
  const entries = Object.entries(current)
    .sort((a, b) => Number(b[1]?.testedAt || 0) - Number(a[1]?.testedAt || 0))
    .slice(0, MAX_CAPABILITY_RECORDS);
  config.modelCapabilities = Object.fromEntries(entries);
  return { key, ...next };
}

const CAPABILITY_PROBE_TOOL = {
  type: "function",
  function: {
    name: "boolean_capability_probe",
    description: "Harmless capability check. Request this function once; Boolean will not execute it.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
};

export function capabilityProbeTool() {
  return structuredClone(CAPABILITY_PROBE_TOOL);
}

export function evaluateCapabilityProbeReply(reply) {
  const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
  const matched = calls.some((call) => call?.function?.name === CAPABILITY_PROBE_TOOL.function.name);
  return {
    supported: matched,
    reason: matched
      ? "Native function-call probe passed."
      : "The model answered without requesting Boolean's capability probe."
  };
}

export function capabilityProbeUnsupportedError(error) {
  const detail = [
    error?.message,
    error?.body,
    error?.cause?.message
  ].filter(Boolean).join(" ");
  return /\b(tools?|tool_calls?|function calls?|function calling)\b.{0,100}\b(unsupported|not supported|does not support|unavailable|invalid|unknown|disabled|cannot|can't)\b/i.test(detail)
    || /\b(unsupported|not supported|does not support|unavailable|invalid|unknown|disabled|cannot|can't)\b.{0,100}\b(tools?|tool_calls?|function calls?|function calling)\b/i.test(detail);
}

export function modelCapabilityProfile(config, target = {}, options = {}) {
  const nativeTools = nativeToolSupport(config, target);
  const preference = clean(config?.ui?.codingAgent?.compatibilityMode || "auto").toLowerCase();
  const forcedPatch = preference === "patch";
  const forcedReview = preference === "review";
  const mode = forcedReview
    ? "review"
    : forcedPatch || nativeTools === false
      ? "patch"
      : nativeTools === true
        ? "native"
        : "checking";
  const nativeAgent = mode === "native" || mode === "checking";
  const vision = options.vision === true ? true : options.vision === false ? false : null;
  return {
    key: modelCapabilityKey(config, target),
    id: canonicalCapabilityModelId(config, target),
    provider: clean(target.provider || config?.provider),
    model: clean(target.model || config?.[target.provider || config?.provider]?.model),
    mode,
    label: mode === "native"
      ? "Full coding"
      : mode === "patch"
        ? "Compatible coding"
        : mode === "review"
          ? "Review/chat only"
          : "Checking tool support",
    warning: mode === "patch"
      ? "This model does not use native function calls. Boolean provides coding, terminal, browser, and deployment tools through its validated compatibility bridge."
        : mode === "review"
          ? "This model is restricted to review and chat. It cannot edit files, use the terminal or browser, or deploy."
          : "",
    testedAt: Number(recordedModelCapability(config, target).testedAt || 0),
    reason: clean(recordedModelCapability(config, target).reason),
    nativeTools,
    capabilities: {
      chat: true,
      review: true,
      fileEdit: mode === "patch" ? true : nativeAgent,
      terminal: mode === "patch" ? true : nativeAgent,
      browser: mode === "patch" ? true : nativeAgent,
      deploy: mode === "patch" ? true : nativeAgent,
      vision
    }
  };
}

export function validateBooleanPatch(value, projectDir) {
  const edits = Array.isArray(value?.edits) ? value.edits : [];
  if (!projectDir) throw new Error("Patch mode requires an open project.");
  if (!edits.length) throw new Error("The Boolean patch contains no edits.");
  if (edits.length > 100) throw new Error("A Boolean patch may contain at most 100 edits.");
  const root = path.resolve(projectDir);
  const files = new Set();
  const normalized = edits.map((edit, index) => {
    const relative = clean(edit?.path);
    if (!relative || path.isAbsolute(relative)) throw new Error(`Patch edit ${index + 1} needs a relative workspace path.`);
    const absolute = path.resolve(root, relative);
    const rel = path.relative(root, absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Patch edit ${index + 1} points outside the open project.`);
    }
    files.add(absolute.toLowerCase());
    if (files.size > 40) throw new Error("A Boolean patch may change at most 40 files.");
    if (typeof edit.old === "string" && typeof edit.new === "string" && edit.old.length) {
      if (edit.old.length + edit.new.length > 120_000) throw new Error(`Patch edit ${index + 1} is too large.`);
      return { kind: "replace", path: relative, absolute, old: edit.old, new: edit.new };
    }
    if (typeof edit.content === "string") {
      if (edit.content.length > 120_000) throw new Error(`Patch edit ${index + 1} is too large.`);
      return { kind: "create", path: relative, absolute, content: edit.content };
    }
    throw new Error(`Patch edit ${index + 1} must contain exact old/new text or new-file content.`);
  });
  return normalized;
}

export function parseBooleanPatch(text, projectDir) {
  const source = String(text || "");
  const blocks = [...source.matchAll(/```boolean_patch\s*\r?\n([\s\S]*?)\r?\n```/gi)];
  if (!blocks.length) return null;
  if (blocks.length !== 1) throw new Error("Return exactly one fenced boolean_patch block.");
  let value;
  try {
    value = JSON.parse(blocks[0][1]);
  } catch {
    throw new Error("The boolean_patch block must contain valid JSON.");
  }
  return validateBooleanPatch(value, projectDir);
}
