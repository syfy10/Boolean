import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listWorkspaceTree,
  readWorkspaceFile,
  resolveWorkspacePath,
  writeWorkspaceFile
} from "../src/workspace-files.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-workspace-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const ready = true;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(root, "node_modules", "hidden.js"), "hidden");
  return root;
}

test("workspace paths stay inside the selected project", () => {
  const root = fixture();
  try {
    assert.equal(resolveWorkspacePath(root, "src/app.js").relative, "src/app.js");
    assert.throws(() => resolveWorkspacePath(root, "../outside.txt"), { code: "WORKSPACE_BOUNDARY" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace tree is sorted, bounded, and skips generated directories", () => {
  const root = fixture();
  try {
    const tree = listWorkspaceTree(root);
    assert.deepEqual(tree.entries.map((entry) => entry.name), ["src", "README.md"]);
    assert.equal(tree.entries[0].children[0].path, "src/app.js");
    assert.equal(tree.entries.some((entry) => entry.name === "node_modules"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace tree skips Claude repository mirrors without hiding Claude settings", () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, ".claude", "worktrees", "copy", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}\n");
    fs.writeFileSync(path.join(root, ".claude", "worktrees", "copy", "src", "duplicate.js"), "duplicate\n");
    const tree = listWorkspaceTree(root);
    const claude = tree.entries.find((entry) => entry.name === ".claude");
    assert.ok(claude);
    assert.deepEqual(claude.children.map((entry) => entry.name), ["settings.json"]);
    assert.ok(tree.entries.some((entry) => entry.name === "src"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace files save atomically and reject stale editor contents", () => {
  const root = fixture();
  try {
    const opened = readWorkspaceFile(root, "src/app.js");
    const saved = writeWorkspaceFile(root, "src/app.js", "export const ready = false;\n", { expectedMtimeMs: opened.mtimeMs, expectedHash: opened.hash });
    assert.equal(readWorkspaceFile(root, "src/app.js").content, "export const ready = false;\n");
    assert.throws(
      () => writeWorkspaceFile(root, "src/app.js", "stale", { expectedMtimeMs: opened.mtimeMs, expectedHash: opened.hash }),
      { code: "WORKSPACE_FILE_CONFLICT" }
    );
    assert.equal(saved.path, "src/app.js");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace reader rejects binary and oversized files", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(root, "large.txt"), "12345");
    assert.throws(() => readWorkspaceFile(root, "binary.bin"), { code: "WORKSPACE_FILE_BINARY" });
    assert.throws(() => readWorkspaceFile(root, "large.txt", { maxBytes: 4 }), { code: "WORKSPACE_FILE_LARGE" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
