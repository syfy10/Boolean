import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_IGNORES = new Set([
  ".git", ".idea", ".next", ".nuxt", ".svelte-kit", ".turbo", ".venv",
  "bin", "build", "coverage", "dist", "node_modules", "obj", "out", "target"
]);

function ignoredWorkspaceEntry(base, full, name) {
  if (name === ".DS_Store" || DEFAULT_IGNORES.has(name)) return true;
  // Claude and other coding tools may keep complete repository mirrors here.
  // Showing them duplicates every file and can exhaust the bounded Explorer
  // before the actual project source is reached.
  const relative = path.relative(base, full).replace(/\\/g, "/").toLowerCase();
  return relative === ".claude/worktrees" || relative.startsWith(".claude/worktrees/");
}

function workspaceRoot(root) {
  const resolved = path.resolve(String(root || ""));
  if (!root || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error("The active project folder is unavailable."), { code: "WORKSPACE_UNAVAILABLE" });
  }
  return resolved;
}

export function resolveWorkspacePath(root, relativePath = "") {
  const base = workspaceRoot(root);
  const requested = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(base, requested);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("The requested path is outside the active project."), { code: "WORKSPACE_BOUNDARY" });
  }
  return { root: base, target, relative: relative.replace(/\\/g, "/") };
}

export function listWorkspaceTree(root, { maxDepth = 5, maxEntries = 1200 } = {}) {
  const base = workspaceRoot(root);
  let count = 0;
  let truncated = false;
  const visit = (dir, depth) => {
    if (depth > maxDepth || count >= maxEntries) { truncated = true; return []; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const rows = [];
    for (const entry of entries) {
      if (count >= maxEntries) { truncated = true; break; }
      const full = path.join(dir, entry.name);
      if (ignoredWorkspaceEntry(base, full, entry.name)) continue;
      const relative = path.relative(base, full).replace(/\\/g, "/");
      count++;
      if (entry.isDirectory()) rows.push({ name: entry.name, path: relative, type: "directory", children: visit(full, depth + 1) });
      else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* keep unavailable entries visible */ }
        rows.push({ name: entry.name, path: relative, type: "file", size });
      }
    }
    return rows;
  };
  return { root: base, entries: visit(base, 0), count, truncated };
}

// A flat walk for search. The tree view is depth-bounded for display; search
// needs to reach deeper, so it is bounded by file count instead and skips the
// same generated folders.
function walkWorkspaceFiles(base, { maxDepth = 12, maxFiles = 8000 } = {}) {
  const files = [];
  let truncated = false;
  const visit = (dir, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (ignoredWorkspaceEntry(base, full, entry.name)) continue;
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile()) files.push(path.relative(base, full).replace(/\\/g, "/"));
    }
  };
  visit(base, 0);
  return { files, truncated };
}

// Subsequence match, the way an editor's file palette works: "srvjs" finds
// "src/server.js". Scores contiguous runs and matches right after a separator
// higher, so the closest thing to what was typed sorts first.
function subsequenceScore(haystack, needle) {
  let score = 0;
  let cursor = 0;
  let previousIndex = -1;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, cursor);
    if (found === -1) return -1;
    score += 1;
    if (found === previousIndex + 1) score += 4;
    if (found === 0 || "/-_. ".includes(haystack[found - 1])) score += 3;
    previousIndex = found;
    cursor = found + 1;
  }
  return score;
}

export function scoreFuzzyPath(relativePath, query) {
  const target = String(relativePath || "");
  const needle = String(query || "").toLowerCase().replace(/\s+/g, "");
  if (!needle) return 0;
  const haystack = target.toLowerCase();
  const pathScore = subsequenceScore(haystack, needle);
  if (pathScore < 0) return -1;
  const name = haystack.slice(haystack.lastIndexOf("/") + 1);
  let score = pathScore;
  // what you type is usually part of a file name, not of the folders above it
  if (subsequenceScore(name, needle) >= 0) score += 12;
  if (name.includes(needle)) score += 8;
  return score - Math.floor(target.length / 40);
}

export function findWorkspaceFiles(root, query, { limit = 40 } = {}) {
  const base = workspaceRoot(root);
  const { files, truncated } = walkWorkspaceFiles(base);
  const text = String(query || "").trim();
  const ranked = (text
    ? files.map((file) => ({ path: file, score: scoreFuzzyPath(file, text) })).filter((hit) => hit.score >= 0)
    : files.map((file) => ({ path: file, score: 0 })))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return { query: text, total: ranked.length, truncated, matches: ranked.slice(0, limit) };
}

export function searchWorkspaceText(root, query, { limit = 200, maxFileBytes = 2_000_000, caseSensitive = false, perFile = 20 } = {}) {
  const base = workspaceRoot(root);
  const needle = String(query || "");
  if (needle.trim().length < 2) {
    throw Object.assign(new Error("Search for at least two characters."), { code: "WORKSPACE_QUERY_SHORT" });
  }
  const compare = caseSensitive ? needle : needle.toLowerCase();
  const { files, truncated: walkTruncated } = walkWorkspaceFiles(base);
  const matches = [];
  let filesSearched = 0;
  let truncated = walkTruncated;
  for (const relative of files) {
    if (matches.length >= limit) { truncated = true; break; }
    const full = path.join(base, relative);
    let buffer;
    try {
      if (fs.statSync(full).size > maxFileBytes) continue;
      buffer = fs.readFileSync(full);
    } catch { continue; }
    if (buffer.includes(0)) continue;
    filesSearched++;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    let hitsHere = 0;
    for (let i = 0; i < lines.length && hitsHere < perFile && matches.length < limit; i++) {
      const line = lines[i];
      const column = (caseSensitive ? line : line.toLowerCase()).indexOf(compare);
      if (column === -1) continue;
      hitsHere++;
      matches.push({ path: relative, line: i + 1, column: column + 1, text: line.trim().slice(0, 200) });
    }
  }
  return { query: needle, filesSearched, total: matches.length, truncated, matches };
}

export function findWorkspaceSymbols(root, query, { limit = 100, maxFileBytes = 1_000_000 } = {}) {
  const base = workspaceRoot(root);
  const needle = String(query || "").trim().toLowerCase();
  const { files, truncated: walkTruncated } = walkWorkspaceFiles(base);
  const matches = [];
  let filesSearched = 0, truncated = walkTruncated;
  const patterns = [
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "type", regex: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]?/ },
    { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/ }
  ];
  for (const relative of files) {
    if (matches.length >= limit) { truncated = true; break; }
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|php)$/i.test(relative)) continue;
    const full = path.join(base, relative);
    let buffer;
    try { if (fs.statSync(full).size > maxFileBytes) continue;buffer = fs.readFileSync(full); } catch { continue; }
    if (buffer.includes(0)) continue;filesSearched++;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      for (const pattern of patterns) {
        const hit = lines[i].match(pattern.regex);if (!hit) continue;
        const name = hit[1];if (needle && !name.toLowerCase().includes(needle)) break;
        matches.push({ name, kind: pattern.kind, path: relative, line: i + 1, column: lines[i].indexOf(name) + 1 });break;
      }
    }
  }
  matches.sort((a, b) => (a.name.toLowerCase() === needle ? -1 : 0) - (b.name.toLowerCase() === needle ? -1 : 0) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { query: String(query || ""), filesSearched, total: matches.length, truncated, matches };
}

export function readWorkspaceFile(root, relativePath, { maxBytes = 2_000_000 } = {}) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.relative) throw Object.assign(new Error("Choose a file inside the project."), { code: "WORKSPACE_FILE_REQUIRED" });
  const stat = fs.statSync(resolved.target);
  if (!stat.isFile()) throw Object.assign(new Error("The requested path is not a file."), { code: "WORKSPACE_FILE_REQUIRED" });
  if (stat.size > maxBytes) throw Object.assign(new Error("This file is too large to open in Code."), { code: "WORKSPACE_FILE_LARGE" });
  const buffer = fs.readFileSync(resolved.target);
  if (buffer.includes(0)) throw Object.assign(new Error("Binary files cannot be edited in Code yet."), { code: "WORKSPACE_FILE_BINARY" });
  return { path: resolved.relative, content: buffer.toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs, hash: crypto.createHash("sha256").update(buffer).digest("hex") };
}

// A name the Explorer is willing to create or rename to. Path separators are
// allowed so "src/lib/util.js" creates its folders, but nothing may look like
// a traversal step or a Windows device name.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function assertUsableName(relativePath) {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) throw Object.assign(new Error("Name this file before creating it."), { code: "WORKSPACE_FILE_REQUIRED" });
  for (const part of parts) {
    if (part === "." || part === "..") throw Object.assign(new Error("That name is not allowed."), { code: "WORKSPACE_NAME_INVALID" });
    if (/[<>:"|?*]/.test(part) || [...part].some((ch) => ch.codePointAt(0) < 32) || /[ .]$/.test(part) || RESERVED_NAMES.test(part)) {
      throw Object.assign(new Error(`"${part}" is not a usable file name on Windows.`), { code: "WORKSPACE_NAME_INVALID" });
    }
  }
  return parts.join("/");
}

export function createWorkspaceEntry(root, relativePath, { type = "file", content = "" } = {}) {
  const resolved = resolveWorkspacePath(root, assertUsableName(relativePath));
  if (fs.existsSync(resolved.target)) {
    throw Object.assign(new Error("Something with that name already exists."), { code: "WORKSPACE_ENTRY_EXISTS" });
  }
  if (type === "directory") {
    fs.mkdirSync(resolved.target, { recursive: true });
    return { path: resolved.relative, type: "directory" };
  }
  fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
  const text = String(content ?? "");
  // wx so two racing creates cannot silently clobber each other
  fs.writeFileSync(resolved.target, text, { encoding: "utf8", flag: "wx" });
  const stat = fs.statSync(resolved.target);
  return {
    path: resolved.relative, type: "file", size: stat.size, mtimeMs: stat.mtimeMs,
    hash: crypto.createHash("sha256").update(text).digest("hex")
  };
}

export function renameWorkspaceEntry(root, fromPath, toPath) {
  const from = resolveWorkspacePath(root, fromPath);
  if (!from.relative) throw Object.assign(new Error("The project folder itself cannot be renamed here."), { code: "WORKSPACE_ROOT_PROTECTED" });
  if (!fs.existsSync(from.target)) throw Object.assign(new Error("That file no longer exists."), { code: "WORKSPACE_ENTRY_MISSING" });
  const to = resolveWorkspacePath(root, assertUsableName(toPath));
  if (to.relative === from.relative) return { path: from.relative, from: from.relative, type: fs.statSync(from.target).isDirectory() ? "directory" : "file" };
  if (fs.existsSync(to.target)) throw Object.assign(new Error("Something with that name already exists."), { code: "WORKSPACE_ENTRY_EXISTS" });
  const isDirectory = fs.statSync(from.target).isDirectory();
  // moving a folder inside itself would delete the tree being moved
  if (isDirectory && (to.relative + "/").startsWith(from.relative + "/")) {
    throw Object.assign(new Error("A folder cannot be moved inside itself."), { code: "WORKSPACE_NAME_INVALID" });
  }
  fs.mkdirSync(path.dirname(to.target), { recursive: true });
  fs.renameSync(from.target, to.target);
  return { path: to.relative, from: from.relative, type: isDirectory ? "directory" : "file" };
}

export function deleteWorkspaceEntry(root, relativePath) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.relative) throw Object.assign(new Error("The project folder itself cannot be deleted here."), { code: "WORKSPACE_ROOT_PROTECTED" });
  if (!fs.existsSync(resolved.target)) throw Object.assign(new Error("That file no longer exists."), { code: "WORKSPACE_ENTRY_MISSING" });
  const isDirectory = fs.statSync(resolved.target).isDirectory();
  fs.rmSync(resolved.target, { recursive: isDirectory, force: false });
  return { path: resolved.relative, type: isDirectory ? "directory" : "file" };
}

export function writeWorkspaceFile(root, relativePath, content, { expectedMtimeMs, expectedHash } = {}) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.relative) throw Object.assign(new Error("Choose a file inside the project."), { code: "WORKSPACE_FILE_REQUIRED" });
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > 2_000_000) throw Object.assign(new Error("This file is too large to save in Code."), { code: "WORKSPACE_FILE_LARGE" });
  if (fs.existsSync(resolved.target)) {
    const stat = fs.statSync(resolved.target);
    if (!stat.isFile()) throw Object.assign(new Error("The requested path is not a file."), { code: "WORKSPACE_FILE_REQUIRED" });
    const currentHash = expectedHash ? crypto.createHash("sha256").update(fs.readFileSync(resolved.target)).digest("hex") : "";
    if ((expectedHash && currentHash !== expectedHash) || (expectedMtimeMs != null && Math.abs(stat.mtimeMs - Number(expectedMtimeMs)) > 1)) {
      throw Object.assign(new Error("This file changed on disk. Reopen it before saving."), { code: "WORKSPACE_FILE_CONFLICT" });
    }
  } else {
    fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
  }
  const temp = `${resolved.target}.boolean-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, resolved.target);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
  }
  const stat = fs.statSync(resolved.target);
  return { path: resolved.relative, size: stat.size, mtimeMs: stat.mtimeMs, hash: crypto.createHash("sha256").update(text).digest("hex") };
}
