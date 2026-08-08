import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("Code has an integrated source-control view", () => {
  assert.match(ui, /id="codeSourceToggle"/);
  assert.match(ui, /id="codeSource" aria-label="Source control"/);
  assert.match(ui, /function codeToggleSource\(force\)/);
  assert.match(ui, /function codeRenderSource\(\)/);
});

test("source control stages selected files and commits only the index", () => {
  assert.match(ui, /fetch\("\/api\/git\/stage"/);
  assert.match(ui, /fetch\("\/api\/git\/commit"/);
  assert.match(ui, /Commit .*staged file/);
  assert.match(server, /p === "\/api\/git\/source-status"/);
  assert.match(server, /p === "\/api\/git\/stage"/);
  assert.match(server, /p === "\/api\/git\/commit"/);
});

test("change rows open a Monaco side-by-side diff", () => {
  assert.match(ui, /id="codeDiffEditor" aria-label="Side-by-side diff editor"/);
  assert.match(ui, /function codeOpenGitDiff\(filePath,staged=false\)/);
  assert.match(ui, /createDiffEditor/);
  assert.match(ui, /renderSideBySide:true/);
  assert.match(server, /p === "\/api\/git\/file-diff"/);
});

test("source control includes guarded branch, push, and draft PR workflows", () => {
  assert.match(ui, /id="codeBranch"/);assert.match(ui, /id="codePush"/);assert.match(ui, /id="codePullRequest"/);
  assert.match(ui, /confirm:"push current branch"/);assert.match(ui, /confirm:"create pull request"/);
  assert.match(server, /p === "\/api\/git\/branch"/);assert.match(server, /p === "\/api\/git\/push"/);assert.match(server, /p === "\/api\/github\/pull-request"/);
});
