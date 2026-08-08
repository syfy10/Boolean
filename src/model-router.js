import path from "node:path";

import { CLOUD } from "./config.js";
import { providerImageSupport } from "./providers.js";

export const AUTO_MODEL_ROUTES = Object.freeze(["chat", "coding", "vision", "research", "fast"]);
export const AUTO_EXECUTION_ENGINES = Object.freeze(["boolean", "codex", "claude-code"]);

const HEALTH_COOLDOWN_MS = 2 * 60 * 1000;
const providerHealth = new Map();

const clean = (value) => String(value || "").trim();
const lower = (value) => clean(value).toLowerCase();

function imageContent(messages = []) {
  return messages.some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === "image_url" || part?.type === "input_image"));
}

function latestUserText(messages = []) {
  const message = [...messages].reverse().find((item) => item?.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text" || part?.type === "input_text")
    .map((part) => part.text || "").join("\n");
}

export function routeForTurn(messages = [], options = {}) {
  if (imageContent(messages) || options.hasImages === true) return "vision";
  const mode = lower(options.turnMode);
  if (mode === "action" || mode === "inspect") return "coding";
  if (mode === "connector" || mode === "research") return "research";
  const text = lower(options.latestText || latestUserText(messages));
  if (/\b(?:image|photo|picture|screenshot|visual|logo|mockup|diagram|ocr)\b/.test(text)) return "vision";
  if (/\b(?:research|sources?|citations?|current|latest|news|compare|find online|look up|browse|website)\b/.test(text)) return "research";
  if (/\b(?:code|coding|repo|repository|file|function|class|bug|fix|build|test|deploy|terminal|command|api|database|css|html|javascript|typescript|python)\b/.test(text)) return "coding";
  if (text.length <= 180 && !/[\r\n]/.test(text)) return "fast";
  return "chat";
}

function modelForProvider(config, provider) {
  return provider === "local"
    ? clean(config?.local?.model || config?.model)
    : clean(config?.[provider]?.model);
}

function healthKey(provider, model) {
  return `${lower(provider)}|${lower(model)}`;
}

export function canonicalModelId(target = {}) {
  const provider = lower(target.provider || "unknown") || "unknown";
  const model = clean(target.model || "default").replace(/^\/+|\/+$/g, "") || "default";
  return `${provider}/${model}`;
}

export function noteAutoModelOutcome(target = {}, outcome = {}) {
  const provider = clean(target.provider);
  const model = clean(target.model);
  if (!provider || !model) return;
  const key = healthKey(provider, model);
  const previous = providerHealth.get(key) || { successes: 0, failures: 0, latencyMs: 0 };
  const success = outcome.ok === true;
  const latencyMs = Math.max(0, Number(outcome.latencyMs) || 0);
  providerHealth.set(key, {
    successes: previous.successes + (success ? 1 : 0),
    failures: previous.failures + (success ? 0 : 1),
    latencyMs: latencyMs ? (previous.latencyMs ? Math.round((previous.latencyMs * 3 + latencyMs) / 4) : latencyMs) : previous.latencyMs,
    lastError: success ? "" : clean(outcome.error).slice(0, 240),
    lastSuccessAt: success ? Date.now() : previous.lastSuccessAt || 0,
    lastFailureAt: success ? previous.lastFailureAt || 0 : Date.now(),
    cooldownUntil: success ? 0 : Date.now() + HEALTH_COOLDOWN_MS
  });
}

export function autoModelHealth(target = {}) {
  return { ...(providerHealth.get(healthKey(target.provider, target.model)) || {}) };
}

export function resetAutoModelHealth() {
  providerHealth.clear();
}

export function autoModelHealthSnapshot() {
  const now = Date.now();
  return [...providerHealth.entries()].map(([key, value]) => ({
    id: key.replace("|", "/"),
    successes: Number(value.successes || 0),
    failures: Number(value.failures || 0),
    latencyMs: Number(value.latencyMs || 0),
    state: Number(value.cooldownUntil || 0) > now ? "cooldown" : "ready",
    cooldownMs: Math.max(0, Number(value.cooldownUntil || 0) - now),
    lastError: clean(value.lastError).slice(0, 160)
  }));
}

function connectedCandidates(config = {}) {
  const providers = [];
  // Local and Cloud are hard routing boundaries. A configured local model may
  // only participate in Auto while Local is the selected network mode; Cloud
  // retries, handoffs, and verification must remain on connected cloud APIs.
  if (clean(config?.provider || "local") === "local" && config?.local?.model) providers.push("local");
  for (const provider of Object.keys(CLOUD)) {
    if (config?.[provider]?.apiKey && config?.[provider]?.model) providers.push(provider);
  }
  return providers.map((provider) => ({ provider, model: modelForProvider(config, provider) }));
}

function costRank(candidate) {
  if (candidate.provider === "local") return 0;
  const model = lower(candidate.model);
  if (/\b(?:nano|mini|flash-lite|lite|haiku|small)\b/.test(model)) return 1;
  if (/\b(?:flash|turbo|fast|air)\b/.test(model)) return 2;
  return 3;
}

function qualityRank(candidate) {
  const model = lower(candidate.model);
  let score = 2;
  if (/\b(?:pro|opus|max|ultra|reason|thinking|gpt-5|sonnet)\b/.test(model)) score += 3;
  if (/\b(?:mini|lite|flash|turbo|fast|air|nano)\b/.test(model)) score -= 1;
  if (/\b(?:code|coder|codex|devstral)\b/.test(model)) score += 1;
  return score;
}

export function autoModelQualityRank(candidate) {
  return qualityRank(candidate || {});
}

function supportsRoute(config, candidate, route) {
  if (route === "vision") {
    if (candidate.provider === "local") {
      const mmproj = config?.local?.mmprojMap?.[candidate.model];
      return !!mmproj;
    }
    const scoped = { ...config, provider: candidate.provider, [candidate.provider]: {
      ...(config?.[candidate.provider] || {}), model: candidate.model
    } };
    return providerImageSupport(scoped) === true;
  }
  if (route === "coding") {
    const mode = lower(config?.ui?.codingAgent?.compatibilityMode || "auto");
    if (mode === "review") return false;
    return true;
  }
  return true;
}

function projectPreference(config, projectDir) {
  const projects = config?.ui?.modelRouting?.projects;
  if (!projects || typeof projects !== "object" || !projectDir) return null;
  const exact = lower(path.resolve(projectDir));
  for (const [key, value] of Object.entries(projects)) {
    try {
      if (lower(path.resolve(key)) === exact && value && typeof value === "object") return value;
    } catch { /* ignore malformed saved paths */ }
  }
  return null;
}

function configuredProfile(config, route) {
  const profile = config?.ui?.modelRouting?.profiles?.[route];
  return profile && typeof profile === "object" ? profile : {};
}

export function autoSubscriptionEnabled(subscriptions = {}, engine = "") {
  // Pre-existing configs stored false as the old default, so only the new
  // explicit marker turns a false value into a durable user opt-out.
  if (subscriptions?.explicit !== true) return true;
  return subscriptions?.[engine] !== false;
}

export function selectExecutionEngine(config = {}, messages = [], options = {}) {
  const configured = lower(config?.codingEngine || "boolean");
  const route = AUTO_MODEL_ROUTES.includes(options.route) ? options.route : routeForTurn(messages, options);
  if (AUTO_EXECUTION_ENGINES.includes(configured)) {
    return {
      automatic: false,
      engine: configured,
      route,
      reason: configured === "boolean" ? "Boollm was selected manually." : `${configured === "codex" ? "Codex" : "Claude Code"} was selected manually.`
    };
  }
  if (configured !== "auto" || options.disabled === true) {
    return { automatic: configured === "auto", engine: "boolean", route, reason: options.disabled === true ? "Automatic subscription routing is unavailable for this turn." : "Boollm was selected manually." };
  }

  const routing = config?.ui?.modelRouting || {};
  const subscriptions = routing.subscriptionEngines || {};
  const profile = configuredProfile(config, route);
  const requested = lower(profile.engine || "auto");
  const escalationRequired = options.escalationRequired === true;
  const taskExecution = options.taskExecution === true;
  const ready = {
    codex: autoSubscriptionEnabled(subscriptions, "codex") && options.codexReady === true,
    "claude-code": autoSubscriptionEnabled(subscriptions, "claudeCode") && options.claudeReady === true
  };

  // Images are different from ordinary first-attempt routing: sending pixels
  // to a known text-only API cannot succeed. Prefer the user's configured,
  // signed-in subscription engine immediately when Boollm's selected model has
  // no image capability. Both subscription runners preserve the actual image.
  if (!escalationRequired && route === "vision" && options.booleanVisionReady === false) {
    const preferred = requested === "codex" || requested === "claude-code"
      ? requested
      : lower(subscriptions.preferred || "codex");
    const order = preferred === "claude-code" ? ["claude-code", "codex"] : ["codex", "claude-code"];
    const engine = order.find((candidate) => ready[candidate]) || "boolean";
    return {
      automatic: true,
      engine,
      route,
      reason: engine === "boolean"
        ? "The selected model is text-only and no approved image-capable subscription is ready."
        : `The selected model is text-only; routing this image directly to the ready ${engine === "codex" ? "Codex" : "Claude Code"} subscription.`
    };
  }

  // Auto always gives the selected GLM, DeepSeek, local, or other connected
  // Boollm model the first attempt. Subscription engines are escalation-only
  // after a code/project task fails or cannot produce a verified completion.
  if (!escalationRequired) {
    return { automatic: true, engine: "boolean", route, reason: "The selected Boollm API gets the first attempt." };
  }
  if ((route !== "coding" && !taskExecution) || route === "vision" || route === "research") {
    return { automatic: true, engine: "boolean", route, reason: "Subscription escalation is limited to code and project tasks." };
  }
  if (requested === "boolean") {
    return { automatic: true, engine: "boolean", route, reason: `${route} is assigned to Boollm with no subscription fallback.` };
  }
  if (["codex", "claude-code"].includes(requested)) {
    if (ready[requested]) {
      return { automatic: true, engine: requested, route, reason: `Boollm could not verify this task; escalating to the approved ${requested === "codex" ? "Codex" : "Claude"} subscription.` };
    }
    return { automatic: true, engine: "boolean", route, reason: `${requested === "codex" ? "Codex" : "Claude Code"} is the configured fallback but is not signed in and ready.` };
  }
  const preferred = lower(subscriptions.preferred || "codex");
  const order = preferred === "claude-code"
    ? ["claude-code", "codex"]
    : preferred === "first-ready"
      ? ["codex", "claude-code"]
      : ["codex", "claude-code"];
  const engine = order.find((candidate) => ready[candidate]) || "boolean";
  return {
    automatic: true,
    engine,
    route,
    reason: engine === "boolean"
      ? "No approved subscription engine is signed in and ready; keeping the task in Boollm."
      : `Boollm could not complete or verify this task; escalating to the approved ${engine === "codex" ? "Codex" : "Claude"} subscription.`
  };
}

function preferenceScore(candidate, route, preference) {
  const quality = qualityRank(candidate);
  const cost = costRank(candidate);
  let score = preference === "quality" ? quality * 8 - cost : preference === "cost" ? -cost * 8 + quality : quality * 4 - cost * 3;
  const model = lower(candidate.model);
  if (route === "coding" && /\b(?:code|coder|codex|devstral|gpt-5|sonnet)\b/.test(model)) score += 8;
  if (route === "research" && /\b(?:gemini|gpt|claude|sonnet|grok)\b/.test(model)) score += 5;
  if (route === "fast" && /\b(?:flash|turbo|fast|mini|lite|air|nano)\b/.test(model)) score += 9;
  if (route === "chat" && candidate.provider === "local") score += 3;
  const health = autoModelHealth(candidate);
  if (health.cooldownUntil > Date.now()) score -= 1000;
  if (health.successes) score += Math.min(4, health.successes);
  if (health.failures) score -= Math.min(6, health.failures);
  return score;
}

export function selectAutoModelRoute(config = {}, messages = [], options = {}) {
  const enabled = config?.ui?.autoRouteModels === true && options.disabled !== true;
  const route = AUTO_MODEL_ROUTES.includes(options.route) ? options.route : routeForTurn(messages, options);
  const selected = { provider: clean(config.provider || "local"), model: modelForProvider(config, config.provider || "local") };
  if (!enabled) return { enabled: false, route, target: selected, alternates: [], reason: "Automatic routing is off." };

  const routing = config?.ui?.modelRouting || {};
  const project = projectPreference(config, options.projectDir);
  const profile = configuredProfile(config, route);
  const preference = ["cost", "balanced", "quality"].includes(lower(project?.preference || routing.preference))
    ? lower(project?.preference || routing.preference)
    : "balanced";
  const locked = lower(project?.mode) === "locked";
  const requestedProvider = clean((locked ? project?.provider : profile.provider) || "");
  const requestedModel = clean((locked ? project?.model : profile.model) || "");
  let candidates = connectedCandidates(config).filter((candidate) => supportsRoute(config, candidate, route));
  if (!candidates.length) {
    return { enabled: true, route, target: selected, alternates: [], preference, reason: `No connected ${route} model is available; keeping the selected model.` };
  }

  const orderedTargets=Array.isArray(profile.targets)?profile.targets.map((item)=>{
    if(typeof item==="string"){
      const slash=item.indexOf("/");
      return slash>0?{provider:item.slice(0,slash),model:item.slice(slash+1)}:null;
    }
    return item&&typeof item==="object"?{provider:clean(item.provider),model:clean(item.model)}:null;
  }).filter(Boolean):[];
  if(orderedTargets.length){
    const rank=(candidate)=>{
      const index=orderedTargets.findIndex((item)=>lower(item.provider)===lower(candidate.provider)&&(!item.model||lower(item.model)===lower(candidate.model)));
      return index<0?Number.MAX_SAFE_INTEGER:index;
    };
    candidates.sort((a,b)=>{
      const coolingA=Number(autoModelHealth(a).cooldownUntil||0)>Date.now()?1:0;
      const coolingB=Number(autoModelHealth(b).cooldownUntil||0)>Date.now()?1:0;
      if(coolingA!==coolingB)return coolingA-coolingB;
      return rank(a)-rank(b)||preferenceScore(b,route,preference)-preferenceScore(a,route,preference);
    });
  } else if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "selected") {
    const configured = candidates.find((candidate) => candidate.provider === requestedProvider
      && (!requestedModel || candidate.model === requestedModel));
    if (configured) {
      const available = Number(autoModelHealth(configured).cooldownUntil || 0) <= Date.now();
      const others = candidates.filter((candidate) => candidate !== configured)
        .sort((a, b) => preferenceScore(b, route, preference) - preferenceScore(a, route, preference));
      candidates = available || locked ? [configured, ...others] : [...others, configured];
    }
  } else {
    candidates.sort((a, b) => preferenceScore(b, route, preference) - preferenceScore(a, route, preference));
    if (requestedProvider === "selected" || locked) {
      const current = candidates.find((candidate) => candidate.provider === selected.provider && (!selected.model || candidate.model === selected.model));
      if (current) candidates = [current, ...candidates.filter((candidate) => candidate !== current)];
    }
  }

  const target = candidates[0];
  const source = locked
    ? "project lock"
    : orderedTargets.length
      ? `ordered ${route} profile`
    : requestedProvider && requestedProvider !== "auto" && target.provider !== requestedProvider
      ? `healthy fallback for the ${route} profile`
      : requestedProvider && requestedProvider !== "auto"
        ? `${route} profile`
        : `${preference} ${route} route`;
  return {
    enabled: true,
    route,
    target,
    alternates: candidates.slice(1),
    preference,
    allowEscalation: routing.allowEscalation !== false && project?.allowEscalation !== false,
    reason: `${source}; ${route === "vision" ? "image capability required" : route === "coding" ? "coding and tool use expected" : route === "research" ? "research context expected" : route === "fast" ? "short low-complexity request" : "general conversation"}.`
  };
}

export function nextAutoModelTarget(selection = {}, current = {}) {
  const alternatives = Array.isArray(selection.alternates) ? selection.alternates : [];
  return alternatives.find((candidate) => candidate.provider !== current.provider || candidate.model !== current.model) || null;
}

// Every connected model that can serve `route`, strongest first. Used to hand an
// unfinished task to a different model when the current one gives up — independent
// of whether automatic per-turn routing is enabled. Cooldowns push a recently
// failed model to the back rather than removing it, so a handoff target always
// exists as long as another connected model does.
export function handoffCandidates(config = {}, route = "coding") {
  return connectedCandidates(config)
    .filter((candidate) => supportsRoute(config, candidate, route))
    .sort((a, b) => {
      const cooldownA = Number(autoModelHealth(a).cooldownUntil || 0) > Date.now() ? 1 : 0;
      const cooldownB = Number(autoModelHealth(b).cooldownUntil || 0) > Date.now() ? 1 : 0;
      if (cooldownA !== cooldownB) return cooldownA - cooldownB;
      return qualityRank(b) - qualityRank(a);
    });
}
