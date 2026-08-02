import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { gitDiffFiles, parseGitDiff } from "../src/git-review.js";

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

test("gitDiffFiles includes untracked files without treating them as restorable tracked edits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-git-review-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Boolean Test");
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

test("Changes exposes an exact new-file diff and returns to zero after that file is deleted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-codex-change-cycle-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Boolean Test");
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
