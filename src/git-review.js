import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

function cleanPaths(files) {
  return [...new Set((Array.isArray(files) ? files : []).map((file) => String(file || "").trim()).filter(Boolean))];
}

export function gitSourceStatus(projectDir) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const result = runGit(cwd, ["status", "--porcelain=v1", "-b"]);
  if (!result.ok) throw new Error(result.err || result.out || "Could not read Git status");
  const lines = result.out.split(/\r?\n/);
  const head = lines.shift() || "";
  const branch = head.replace(/^##\s+/, "").split("...")[0].trim();
  const files = [];
  for (const line of lines) {
    if (!line) continue;
    const index = line[0] || " ", worktree = line[1] || " ";
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    files.push({ path: filePath, index, worktree, staged: index !== " " && index !== "?", unstaged: worktree !== " " || index === "?" });
  }
  return { branch, files, staged: files.filter((file) => file.staged), unstaged: files.filter((file) => file.unstaged) };
}

export function gitStageFiles(projectDir, files, { unstage = false } = {}) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const selected = cleanPaths(files);
  if (!selected.length) return { files: [], message: "No files selected." };
  // `git reset -- <paths>` also works before the repository has its first
  // commit; `git restore --staged` does not because there is no HEAD yet.
  const args = unstage ? ["reset", "--", ...selected] : ["add", "--", ...selected];
  const result = runGit(cwd, args, 20000);
  if (!result.ok) throw new Error(result.err || result.out || (unstage ? "Could not unstage files" : "Could not stage files"));
  return { files: selected };
}

export function gitCommit(projectDir, message) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const clean = String(message || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 240);
  if (!clean) throw new Error("A commit message is required.");
  const result = runGit(cwd, ["commit", "-m", clean], 30000);
  if (!result.ok) throw new Error(result.err || result.out || "Could not create commit");
  const hash = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return { message: clean, hash: hash.ok ? hash.out.trim() : "", output: result.out.trim() };
}

export function gitCreateBranch(projectDir, name) {
  const cwd = path.resolve(String(projectDir || process.cwd())), branch = String(name || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.includes("//")) throw new Error("Enter a valid branch name.");
  const result = runGit(cwd, ["switch", "-c", branch], 20000);
  if (!result.ok) throw new Error(result.err || result.out || "Could not create branch");
  return { branch };
}

export function gitPushBranch(projectDir, { confirm = "" } = {}) {
  if (confirm !== "push current branch") throw new Error("Push confirmation did not match.");
  const cwd = path.resolve(String(projectDir || process.cwd())), branch = gitSourceStatus(cwd).branch;
  if (!branch || branch === "HEAD") throw new Error("Create or switch to a branch before pushing.");
  const result = runGit(cwd, ["push", "--set-upstream", "origin", branch], 120000);
  if (!result.ok) throw new Error(result.err || result.out || "Could not push branch");
  return { branch, output: String(result.out || result.err).trim() };
}

export function githubCreatePullRequest(projectDir, { title, body = "", draft = true, confirm = "" } = {}) {
  if (confirm !== "create pull request") throw new Error("Pull-request confirmation did not match.");
  const cwd = path.resolve(String(projectDir || process.cwd())), cleanTitle = String(title || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 200);
  if (!cleanTitle) throw new Error("A pull-request title is required.");
  const result = spawnSync("gh", ["pr", "create", "--title", cleanTitle, "--body", String(body || "").replace(/\u0000/g, "").slice(0, 12000), ...(draft ? ["--draft"] : [])], { cwd, encoding: "utf8", timeout: 120000, windowsHide: true });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "Could not create pull request").trim());
  return { url: String(result.stdout || "").trim().split(/\r?\n/).at(-1), title: cleanTitle, draft };
}

export function gitFileContents(projectDir, file, { staged = false } = {}) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const relative = String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(cwd, relative);
  if (!relative || (absolute !== cwd && !absolute.startsWith(`${cwd}${path.sep}`))) throw new Error("File path is outside the project.");
  const readGit = (spec) => {
    const result = runGit(cwd, ["show", spec], 12000);
    return result.ok ? result.out : "";
  };
  const original = readGit(`HEAD:${relative}`);
  let modified = staged ? readGit(`:${relative}`) : "";
  if (!staged) {
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("File is too large for the diff editor.");
      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) throw new Error("Binary files cannot open in the diff editor.");
      modified = buffer.toString("utf8");
    } catch (error) {
      if (fs.existsSync(absolute)) throw error;
      modified = "";
    }
  }
  return { path: relative, original, modified, staged };
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

export function gitDiffFiles(projectDir, options = {}) {
  const cwd = path.resolve(String(projectDir || process.cwd()));
  const staged = options.staged === true;
  const diff = runGit(cwd, ["diff", ...(staged ? ["--staged"] : []), "--no-ext-diff", "--"]);
  if (!diff.ok) throw new Error(diff.err || diff.out || "Could not read git diff");
  const files = parseGitDiff(diff.out);
  if (!staged) {
    const status = runGit(cwd, ["status", "--porcelain=v1"]);
    if (status.ok) {
      const known = new Set(files.map((file) => file.path));
      for (const line of status.out.split(/\r?\n/)) {
        if (!line.startsWith("?? ")) continue;
        const file = line.slice(3).trim();
        if (!file || known.has(file)) continue;
        known.add(file);
        const absolute = path.resolve(cwd, file);
        const inside = absolute === cwd || absolute.startsWith(`${cwd}${path.sep}`);
        let lines = [];
        if (inside) {
          try {
            const stat = fs.statSync(absolute);
            if (stat.isFile() && stat.size <= 1024 * 1024) {
              const buffer = fs.readFileSync(absolute);
              // Office documents, images, executables, and other binary files
              // can contain NUL bytes. Passing decoded binary through the
              // verified-changes prompt makes Node reject the CLI argument
              // before the coding engine even starts.
              if (!buffer.includes(0)) {
                lines = buffer.toString("utf8").split(/\r?\n/).map((text, index) => ({
                  type: "add",
                  num: index + 1,
                  text
                }));
              }
            }
          } catch {}
        }
        files.push({
          path: file,
          status: "untracked",
          absolutePath: inside ? absolute : "",
          lines: lines.length ? lines : [{ type: "ctx", num: "", text: "Untracked binary, large, or directory entry. Accept keeps it; Reject skips it so Boollm does not delete new files unexpectedly." }]
        });
      }
    }
  }
  return { files, patch: diff.out, staged };
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
