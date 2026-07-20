import assert from "node:assert/strict";
import test from "node:test";

import { parseGitDiff } from "../src/git-review.js";

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

