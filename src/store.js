// Persists chat threads to disk so they survive app restarts and crashes
// (workspace recovery). Written atomically after each change when autoSave is on.
import fs from "node:fs";
import path from "node:path";
import { SAZ_DIR } from "./config.js";

const THREADS_FILE = path.join(SAZ_DIR, "threads.json");

export function saveThreads(threads) {
  try {
    fs.mkdirSync(SAZ_DIR, { recursive: true });
    // strip transient fields (abort controllers, live run state)
    const data = threads.map((t) => ({
      id: t.id, title: t.title, messages: t.messages, log: t.log,
      createdAt: t.createdAt, updatedAt: t.updatedAt, pinned: !!t.pinned,
      kind: t.kind === "project" ? "project" : "chat",
      projectDir: t.kind === "project" && typeof t.projectDir === "string" ? t.projectDir : ""
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
