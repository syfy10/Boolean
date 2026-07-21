// The local engine plus the cloud providers (OpenAI, GLM, Claude) all speak the
// OpenAI chat-completions protocol, so one client covers everything. Claude uses
// Anthropic's OpenAI-compatible endpoint.
import * as engine from "./engine.js";
import { CLOUD } from "./config.js";
import { budgetExceeded } from "./usage.js";

export function providerBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

// Return true/false only when Boolean knows the endpoint's image capability.
// null keeps custom OpenAI-compatible endpoints permissive because their model
// names and capabilities are not standardized.
export function providerImageSupport(config) {
  const provider = String(config?.provider || "");
  if (provider === "local") return null;
  if (provider === "openai" || provider === "claude") return true;
  if (provider === "zaiCoding") return false;

  const settings = config?.[provider] || {};
  const model = String(settings.model || "").toLowerCase();
  const base = providerBaseUrl(settings.baseUrl);
  if (provider === "customApi" && /api\.z\.ai\/api\/coding\/paas(?:\/v\d+)?$/i.test(base)) return false;
  if (provider === "glm") return /(?:^|[-_.])glm[-_.]?(?:4(?:\.\d+)?|5)[-_.]?v(?:[-_.]|$)|vision/.test(model);
  if (provider === "customApi" && /(?:vision|[-_.]vl(?:[-_.]|$)|glm[-_.]?(?:4(?:\.\d+)?|5)[-_.]?v)/.test(model)) return true;
  return null;
}

/**
 * Resolve the current provider to a chat target { base, apiKey, model, headers? }.
 * For "local" this also starts the embedded engine if needed.
 */
export async function resolveProviderTarget(config, provider = config.provider, onStatus = () => {}) {
  if (provider === "local") {
    const { base, model, ctx } = await engine.ensureRunning(config, onStatus);
    return { base, apiKey: "local", model, provider: "local", ctx };
  }
  if (CLOUD[provider]) {
    const p = config[provider];
    if (!p.apiKey) {
      throw new Error(`no ${CLOUD[provider]} API key set - add it in Settings or run: /key ${provider} <key>`);
    }
    const base = providerBaseUrl(p.baseUrl);
    if (!base || !p.model) {
      throw new Error(`${CLOUD[provider]} needs an endpoint and model in Settings.`);
    }
    if (budgetExceeded(config.budgetLimit || 0)) {
      throw new Error(
        `Monthly cloud budget of ${(config.budgetLimit || 0).toFixed(2)} has been reached. ` +
        "Cloud models are paused until next month or until you raise the budget in Settings > Usage. " +
        "Local models remain available — switch to a local model in Settings to continue working."
      );
    }
    return { base, apiKey: p.apiKey, model: p.model, provider, maxRetries: config.cloudRetries || 3 };
  }
  throw new Error(`unknown provider: ${provider}`);
}

export async function resolveTarget(config, onStatus = () => {}) {
  return resolveProviderTarget(config, config.provider, onStatus);
}

/**
 * One OpenAI-compatible chat call. Returns the assistant message.
 * If onToken is provided, streams the response and calls onToken(text) per chunk
 * so the UI can show live progress instead of a frozen spinner.
 */
// rough token estimate when a provider returns no usage
const estTokens = (s) => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s || "").length) / 4);

function normalizeMessagesForProvider(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    const prev = out[out.length - 1];
    const plainAssistant = m.role === "assistant" && !m.tool_calls?.length;
    const prevPlainAssistant = prev?.role === "assistant" && !prev.tool_calls?.length;
    if (plainAssistant && prevPlainAssistant) {
      prev.content = [prev.content, m.content].filter(Boolean).join("\n\n");
      continue;
    }
    out.push(m);
  }
  return out;
}

const RETRYABLE_CLOUD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cloudConnectionError(interrupted = false, cause) {
  const err = new Error(interrupted
    ? "The Cloud connection was interrupted. Your selected provider and saved API key are unchanged. Retry this message."
    : "Could not reach the Cloud model. Your selected provider and saved API key are unchanged. Check your connection and retry.");
  err.code = "cloud_connection_interrupted";
  err.cause = cause;
  return err;
}

function cloudProviderError(target, status, body, retryAfter) {
  let detail = "";
  try {
    const parsed = JSON.parse(body || "{}");
    const candidate = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof candidate === "string") detail = candidate.replace(/\s+/g, " ").trim().slice(0, 220);
  } catch { /* use the status-specific explanation */ }
  const label = target.provider === "zaiCoding" || /api\.z\.ai/i.test(target.base || "") ? "Z.AI" : "The Cloud provider";
  let message;
  if (status === 401) message = `${label} rejected the API key. Re-enter it in Settings > Third-party connections.`;
  else if (status === 402) message = `${label} reports insufficient balance or an inactive plan. Check the provider account.`;
  else if (status === 403) message = `${label} does not allow this request on the current plan or endpoint.`;
  else if (status === 429) message = `${label} rate or usage limit was reached. Wait for the limit to reset or check the provider plan.`;
  else if (status >= 500) message = `${label} is temporarily unavailable. Your selected provider and saved API key are unchanged; retry shortly.`;
  else message = `${label} rejected the request (${status}).`;
  if (detail && !message.toLowerCase().includes(detail.toLowerCase())) message += ` ${detail}`;
  const err = new Error(message);
  err.code = "cloud_provider_error";
  err.status = status;
  err.body = body;
  err.retryAfter = retryAfter;
  return err;
}

function localConnectionError(interrupted = false, cause) {
  const err = new Error(interrupted
    ? "The Local model connection stopped during its response. Your task was checkpointed; Continue can resume it."
    : "The Local model connection stopped before it answered. Boolean will restart the local engine and retry once.");
  err.code = "local_transport_error";
  err.partial = interrupted;
  err.cause = cause;
  return err;
}

function retryDelay(err, attempt) {
  const headerSeconds = err?.retryAfter == null || err.retryAfter === "" ? NaN : Number(err.retryAfter);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return Math.min(2000, headerSeconds * 1000);
  // Exponential backoff with jitter: base * 2^attempt ± 25% jitter.
  // attempt 0 → ~250ms, attempt 1 → ~500ms, attempt 2 → ~1000ms
  const base = 250 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.min(2000, Math.round(base + jitter));
}

async function chatCompletionOnce(target, messages, tools, signal, onToken) {
  messages = normalizeMessagesForProvider(messages);
  const stream = typeof onToken === "function" && !target.noStream;
  const body = { model: target.model, messages, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (tools) {
    body.tools = tools;
    if (target.toolChoice) body.tool_choice = target.toolChoice;
  }

  let res;
  try {
    res = await fetch(`${target.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}`, ...(target.headers || {}) },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    // network-level failure (engine not running, wrong host, offline) — make it readable
    const e = target.provider === "local"
      ? localConnectionError(false, err)
      : cloudConnectionError(false, err);
    if (target.provider !== "local") e.code = "cloud_transport_error";
    e.cause = err;
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text();
    if (target.provider === "local") {
      const err = new Error(`${res.status}: ${errText.slice(0, 400)}`);
      err.status = res.status;
      err.body = errText;
      throw err;
    }
    throw cloudProviderError(target, res.status, errText, res.headers.get("retry-after"));
  }

  if (!stream) {
    const data = await res.json();
    const m = data.choices?.[0]?.message || { role: "assistant", content: "" };
    if (data.tokens && typeof target.onCloudTokens === "function") target.onCloudTokens(data.tokens);
    if (data.usage) {
      m.usage = { input: data.usage.prompt_tokens || 0, output: data.usage.completion_tokens || 0, estimated: false };
    } else {
      m.usage = { input: estTokens(messages.map((x) => x.content).join("")), output: estTokens(m.content), estimated: true };
    }
    return m;
  }

  // ── parse the SSE stream, aggregating content + tool_calls + usage ──
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let usage = null;
  let streamFinished = false;
  let terminalChoice = false;
  const toolCalls = []; // by index
  for (;;) {
    let part;
    try {
      part = await reader.read();
    } catch (cause) {
      if (cause?.name === "AbortError" || signal?.aborted) throw cause;
      const err = target.provider === "local"
        ? localConnectionError(content.length > 0, cause)
        : cloudConnectionError(content.length > 0, cause);
      if (target.provider !== "local") err.code = "cloud_transport_error";
      throw err;
    }
    const { done, value } = part;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { streamFinished = true; break; }
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.usage) usage = { input: obj.usage.prompt_tokens || 0, output: obj.usage.completion_tokens || 0, estimated: false };
      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) { content += delta.content; onToken(delta.content); }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (choice && choice.finish_reason != null) terminalChoice = true;
    }
    // Some OpenAI-compatible providers omit [DONE] and leave the HTTP stream
    // alive after a terminal finish_reason. Process the whole buffered chunk
    // first (it may also contain usage), then close the reader ourselves.
    if (terminalChoice) streamFinished = true;
    if (streamFinished) {
      try { await reader.cancel(); } catch { /* response is already complete */ }
      break;
    }
  }
  const msg = { role: "assistant", content };
  const calls = toolCalls.filter(Boolean);
  if (calls.length) msg.tool_calls = calls;
  msg.usage = usage || {
    input: estTokens(messages.map((x) => x.content).join("")),
    output: estTokens(content),
    estimated: true
  };
  return msg;
}

export async function chatCompletion(target, messages, tools, signal, onToken) {
  const cloud = target.provider !== "local";
  // Cloud retry count is configurable via config.cloudRetries (default 3).
  // Local models get a single attempt (the engine itself handles internal retries).
  const maxAttempts = cloud ? (target.maxRetries || 3) : 1;
  let emitted = false;
  const trackedToken = typeof onToken === "function"
    ? (text) => {
        if (text) emitted = true;
        onToken(text);
      }
    : onToken;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await chatCompletionOnce(target, messages, tools, signal, trackedToken);
    } catch (err) {
      if (err?.name === "AbortError" || !cloud) throw err;
      const retryable = err?.code === "cloud_transport_error" || RETRYABLE_CLOUD_STATUSES.has(err?.status);
      if (!retryable) throw err;
      if (emitted) throw cloudConnectionError(true, err);
      if (attempt + 1 >= maxAttempts) {
        if (err?.status) throw err;
        throw cloudConnectionError(false, err);
      }
      await waitForRetry(retryDelay(err, attempt), signal);
    }
  }
  throw cloudConnectionError(false);
}

// static fallbacks when a provider has no usable /models endpoint
const STATIC_MODELS = {
  openai: ["gpt-5.1", "gpt-5.1-codex", "gpt-5-mini", "gpt-4.1"],
  glm: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
  zaiCoding: ["GLM-5.1", "GLM-5-Turbo", "GLM-4.7", "GLM-4.5-Air"],
  claude: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  customApi: []
};

const PROVIDER_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const providerModelCache = new Map();

function providerModelCacheKey(config) {
  const provider = config.provider || "local";
  const settings = config[provider] || {};
  return `${provider}|${providerBaseUrl(settings.baseUrl || "")}|${settings.model || ""}|${settings.apiKey ? "key" : "none"}`;
}

export function clearProviderModelCache(provider = "") {
  if (!provider) {
    providerModelCache.clear();
    return;
  }
  for (const key of providerModelCache.keys()) {
    if (key.startsWith(`${provider}|`)) providerModelCache.delete(key);
  }
}

function usableProviderModels(provider, ids, selected = "") {
  let models = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (provider === "zaiCoding") {
    const supported = new Map([
      ["glm-5.1", "GLM-5.1"],
      ["glm-5-turbo", "GLM-5-Turbo"],
      ["glm-4.7", "GLM-4.7"],
      ["glm-4.5-air", "GLM-4.5-Air"]
    ]);
    models = models.map((id) => supported.get(id.toLowerCase())).filter(Boolean);
  }
  if (provider === "openai") {
    const incompatible = /(?:audio|realtime|transcrib|tts|whisper|image|dall-e|embedding|moderation|sora|search-preview|search-api|deep-research)/i;
    models = models.filter((id) => /^(?:gpt-|o[1345](?:-|$)|chat-latest$)/i.test(id) && !incompatible.test(id));
    models = models.filter((id) => !/-20\d{2}-\d{2}-\d{2}$/.test(id) && !/(?:^|-)\d{4}$/.test(id));
  }
  models.sort((a, b) => {
    if (a === selected) return -1;
    if (b === selected) return 1;
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
  });
  return models;
}

/** List models for the ACTIVE provider. Local also returns downloadable catalog. */
export async function listProviderModels(config, options = {}) {
  if (config.provider === "local") {
    const installed = engine.listLocalModels();
    const mmprojs = engine.listMmprojFiles();
    const catalog = engine.CATALOG
      .filter((m) => !installed.includes(m.file))
      .map((m) => ({ name: m.file, id: m.id, size: m.size, note: m.note, installed: false }));
    return [
      ...installed.map((f) => {
        const health = engine.modelFileHealth(f);
        return { name: f, installed: true, healthy: health.ok, healthReason: health.ok ? "" : health.reason, vision: !!engine.autoMatchMmproj(f, mmprojs) };
      }),
      ...catalog
    ];
  }
  if (CLOUD[config.provider]) {
    const p = config[config.provider];
    const fallback = STATIC_MODELS[config.provider] || [];
    const fallbackIds = fallback.length ? fallback : (p.model ? [p.model] : []);
    const key = providerModelCacheKey(config);
    const cached = providerModelCache.get(key);
    const now = Date.now();
    if (cached && !options.force && now - cached.at < PROVIDER_MODEL_CACHE_TTL_MS) return cached.models;
    if (options.remote === false) {
      return cached?.models || fallbackIds.map((id) => ({ name: id, installed: true }));
    }
    try {
      const res = await fetch(`${providerBaseUrl(p.baseUrl)}/models`, {
        headers: { authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        const ids = usableProviderModels(config.provider, (data.data || []).map((m) => m.id), p.model);
        if (ids.length) {
          const models = ids.map((id) => ({ name: id, installed: true }));
          providerModelCache.set(key, { at: now, models });
          return models;
        }
      }
    } catch { /* fall back to static list */ }
    const models = fallbackIds.map((id) => ({ name: id, installed: true }));
    providerModelCache.set(key, { at: now, models });
    return models;
  }
  return [];
}

/** Quick health check for the active provider (no side effects). */
export async function backendUp(config) {
  try {
    if (config.provider === "local") {
      if (!engine.findEngineBinary()) return false;
      const selected = String(config.local?.model || "").trim();
      const installed = engine.listLocalModels();
      if (!installed.length) return false;
      if (!selected) return true;
      if (!installed.includes(selected)) return false;
      return engine.modelFileHealth(selected).ok;
    }
    if (CLOUD[config.provider]) {
      return !!config[config.provider].apiKey;
    }
    return false;
  } catch {
    return false;
  }
}
