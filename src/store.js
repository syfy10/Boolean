// Persists chat threads to disk so they survive app restarts and crashes
// (workspace recovery). Written atomically after each change when autoSave is on.
import fs from "node:fs";
import path from "node:path";
import { SAZ_DIR } from "./config.js";

const THREADS_FILE = path.join(SAZ_DIR, "threads.json");
const MEMORY_MAX_CHARS = 5600;
const MEMORY_THREAD_CHARS = 900;
const STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "between", "could", "does",
  "doing", "done", "from", "have", "here", "into", "just", "like", "make", "more", "need",
  "only", "same", "should", "that", "them", "then", "there", "these", "they", "thing", "this",
  "those", "want", "what", "when", "where", "which", "while", "with", "would", "your"
]);

export function saveThreads(threads) {
  try {
    fs.mkdirSync(SAZ_DIR, { recursive: true });
    // strip transient fields (abort controllers, live run state)
    const data = threads.map((t) => ({
      id: t.id, title: t.title, messages: t.messages, log: t.log,
      createdAt: t.createdAt, updatedAt: t.updatedAt, pinned: !!t.pinned,
      kind: t.kind === "project" ? "project" : "chat",
      side: t.side === true,
      projectDir: t.kind === "project" && typeof t.projectDir === "string" ? t.projectDir : "",
      pendingTask: t.pendingTask && typeof t.pendingTask === "object" ? t.pendingTask : null
    }));
    const tmp = THREADS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, threads: data }));
    fs.renameSync(tmp, THREADS_FILE);
  } catch { /* best-effort */ }
}

export function loadThreads() {
  try {
    const data = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

export function clearThreads() {
  try { fs.rmSync(THREADS_FILE, { force: true }); } catch { /* ignore */ }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => String(part.text || ""))
      .join("\n");
  }
  return "";
}

function cleanSnippet(text, max = 260) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function keywords(text) {
  return [...new Set(String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])]
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, 24);
}

function isBlankThread(t) {
  const messages = Array.isArray(t?.messages) ? t.messages : [];
  const hasUser = messages.some((m) => m?.role === "user" && cleanSnippet(textOf(m.content), 12));
  const hasLog = Array.isArray(t?.log) && t.log.some((e) => e?.t === "user" && cleanSnippet(e.text, 12));
  return !hasUser && !hasLog;
}

function threadSearchText(t) {
  const parts = [t?.title || "", t?.projectDir || ""];
  for (const message of (t?.messages || []).slice(-24)) {
    if (message?.role === "system") continue;
    parts.push(textOf(message.content));
  }
  for (const entry of (t?.log || []).slice(-40)) {
    if (entry?.text) parts.push(entry.text);
    if (entry?.summary) parts.push(entry.summary);
  }
  return parts.join("\n").toLowerCase();
}

function threadKindLabel(t) {
  if (t?.side === true) return "side chat";
  if (t?.kind === "project") return "project";
  return "chat";
}

function scoreThread(t, opts, queryTerms) {
  let score = 0;
  if (t?.id && t.id === opts.currentThreadId) score += 80;
  if (opts.projectDir && t?.projectDir && String(t.projectDir).toLowerCase() === String(opts.projectDir).toLowerCase()) score += 35;
  if (t?.side === true) score -= 8;
  const haystack = threadSearchText(t);
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 8;
    if (String(t?.title || "").toLowerCase().includes(term)) score += 8;
  }
  const ageHours = Math.max(0, (Date.now() - Number(t?.updatedAt || 0)) / 36e5);
  score += Math.max(0, 18 - Math.min(18, ageHours / 24));
  return score;
}

function threadTurns(t) {
  const turns = [];
  for (const message of (Array.isArray(t?.messages) ? t.messages : [])) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = cleanSnippet(textOf(message.content), 600);
    if (text) turns.push({ role: message.role === "assistant" ? "AI" : "User", text });
  }
  for (const entry of (Array.isArray(t?.log) ? t.log : [])) {
    if (entry?.t !== "user" && entry?.t !== "ai") continue;
    const text = cleanSnippet(entry.text || entry.content || "", 600);
    if (text) turns.push({ role: entry.t === "ai" ? "AI" : "User", text });
  }
  const seen = new Set();
  return turns.filter((turn) => {
    const key = `${turn.role}:${cleanSnippet(turn.text, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relevantMessages(t, queryTerms) {
  const turns = threadTurns(t);
  const recent = turns.slice(-6);
  const matched = turns.filter((turn) => {
    const text = turn.text.toLowerCase();
    return queryTerms.some((term) => text.includes(term));
  }).slice(-4);
  const seen = new Set();
  return [...matched, ...recent].filter((turn) => {
    const key = `${turn.role}:${cleanSnippet(turn.text, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return cleanSnippet(turn.text, 12);
  }).slice(-8);
}

function summarizeThreadForMemory(t, queryTerms) {
  const title = cleanSnippet(t?.title || "Untitled chat", 70);
  const where = t?.kind === "project" && t?.projectDir ? ` project=${t.projectDir}` : "";
  const pending = t?.pendingTask?.state ? ` pending=${t.pendingTask.state}` : "";
  const lines = [`Thread "${title}" (${threadKindLabel(t)})${where}${pending}:`];
  for (const message of relevantMessages(t, queryTerms)) {
    const role = message.role;
    const snippet = cleanSnippet(message.text, 300);
    if (snippet) lines.push(`- ${role}: ${snippet}`);
  }
  return lines.join("\n").slice(0, MEMORY_THREAD_CHARS);
}

function recentChatIndex(threads, currentThreadId) {
  const items = (Array.isArray(threads) ? threads : [])
    .filter((t) => t && !isBlankThread(t))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 8)
    .map((t) => {
      const active = t.id === currentThreadId ? "active " : "";
      const pending = t.pendingTask?.state ? `, pending ${t.pendingTask.state}` : "";
      const project = t.kind === "project" && t.projectDir ? `, ${path.basename(t.projectDir) || t.projectDir}` : "";
      return `- ${active}${threadKindLabel(t)} "${cleanSnippet(t.title || "Untitled", 54)}"${project}${pending}`;
    });
  return items.length ? ["RECENT SAVED CHATS:", ...items].join("\n") : "";
}

export function buildLocalChatMemory(threads, opts = {}) {
  const latestText = String(opts.latestText || "").trim();
  const queryTerms = keywords(latestText);
  const candidates = (Array.isArray(threads) ? threads : [])
    .filter((t) => t && !isBlankThread(t))
    .map((t) => ({ t, score: scoreThread(t, opts, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.t.updatedAt || 0) - Number(a.t.updatedAt || 0))
    .slice(0, Number(opts.maxThreads || 4));
  if (!candidates.length) return "";
  const blocks = candidates
    .map(({ t }) => summarizeThreadForMemory(t, queryTerms))
    .filter(Boolean);
  if (!blocks.length) return "";
  return [
    "CURRENT THREAD MEMORY:",
    "Saved local chat excerpts from ~/.saz/threads.json. Use them to answer follow-ups about prior chat/project work before saying the history is unavailable.",
    recentChatIndex(threads, opts.currentThreadId),
    ...blocks
  ].filter(Boolean).join("\n\n").slice(0, MEMORY_MAX_CHARS);
}
