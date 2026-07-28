import fs from "node:fs";
import path from "node:path";
import { SAZ_DIR } from "./config.js";

const PREF_FILE = path.join(SAZ_DIR, "preferences.json");

function stripAppContext(text) {
  return String(text || "").replace(/\n\n<LOCAL_CONTEXT>[\s\S]*?<\/LOCAL_CONTEXT>\s*$/i, "").trim();
}

function loadPreferences() {
  try {
    return { rules: [], ...JSON.parse(fs.readFileSync(PREF_FILE, "utf8")) };
  } catch {
    return { rules: [] };
  }
}

function savePreferences(prefs) {
  fs.mkdirSync(SAZ_DIR, { recursive: true });
  fs.writeFileSync(PREF_FILE, JSON.stringify(prefs, null, 2));
}

export function recordResponseFeedback({ rating, reason = "", response = "", provider = "", model = "" } = {}) {
  const value = rating === "up" ? "up" : rating === "down" ? "down" : "";
  if (!value) return false;
  const prefs = loadPreferences();
  prefs.feedback = Array.isArray(prefs.feedback) ? prefs.feedback : [];
  prefs.feedback.unshift({
    id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rating: value,
    reason: String(reason || "").replace(/\s+/g, " ").trim().slice(0, 600),
    response: String(response || "").trim().slice(0, 2000),
    provider: String(provider || "").slice(0, 80),
    model: String(model || "").slice(0, 160),
    createdAt: Date.now()
  });
  prefs.feedback = prefs.feedback.slice(0, 200);

  const note = String(reason || "").toLowerCase();
  if (value === "down" && /\b(too long|shorter|brief|concise)\b/.test(note)) {
    upsertRule(prefs, "response.short", "Keep answers short by default unless the user asks for more detail.", reason);
  } else if (value === "down" && /\b(too short|more detail|explain more)\b/.test(note)) {
    upsertRule(prefs, "response.detailed", "Include more explanation and supporting detail by default.", reason);
  } else if (value === "down" && /\b(wrong tone|tone|formal|casual)\b/.test(note)) {
    upsertRule(prefs, "response.tone", `Adjust response tone using this local feedback: ${String(reason).trim().slice(0, 300)}`, reason);
  } else if (value === "down" && /\b(incorrect|wrong answer|correction|should have)\b/.test(note)) {
    upsertRule(prefs, `correction.${Date.now()}`, `Use this explicit user correction when relevant: ${String(reason).trim().slice(0, 400)}`, reason);
  }
  prefs.rules = (prefs.rules || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);
  savePreferences(prefs);
  return true;
}

function upsertRule(prefs, id, text, evidence = "") {
  const now = Date.now();
  let rule = prefs.rules.find((r) => r.id === id);
  if (!rule) {
    rule = { id, text, evidence, hits: 0, createdAt: now, updatedAt: now };
    prefs.rules.push(rule);
  }
  rule.text = text;
  if (evidence) rule.evidence = evidence;
  rule.hits = (rule.hits || 0) + 1;
  rule.updatedAt = now;
  return rule;
}

function extractExample(text) {
  const raw = stripAppContext(text);
  const afterBlank = raw.split(/\n\s*\n/).slice(1).join("\n\n").trim();
  const example = afterBlank || raw;
  return example.length > 1200 ? example.slice(0, 1200) + "\n...[trimmed]" : example;
}

export function learnFromUserText(text) {
  const raw = stripAppContext(text);
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return [];

  const learned = [];
  const prefs = loadPreferences();
  const future = /\b(going forward|from now on|moving forward|next time|for future|in the future|always|please keep|keep)\b/.test(s);

  if (future && /\b(short|shorter|brief|concise|simple|less detail|unless i ask for more|unless asked)\b/.test(s)) {
    learned.push(upsertRule(prefs, "response.short", "Keep answers short by default unless the user asks for more detail."));
  }

  if (future && /\b(example|format|style|recap|summary|template|like this|can do it this|can you do this|do it like this)\b/.test(s)) {
    learned.push(upsertRule(
      prefs,
      "format.recap",
      "When the user asks for a recap or summary, follow the user's saved recap/example format instead of browsing for the example text.",
      extractExample(raw)
    ));
  }

  if (future && /\b(don'?t|do not|stop|avoid)\b/.test(s) && /\b(search|google|browse|browser|web)\b/.test(s)) {
    learned.push(upsertRule(prefs, "browse.askless", "Do not browse/search for pasted examples, drafts, or formatting requests unless the user clearly asks for current web info."));
  }

  if (learned.length) {
    prefs.rules = prefs.rules
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 30);
    savePreferences(prefs);
  }
  return learned;
}

export function publicPreferences() {
  const prefs = loadPreferences();
  return {
    rules: (prefs.rules || [])
      .filter((r) => r && r.text)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((r) => ({
        id: r.id,
        text: r.text,
        evidence: r.evidence || "",
        hits: r.hits || 0,
        updatedAt: r.updatedAt || 0,
        createdAt: r.createdAt || 0
      }))
  };
}

export function deletePreference(id) {
  const prefs = loadPreferences();
  const before = prefs.rules.length;
  prefs.rules = prefs.rules.filter((r) => r.id !== id);
  if (prefs.rules.length !== before) savePreferences(prefs);
  return prefs.rules.length !== before;
}

export function updatePreference(id, text) {
  const cleanId = String(id || "").trim();
  const cleanText = String(text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!cleanId || !cleanText) return false;
  const prefs = loadPreferences();
  const rule = prefs.rules.find((entry) => entry.id === cleanId);
  if (!rule) return false;
  rule.text = cleanText;
  rule.updatedAt = Date.now();
  savePreferences(prefs);
  return true;
}

export function clearPreferences() {
  savePreferences({ rules: [] });
}

export function summarizeLearnedPreferences() {
  const prefs = loadPreferences();
  const active = (prefs.rules || [])
    .filter((r) => r && r.text)
    .sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 8);
  if (!active.length) return "";
  const lines = ["LEARNED USER BEHAVIOR (apply automatically unless the latest user message overrides it):"];
  for (const rule of active) {
    lines.push(`- ${rule.text}`);
    if (rule.id === "format.recap" && rule.evidence) {
      lines.push("  Saved recap/example format:");
      lines.push(rule.evidence.split(/\r?\n/).map((line) => `  > ${line}`).join("\n"));
    }
  }
  lines.push("- Do not learn or auto-execute risky actions: sending emails, purchases, checkout, payments, deleting files, or submitting sensitive forms still require explicit confirmation.");
  return lines.join("\n");
}
