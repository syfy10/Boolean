import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("Code workspace has explorer tabs editor and save status", () => {
  assert.match(ui, /id="codeWorkspace"/);
  assert.match(ui, /id="codeTree"/);
  assert.match(ui, /id="codeTabs"/);
  assert.match(ui, /id="codeEditor"/);
  assert.match(ui, /id="codeSave"/);
  assert.match(ui, /body\.code-open \.code-workspace\{ display:grid/);
  assert.match(ui, /body\.code-open #chat\{ display:none; \}/);
});

test("Code workspace binds files to the active project and saves conflicts safely", () => {
  assert.match(ui, /fetch\(`\/api\/workspace\/tree\?threadId=/);
  assert.match(ui, /fetch\(`\/api\/workspace\/file\?threadId=/);
  assert.match(ui, /method:"PUT"/);
  assert.match(ui, /expectedMtimeMs:file\.mtimeMs/);
  assert.match(ui, /expectedHash:file\.hash/);
  assert.match(ui, /event\.key\.toLowerCase\(\)==="s"/);
  assert.match(ui, /Discard unsaved changes/);
  assert.match(ui, /boolean\.code\.tabs\./);
});
