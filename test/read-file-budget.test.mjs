import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";

test("large read_file calls return a compact preview instead of full contents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-read-budget-"));
  const file = path.join(root, "ui.html");
  const lines = Array.from({ length: 420 }, (_, i) =>
    i === 260 ? "function targetBug() { return true; }" : `<div>line ${i + 1}</div>`
  );
  fs.writeFileSync(file, lines.join("\n"));
  const ctx = { config: { projectsDir: root, commandTimeoutMs: 1000 }, approve: async () => true };

  const full = await executeTool("read_file", { path: file }, ctx);
  assert.match(full, /Large file preview/);
  assert.match(full, /Boolean did not return the full file/);
  assert.match(full, /read_file with offset and limit/);
  assert.doesNotMatch(full, /line 420/);

  const slice = await executeTool("read_file", { path: file, offset: 258, limit: 8 }, ctx);
  assert.match(slice, /\[lines 258-265 of 420\]/);
  assert.match(slice, /function targetBug/);
});

test("read_file caps oversized slices", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-read-slice-"));
  const file = path.join(root, "big.js");
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n"));
  const ctx = { config: { projectsDir: root, commandTimeoutMs: 1000 }, approve: async () => true };

  const result = await executeTool("read_file", { path: file, offset: 1, limit: 500 }, ctx);
  assert.match(result, /\[lines 1-220 of 500\]/);
  assert.match(result, /requested 500 lines; capped at 220/);
  assert.doesNotMatch(result, /line500/);
});
