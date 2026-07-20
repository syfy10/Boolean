import { spawnSync } from "node:child_process";
import path from "node:path";

function runGit(cwd, args, timeout = 8000) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
  return {
    ok: result.status === 0,
    code: result.status ?? -1,
    out: String(result.stdout || ""),
    err: String(result.stderr || "")
  };
}

export function parseGitDiff(diffText = "") {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(diffText || "").split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2], oldPath: header[1], status: "modified", lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^new file mode\b/.test(line)) current.status = "added";
    else if (/^deleted file mode\b/.test(line)) current.status = "deleted";
    else if (/^rename from\b/.test(line)) current.status = "renamed";
    else if (/^\+\+\+ b\//.test(line)) current.path = line.slice(6);
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ type: "hunk", text: line, num: "" });
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1), num: newLine++ });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", text: line.slice(1), num: oldLine++ });
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "ctx", text: line.slice(1), num: newLine++ });
      oldLine++;
    }
  }
  return files;
}

export function gitDiffFiles(projectDir) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const diff = runGit(cwd, ["diff", "--no-ext-diff", "--"]);
  if (!diff.ok) throw new Error(diff.err || diff.out || "Could not read git diff");
  return parseGitDiff(diff.out);
}

export function gitRestoreFiles(projectDir, files) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const selected = [...new Set((Array.isArray(files) ? files : []).map((file) => String(file || "").trim()).filter(Boolean))];
  if (!selected.length) return { restored: [], skipped: [], message: "No files selected." };
  const status = runGit(cwd, ["status", "--porcelain=v1", "--", ...selected]);
  if (!status.ok) throw new Error(status.err || status.out || "Could not inspect selected files");
  const tracked = new Set();
  const skipped = [];
  for (const line of status.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const state = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    if (state.includes("?")) skipped.push(file);
    else tracked.add(file);
  }
  const restored = [...tracked];
  if (restored.length) {
    const result = runGit(cwd, ["restore", "--", ...restored], 20000);
    if (!result.ok) throw new Error(result.err || result.out || "Could not restore selected files");
  }
  return { restored, skipped };
}

