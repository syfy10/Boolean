// The local engine plus the cloud providers (OpenAI, GLM, Claude) all speak the
// OpenAI chat-completions protocol, so one client covers everything. Claude uses
// Anthropic's OpenAI-compatible endpoint.
import * as engine from "./engine.js";
import { CLOUD, CLOUD_BACKEND_URL, saveConfig } from "./config.js";

/**
 * Resolve the current provider to a chat target { base, apiKey, model, headers? }.
 * For "local" this also starts the embedded engine if needed.
 */
export async function resolveTarget(config, onStatus = () => {}) {
  if (config.provider === "local") {
    const { base, model } = await engine.ensureRunning(config, onStatus);
    return { base, apiKey: "local", model, provider: "local" };
  }
  if (config.provider === "boolean") {
    const c = config.cloudBackend || {};
    if (!c.sessionToken) {
      throw new Error("Sign in to Boolean Cloud first. Use the Sign in button near Settings.");
    }
    const base = String(c.url || CLOUD_BACKEND_URL).replace(/\/+$/, "");
    return {
      base,
      apiKey: c.sessionToken,
      provider: "boolean",
      model: config.boolean?.model || c.tokens?.default_model || "@cf/qwen/qwen3-30b-a3b-fp8",
      noStream: true,
      onCloudTokens: (tokens) => {
        config.cloudBackend = { ...(config.cloudBackend || {}), tokens };
        saveConfig(config);
      }
    };
  }
  if (CLOUD[config.provider]) {
    const p = config[config.provider];
    if (config.provider === "zaiCoding" && !p.approvedUse) {
      throw new Error("Confirm that Z.AI has approved Boolean or that your use is supported before using the Coding Plan.");
    }
    if (!p.apiKey) {
      throw new Error(`no ${CLOUD[config.provider]} API key set — add it in Settings or run: /key ${config.provider} <key>`);
    }
    return { base: p.baseUrl, apiKey: p.apiKey, model: p.model, provider: config.provider };
  }
  throw new Error(`unknown provider: ${config.provider}`);
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
    ? "The Cloud connection was interrupted. Your Cloud selection and sign-in are still active. Retry this message."
    : "Could not reach the Cloud model. Your Cloud selection and sign-in are still active. Check your connection and retry.");
  err.code = "cloud_connection_interrupted";
  err.cause = cause;
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
  return attempt === 0 ? 250 : 750;
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
    if (res.status === 401 && target.provider === "boolean") {
      const err = new Error("Your Boolean Cloud session expired. Sign in again to continue.");
      err.status = res.status;
      err.code = "cloud_auth_required";
      err.body = errText;
      throw err;
    }
    const err = new Error(`${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status;
    err.body = errText;
    err.retryAfter = res.headers.get("retry-after");
    throw err;
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
      if (payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.usage) usage = { input: obj.usage.prompt_tokens || 0, output: obj.usage.completion_tokens || 0, estimated: false };
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onToken(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
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
  const maxAttempts = cloud ? 3 : 1;
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
      if (err?.name === "AbortError" || err?.code === "cloud_auth_required" || !cloud) throw err;
      const retryable = err?.code === "cloud_transport_error" || RETRYABLE_CLOUD_STATUSES.has(err?.status);
      if (!retryable) throw err;
      if (emitted) throw cloudConnectionError(true, err);
      if (attempt + 1 >= maxAttempts) throw cloudConnectionError(false, err);
      await waitForRetry(retryDelay(err, attempt), signal);
    }
  }
  throw cloudConnectionError(false);
}

// static fallbacks when a provider has no usable /models endpoint
const STATIC_MODELS = {
  boolean: ["@cf/qwen/qwen3-30b-a3b-fp8"],
  openai: ["gpt-5.1", "gpt-5.1-codex", "gpt-5-mini", "gpt-4.1"],
  glm: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
  zaiCoding: ["GLM-5.1", "GLM-5-Turbo", "GLM-4.7", "GLM-4.5-Air"],
  claude: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"]
};

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
export async function listProviderModels(config) {
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
  if (config.provider === "boolean") {
    const model = config.boolean?.model || config.cloudBackend?.tokens?.default_model || "@cf/qwen/qwen3-30b-a3b-fp8";
    return [{ name: model, installed: true }];
  }
  if (CLOUD[config.provider]) {
    const p = config[config.provider];
    try {
      const res = await fetch(`${p.baseUrl}/models`, {
        headers: { authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        const ids = usableProviderModels(config.provider, (data.data || []).map((m) => m.id), p.model);
        if (ids.length) return ids.map((id) => ({ name: id, installed: true }));
      }
    } catch { /* fall back to static list */ }
    return (STATIC_MODELS[config.provider] || []).map((id) => ({ name: id, installed: true }));
  }
  return [];
}

/** Quick health check for the active provider (no side effects). */
export async function backendUp(config) {
  try {
    if (config.provider === "local") {
      return engine.listLocalModels().length > 0 && !!engine.findEngineBinary();
    }
    if (config.provider === "boolean") return !!config.cloudBackend?.sessionToken;
    if (CLOUD[config.provider]) {
      if (config.provider === "zaiCoding" && !config.zaiCoding?.approvedUse) return false;
      return !!config[config.provider].apiKey;
    }
    return false;
  } catch {
    return false;
  }
}
