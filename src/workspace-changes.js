import path from "node:path";

const MAX_CHANGES = 100;
const MAX_DIFF_CHARS = 12000;

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function changeStatus(change = {}) {
  const value = String(change.status || change.kind?.type || change.kind || "modified").toLowerCase();
  if (["add", "added", "created", "create", "untracked"].includes(value)) return "created";
  if (["delete", "deleted", "remove", "removed"].includes(value)) return "deleted";
  return "modified";
}

function safeChange(change, projectDir) {
  const root = path.resolve(String(projectDir || ""));
  const sourcePath = String(change?.path || "").trim();
  if (!projectDir || !sourcePath) return null;
  const absolutePath = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(root, sourcePath);
  if (!insideRoot(root, absolutePath) || absolutePath === root) return null;
  return {
    path: path.relative(root, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    status: changeStatus(change),
    diff: String(change?.diff || "").slice(0, MAX_DIFF_CHARS)
  };
}

export function normalizeWorkspaceChanges(changes = [], projectDir = "") {
  if (!Array.isArray(changes) || !projectDir) return [];
  const rows = new Map();
  for (const change of changes) {
    const row = safeChange(change, projectDir);
    if (row) rows.set(row.path.toLowerCase(), row);
  }
  return [...rows.values()].slice(-MAX_CHANGES);
}

/**
 * Maintain Boolean's own authoritative change ledger. This deliberately does
 * not call Git: verified Codex/Claude edits must remain visible in ordinary
 * folders too. Creating and then deleting the same new file cancels the entry.
 */
export function mergeWorkspaceChanges(current = [], incoming = [], projectDir = "") {
  const rows = new Map(normalizeWorkspaceChanges(current, projectDir).map((row) => [row.path.toLowerCase(), row]));
  for (const change of normalizeWorkspaceChanges(incoming, projectDir)) {
    const key = change.path.toLowerCase();
    const previous = rows.get(key);
    if (change.status === "deleted" && previous?.status === "created") {
      rows.delete(key);
      continue;
    }
    if (change.status === "modified" && previous?.status === "created") {
      rows.set(key, { ...change, status: "created", diff: previous.diff || change.diff });
      continue;
    }
    rows.set(key, change);
  }
  return [...rows.values()].slice(-MAX_CHANGES);
}

export function combineWorkspaceChanges(primary = [], secondary = [], projectDir = "") {
  const rows = new Map();
  for (const change of [...normalizeWorkspaceChanges(secondary, projectDir), ...normalizeWorkspaceChanges(primary, projectDir)]) {
    rows.set(change.path.toLowerCase(), change);
  }
  return [...rows.values()].slice(-MAX_CHANGES);
}

export function workspaceChangeStats(changes = []) {
  const rows = Array.isArray(changes) ? changes : [];
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    for (const line of String(row?.diff || "").split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { files: rows.length, additions, deletions };
}

function reviewLines(diff = "") {
  let oldLine = 0;
  let newLine = 0;
  const lines = [];
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ type: "hunk", text: line, num: "" });
    } else if (line.startsWith("+")) {
      lines.push({ type: "add", text: line.slice(1), num: newLine++ });
    } else if (line.startsWith("-")) {
      lines.push({ type: "del", text: line.slice(1), num: oldLine++ });
    } else if (line.startsWith(" ")) {
      lines.push({ type: "ctx", text: line.slice(1), num: newLine++ });
      oldLine++;
    }
  }
  return lines;
}

export function workspaceChangesReview(changes = []) {
  const rows = Array.isArray(changes) ? changes : [];
  return {
    files: rows.map((row) => ({
      path: row.path,
      absolutePath: row.absolutePath,
      status: row.status,
      diff: String(row.diff || ""),
      lines: reviewLines(row.diff)
    })),
    patch: rows.map((row) => String(row.diff || "")).filter(Boolean).join("\n")
  };
}

export function workspaceChangesReport(changes = []) {
  const rows = Array.isArray(changes) ? changes : [];
  if (!rows.length) return "Boolean Changes: 0 files.";
  const details = rows.slice(0, 12).map((row) => {
    const diff = String(row.diff || "").trim().slice(0, 3000);
    return `- ${row.status}: ${row.absolutePath || row.path}${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ""}`;
  });
  return [`Boolean Changes: ${rows.length} file${rows.length === 1 ? "" : "s"}.`, ...details].join("\n");
}
