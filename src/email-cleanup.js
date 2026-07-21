import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SAZ_DIR } from "./config.js";

const STORE_FILE = path.join(SAZ_DIR, "email-cleanup.json");
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
const SYSTEM_LABELS = new Set([
  "CHAT", "DRAFT", "IMPORTANT", "INBOX", "SENT", "SPAM", "STARRED", "TRASH", "UNREAD",
  "CATEGORY_FORUMS", "CATEGORY_PERSONAL", "CATEGORY_PRIMARY", "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL", "CATEGORY_UPDATES"
]);
const SENSITIVE_RE = /\b(?:account recovery|bank|banking|benefit|credit card|debit card|fraud|health|insurance|invoice|legal|medical|mortgage|password|payment|payroll|receipt|reservation|security alert|statement|tax|ticket|travel|verification code|wire transfer)\b/i;
const BULK_RE = /\b(?:campaign|digest|newsletter|notification|offer|promotion|sale|social update|unsubscribe|weekly update)\b/i;

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { version: 1, plans: Array.isArray(data.plans) ? data.plans : [], runs: Array.isArray(data.runs) ? data.runs : [] };
  } catch {
    return { version: 1, plans: [], runs: [] };
  }
}

function writeStore(data) {
  fs.mkdirSync(SAZ_DIR, { recursive: true });
  const now = Date.now();
  data.plans = (data.plans || []).filter((plan) => now - Number(plan.createdAt || 0) < PLAN_TTL_MS).slice(-20);
  data.runs = (data.runs || []).slice(-50);
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, STORE_FILE);
}

function safeAge(value) {
  const age = String(value || "2y").trim().toLowerCase();
  return /^\d{1,3}[dmy]$/.test(age) ? age : "2y";
}

function cleanCategories(value) {
  const allowed = new Set(["promotions", "social", "updates", "forums", "spam"]);
  const rows = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(rows.map((item) => String(item || "").trim().toLowerCase()).filter((item) => allowed.has(item)))];
}

export function buildGmailCleanupQuery(options = {}) {
  const categories = cleanCategories(options.categories);
  const parts = [];
  const custom = String(options.query || "").replace(/[\r\n]+/g, " ").trim();
  if (custom) parts.push(`(${custom})`);
  parts.push(`older_than:${safeAge(options.olderThan)}`);
  if (categories.length) {
    const terms = categories.map((category) => category === "spam" ? "in:spam" : `category:${category}`);
    parts.push(terms.length === 1 ? terms[0] : `{${terms.join(" ")}}`);
  }
  parts.push("-is:starred", "-label:important", "-in:sent", "-in:drafts", "-in:trash", "-category:primary");
  if (options.protectAttachments !== false) parts.push("-has:attachment");
  return parts.join(" ");
}

function categoryFor(labels, text) {
  if (labels.has("SPAM")) return ["Spam", 0.99];
  if (labels.has("CATEGORY_PROMOTIONS")) return ["Promotions", 0.94];
  if (labels.has("CATEGORY_SOCIAL")) return ["Social", 0.9];
  if (labels.has("CATEGORY_UPDATES")) return ["Updates", 0.82];
  if (labels.has("CATEGORY_FORUMS")) return ["Forums", 0.78];
  if (BULK_RE.test(text)) return ["Newsletter", 0.8];
  return ["Review", 0.45];
}

export function classifyCleanupMessage(row, options = {}) {
  const labels = new Set((row?.labelIds || []).map((label) => String(label).toUpperCase()));
  const userLabels = new Set((options.userLabelIds || []).map(String));
  const text = `${row?.from || ""} ${row?.subject || ""} ${row?.preview || ""}`;
  const protectedReasons = [];
  if (labels.has("STARRED")) protectedReasons.push("starred");
  if (labels.has("IMPORTANT")) protectedReasons.push("marked important");
  if (labels.has("SENT")) protectedReasons.push("sent by you");
  if (labels.has("DRAFT")) protectedReasons.push("draft");
  if (labels.has("CATEGORY_PRIMARY") || labels.has("CATEGORY_PERSONAL")) protectedReasons.push("personal or primary mail");
  if (options.protectAttachments !== false && row?.hasAttachment) protectedReasons.push("has an attachment");
  if (options.protectLabeled !== false && (row?.labelIds || []).some((label) => userLabels.has(String(label)))) protectedReasons.push("saved under a personal label");
  if (SENSITIVE_RE.test(text)) protectedReasons.push("may contain important personal or account information");

  const [category, confidence] = categoryFor(labels, text);
  const minimum = Math.max(0.5, Math.min(0.99, Number(options.minimumConfidence || 0.75)));
  const status = protectedReasons.length ? "protected" : confidence >= minimum ? "candidate" : "review";
  const reasons = [];
  if (status === "candidate") {
    reasons.push(`${category.toLowerCase()} pattern`);
    reasons.push("older than the selected retention period");
    if (!row?.hasAttachment) reasons.push("no attachment detected");
  }
  return {
    id: String(row?.id || ""),
    threadId: String(row?.threadId || ""),
    from: String(row?.from || "").slice(0, 240),
    subject: String(row?.subject || "(no subject)").slice(0, 300),
    date: String(row?.date || "").slice(0, 120),
    labelIds: [...labels],
    hasAttachment: !!row?.hasAttachment,
    category,
    confidence,
    status,
    reasons,
    protectedReasons
  };
}

export function createCleanupPlan({ provider, account, query, options = {}, rows = [], userLabelIds = [] }) {
  const classified = rows.map((row) => classifyCleanupMessage(row, { ...options, userLabelIds }));
  const categories = {};
  for (const item of classified) categories[item.category] = (categories[item.category] || 0) + 1;
  return {
    id: crypto.randomUUID(),
    provider,
    account,
    query,
    options,
    createdAt: Date.now(),
    scanned: classified.length,
    candidates: classified.filter((item) => item.status === "candidate"),
    protected: classified.filter((item) => item.status === "protected"),
    review: classified.filter((item) => item.status === "review"),
    categories,
    processedIds: [],
    trashedIds: []
  };
}

export function saveCleanupPlan(plan) {
  const data = readStore();
  const index = data.plans.findIndex((item) => item.id === plan.id);
  if (index >= 0) data.plans[index] = plan;
  else data.plans.push(plan);
  writeStore(data);
  return plan;
}

export function loadCleanupPlan(id) {
  const plan = readStore().plans.find((item) => item.id === id);
  if (!plan) throw new Error("Cleanup preview expired or was not found. Run the preview again.");
  if (Date.now() - Number(plan.createdAt || 0) >= PLAN_TTL_MS) throw new Error("Cleanup preview expired. Run the preview again before moving mail.");
  return plan;
}

export function publicCleanupPlan(plan) {
  const sample = (items, limit = 12) => items.slice(0, limit).map((item) => ({
    from: item.from,
    subject: item.subject,
    date: item.date,
    category: item.category,
    confidence: item.confidence,
    reasons: item.reasons,
    protectedReasons: item.protectedReasons
  }));
  return {
    planId: plan.id,
    provider: plan.provider,
    account: plan.account,
    query: plan.query,
    scanned: plan.scanned,
    candidateCount: plan.candidates.length,
    protectedCount: plan.protected.length,
    reviewCount: plan.review.length,
    remainingCount: plan.candidates.filter((item) => !(plan.processedIds || []).includes(item.id)).length,
    categories: plan.categories,
    candidateSamples: sample(plan.candidates),
    protectedSamples: sample(plan.protected, 6),
    safety: "Preview only. Nothing was changed. Permanent deletion is not available in Boolean."
  };
}

export function saveCleanupRun(run) {
  const data = readStore();
  const index = data.runs.findIndex((item) => item.id === run.id);
  if (index >= 0) data.runs[index] = run;
  else data.runs.push(run);
  writeStore(data);
  return run;
}

export function loadCleanupRun(id) {
  const run = readStore().runs.find((item) => item.id === id);
  if (!run) throw new Error("Cleanup run was not found.");
  return run;
}

export function newCleanupRun(planId, provider, account, operations, skipped = []) {
  return { id: crypto.randomUUID(), planId, provider, account, createdAt: Date.now(), operations, skipped, undoneAt: 0 };
}

export { SYSTEM_LABELS };
