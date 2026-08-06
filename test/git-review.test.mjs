import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { gitCommit, gitCreateBranch, gitDiffFiles, gitFileContents, gitPushBranch, gitSourceStatus, gitStageFiles, githubCreatePullRequest, parseGitDiff } from "../src/git-review.js";

test("parseGitDiff groups changed lines by file", () => {
  const files = parseGitDiff(`diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,2 +1,3 @@
 const a = 1;
-console.log(a);
+console.log(a + 1);
+console.log("done");
diff --git a/src/new.js b/src/new.js
new file mode 100644
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1 @@
+export const ok = true;`);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/app.js");
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].lines.some((line) => line.type === "del"), true);
  assert.equal(files[0].lines.some((line) => line.type === "add"), true);
  assert.equal(files[1].status, "added");
});

test("branch creation is local and remote mutations require exact confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-git-workflow-"));
  spawnSync("git", ["init"], { cwd: root });spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "readme.md"), "ok\n");spawnSync("git", ["add", "."], { cwd: root });spawnSync("git", ["commit", "-m", "initial"], { cwd: root });
  assert.equal(gitCreateBranch(root, "codex/test").branch, "codex/test");
  assert.throws(() => gitPushBranch(root), /confirmation/i);
  assert.throws(() => githubCreatePullRequest(root, { title: "Test" }), /confirmation/i);
});

test("gitDiffFiles includes untracked files without treating them as restorable tracked edits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-git-review-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Boollm Test");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "old\n");
  git("add", "tracked.txt");
  git("commit", "-m", "initial");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "new\n");
  fs.writeFileSync(path.join(dir, "fresh.txt"), "hello\n");

  const review = gitDiffFiles(dir);
  assert.equal(review.staged, false);
  assert.equal(review.files.some((file) => file.path === "tracked.txt" && file.status === "modified"), true);
  assert.equal(review.files.some((file) => file.path === "fresh.txt" && file.status === "untracked"), true);
  const fresh = review.files.find((file) => file.path === "fresh.txt");
  assert.equal(path.resolve(fresh.absolutePath), path.resolve(dir, "fresh.txt"));
  assert.equal(fresh.lines.some((line) => line.type === "add" && line.text === "hello"), true);
  assert.match(review.patch, /tracked\.txt/);
});

test("untracked binary files never put null bytes in verified change lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-git-binary-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init");
    fs.writeFileSync(path.join(dir, "document.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41]));
    const row = gitDiffFiles(dir).files.find((file) => file.path === "document.docx");
    assert.equal(row.status, "untracked");
    assert.equal(row.lines.some((line) => String(line.text).includes("\0")), false);
    assert.match(row.lines[0].text, /binary/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Changes exposes an exact new-file diff and returns to zero after that file is deleted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-change-cycle-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Boollm Test");
    fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
    git("add", "baseline.txt");
    git("commit", "-m", "initial");
    const target = path.join(dir, "codex-edit-test.txt");
    fs.writeFileSync(target, "Codex verified this file.\n");
    const created = gitDiffFiles(dir);
    assert.equal(created.files.length, 1);
    assert.equal(created.files[0].path, "codex-edit-test.txt");
    assert.equal(path.resolve(created.files[0].absolutePath), path.resolve(target));
    assert.equal(created.files[0].lines.some((line) => line.type === "add" && line.text === "Codex verified this file."), true);
    fs.rmSync(target);
    const removed = gitDiffFiles(dir);
    assert.equal(removed.files.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source control status stages unstages and commits selected files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-source-control-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Boollm Test");
    fs.writeFileSync(path.join(dir, "app.js"), "export const value = 1;\n");
    gitStageFiles(dir, ["app.js"]);
    assert.deepEqual(gitSourceStatus(dir).staged.map((row) => row.path), ["app.js"]);
    gitStageFiles(dir, ["app.js"], { unstage: true });
    assert.deepEqual(gitSourceStatus(dir).unstaged.map((row) => row.path), ["app.js"]);
    gitStageFiles(dir, ["app.js"]);
    const committed = gitCommit(dir, "Add app module");
    assert.match(committed.hash, /^[0-9a-f]+$/);
    assert.equal(gitSourceStatus(dir).files.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("side-by-side diff content reads HEAD index and working tree separately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-side-diff-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init");git("config", "user.email", "test@example.com");git("config", "user.name", "Boollm Test");
    fs.writeFileSync(path.join(dir, "app.js"), "const value = 1;\n");git("add", "app.js");git("commit", "-m", "initial");
    fs.writeFileSync(path.join(dir, "app.js"), "const value = 2;\n");git("add", "app.js");
    fs.writeFileSync(path.join(dir, "app.js"), "const value = 3;\n");
    assert.equal(gitFileContents(dir, "app.js", { staged: true }).modified, "const value = 2;\n");
    assert.equal(gitFileContents(dir, "app.js").modified, "const value = 3;\n");
    assert.equal(gitFileContents(dir, "app.js").original, "const value = 1;\n");
    assert.throws(() => gitFileContents(dir, "../outside.js"), /outside/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
