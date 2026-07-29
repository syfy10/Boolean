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
  assert.match(review.patch, /tracked\.txt/);
});
