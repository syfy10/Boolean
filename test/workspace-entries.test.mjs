import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  renameWorkspaceEntry
} from "../src/workspace-files.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-entries-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const ready = true;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  return root;
}

test("creating an entry makes files and folders inside the project", () => {
  const root = fixture();
  try {
    const file = createWorkspaceEntry(root, "src/lib/util.js", { content: "export const x = 1;\n" });
    assert.equal(file.path, "src/lib/util.js");
    assert.equal(fs.readFileSync(path.join(root, "src", "lib", "util.js"), "utf8"), "export const x = 1;\n");
    assert.equal(typeof file.hash, "string");

    // missing parent folders are created on the way
    const nested = createWorkspaceEntry(root, "docs/guide/intro.md");
    assert.equal(nested.path, "docs/guide/intro.md");
    assert.ok(fs.existsSync(path.join(root, "docs", "guide", "intro.md")));

    const folder = createWorkspaceEntry(root, "assets", { type: "directory" });
    assert.equal(folder.type, "directory");
    assert.ok(fs.statSync(path.join(root, "assets")).isDirectory());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("creating an entry never overwrites or escapes the project", () => {
  const root = fixture();
  try {
    assert.throws(() => createWorkspaceEntry(root, "README.md"), { code: "WORKSPACE_ENTRY_EXISTS" });
    assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# Demo\n");
    assert.throws(() => createWorkspaceEntry(root, "../escape.js"), { code: "WORKSPACE_NAME_INVALID" });
    assert.throws(() => createWorkspaceEntry(root, "src/../../escape.js"), { code: "WORKSPACE_NAME_INVALID" });
    assert.throws(() => createWorkspaceEntry(root, ""), { code: "WORKSPACE_FILE_REQUIRED" });
    for (const bad of ["what?.js", "a<b.js", "pipe|name.js", "star*.js", "trailing.", "con", "COM1.txt"]) {
      assert.throws(() => createWorkspaceEntry(root, bad), { code: "WORKSPACE_NAME_INVALID" }, `expected ${bad} to be refused`);
    }
    // ordinary names with spaces and dashes still work
    assert.equal(createWorkspaceEntry(root, "my notes-2.md").path, "my notes-2.md");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("renaming moves files and folders and refuses unsafe targets", () => {
  const root = fixture();
  try {
    const moved = renameWorkspaceEntry(root, "src/app.js", "src/main.js");
    assert.equal(moved.path, "src/main.js");
    assert.equal(moved.from, "src/app.js");
    assert.ok(!fs.existsSync(path.join(root, "src", "app.js")));

    const folder = renameWorkspaceEntry(root, "src/lib", "src/shared");
    assert.equal(folder.type, "directory");
    assert.ok(fs.statSync(path.join(root, "src", "shared")).isDirectory());

    assert.throws(() => renameWorkspaceEntry(root, "src/main.js", "README.md"), { code: "WORKSPACE_ENTRY_EXISTS" });
    assert.throws(() => renameWorkspaceEntry(root, "src/missing.js", "src/other.js"), { code: "WORKSPACE_ENTRY_MISSING" });
    assert.throws(() => renameWorkspaceEntry(root, "", "anything.js"), { code: "WORKSPACE_ROOT_PROTECTED" });
    assert.throws(() => renameWorkspaceEntry(root, "src/main.js", "../escaped.js"), { code: "WORKSPACE_NAME_INVALID" });
    assert.throws(() => renameWorkspaceEntry(root, "src", "src/nested"), { code: "WORKSPACE_NAME_INVALID" });
    // the refused moves left the tree untouched
    assert.ok(fs.existsSync(path.join(root, "src", "main.js")));
    assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# Demo\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("deleting removes an entry but never the project root", () => {
  const root = fixture();
  try {
    assert.deepEqual(deleteWorkspaceEntry(root, "README.md"), { path: "README.md", type: "file" });
    assert.ok(!fs.existsSync(path.join(root, "README.md")));

    assert.equal(deleteWorkspaceEntry(root, "src").type, "directory");
    assert.ok(!fs.existsSync(path.join(root, "src")));

    assert.throws(() => deleteWorkspaceEntry(root, ""), { code: "WORKSPACE_ROOT_PROTECTED" });
    assert.throws(() => deleteWorkspaceEntry(root, "."), { code: "WORKSPACE_ROOT_PROTECTED" });
    assert.throws(() => deleteWorkspaceEntry(root, "../"), { code: "WORKSPACE_BOUNDARY" });
    assert.throws(() => deleteWorkspaceEntry(root, "gone.txt"), { code: "WORKSPACE_ENTRY_MISSING" });
    assert.ok(fs.statSync(root).isDirectory());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("entry routes are guarded and mapped to honest status codes", () => {
  assert.match(server, /createWorkspaceEntry, renameWorkspaceEntry, deleteWorkspaceEntry/);
  assert.match(server, /req\.method === "POST" && p === "\/api\/workspace\/entry"/);
  assert.match(server, /req\.method === "PATCH" && p === "\/api\/workspace\/entry"/);
  assert.match(server, /req\.method === "DELETE" && p === "\/api\/workspace\/entry"/);
  // the global CSRF guard only covers POST, so these routes check the header
  assert.match(server, /req\.method !== "GET" && req\.headers\["x-saz"\] !== "1"/);
  assert.match(server, /WORKSPACE_ENTRY_EXISTS" \? 409/);
  assert.match(server, /WORKSPACE_ENTRY_MISSING" \? 404/);
  assert.match(server, /invalidateProjectStatus\(workspaceThread\.projectDir\);\s*\n\s*return json\(\{ ok: true, threadId: workspaceThread\.id, \.\.\.created \}\)/);
});

test("the Explorer offers create, rename, and delete", () => {
  assert.match(ui, /id="codeNewFile"/);
  assert.match(ui, /id="codeNewFolder"/);
  assert.match(ui, /id="codeMenu"/);
  assert.match(ui, /row\.oncontextmenu=event=>codeOpenMenu\(event,entry\.path,entry\.type\)/);
  assert.match(ui, /add\("Rename",\(\)=>codeRenameEntry\(entryPath,entryType\)\)/);
  assert.match(ui, /add\("Delete",\(\)=>codeDeleteEntry\(entryPath,entryType\),true\)/);
  assert.match(ui, /method,headers:\{"content-type":"application\/json","x-saz":"1"\}/);
});

test("open tabs follow renames and deletions", () => {
  assert.match(ui, /function codeRetargetOpenFiles\(fromPath,toPath,entryType\)/);
  assert.match(ui, /function codeForgetFile\(openPath\)/);
  assert.match(ui, /function codePathAffected\(openPath,entryPath,entryType\)/);
  // a deleted folder closes every tab beneath it, not just an exact match
  assert.match(ui, /openPath===entryPath\|\|openPath\.startsWith\(entryPath\+"\/"\)/);
  // deleting warns once, and warns harder when the buffer is dirty
  assert.match(ui, /It has unsaved changes open in Code/);
  assert.match(ui, /Delete the folder \$\{entryPath\} and everything in it\?/);
});
