// Persistent token-usage accounting + cost/savings estimates.
// Stored in ~/.saz/usage.json so lifetime totals survive restarts & updates.
import fs from "node:fs";
import path from "node:path";
import { SAZ_DIR } from "./config.js";

const USAGE_FILE = path.join(SAZ_DIR, "usage.json");

// Approximate list price in USD per 1M tokens { in, out }. These are ESTIMATES
// for display only and may drift from providers' actual current pricing.
export const PRICING = {
  // OpenAI
  "gpt-5.1": { in: 1.25, out: 10 },
  "gpt-5.1-codex": { in: 1.25, out: 10 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  "gpt-4.1": { in: 2, out: 8 },
  // GLM (Z.ai)
  "glm-4.6": { in: 0.6, out: 2.2 },
  "glm-4.5": { in: 0.6, out: 2.2 },
  "glm-4.5-air": { in: 0.2, out: 1.1 },
  // Claude (Anthropic)
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 }
};

// price for a model name; local/unknown models are free ($0)
export function priceFor(model) {
  if (PRICING[model]) return PRICING[model];
  if (/\.gguf$/i.test(model || "")) return { in: 0, out: 0 };
  return PRICING[model] || { in: 0, out: 0 };
}

export function costOf(input, output, model) {
  const p = priceFor(model);
  return (input / 1e6) * p.in + (output / 1e6) * p.out;
}

export function loadUsage() {
  try {
    return { byKey: {}, ...JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) };
  } catch {
    return { byKey: {} };
  }
}

function save(u) {
  fs.mkdirSync(SAZ_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}

// record one model call. key is "provider/model" so per-provider & per-model both work.
export function recordUsage(provider, model, input, output) {
  if (!input && !output) return;
  const u = loadUsage();
  const key = `${provider}/${model}`;
  const cur = u.byKey[key] || { provider, model, input: 0, output: 0 };
  cur.input += input || 0;
  cur.output += output || 0;
  u.byKey[key] = cur;
  save(u);
}

export function resetUsage() {
  save({ byKey: {} });
}

/**
 * Summary for the Settings panel. Computes lifetime totals, per-model rows with
 * cost, total actual cost, and estimated savings vs the reference model
 * (what the same tokens WOULD have cost on that model, minus what they did).
 */
export function summarizeUsage(referenceModel) {
  const u = loadUsage();
  const rows = Object.values(u.byKey).map((r) => ({
    ...r,
    total: r.input + r.output,
    cost: costOf(r.input, r.output, r.model)
  })).sort((a, b) => b.total - a.total);

  const input = rows.reduce((s, r) => s + r.input, 0);
  const output = rows.reduce((s, r) => s + r.output, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  // savings = cost if every token had gone through the reference model − actual
  const refCost = costOf(input, output, referenceModel);
  return {
    input, output, total: input + output,
    cost, rows,
    referenceModel,
    referenceCost: refCost,
    savings: Math.max(0, refCost - cost)
  };
}
