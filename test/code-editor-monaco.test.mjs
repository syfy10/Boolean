import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITOR_ASSET_PREFIX, editorAssetDir, resolveEditorAsset } from "../src/editor-assets.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const entry = fs.readFileSync(new URL("../src/editor/monaco.entry.js", import.meta.url), "utf8");
const buildEditor = fs.readFileSync(new URL("../build/build-editor.mjs", import.meta.url), "utf8");
const buildShell = fs.readFileSync(new URL("../build/build-shell.ps1", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("editor assets resolve only flat known types inside the bundle folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-editor-"));
  const resolved = resolveEditorAsset(`${EDITOR_ASSET_PREFIX}editor.js`, dir);
  assert.equal(resolved.file, path.join(dir, "editor.js"));
  assert.equal(resolved.type, "text/javascript; charset=utf-8");
  assert.equal(resolveEditorAsset(`${EDITOR_ASSET_PREFIX}editor.css`, dir).type, "text/css; charset=utf-8");
  assert.match(resolveEditorAsset(`${EDITOR_ASSET_PREFIX}codicon-AB12.ttf`, dir).type, /^font\/ttf$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("editor assets refuse traversal, nesting, and unknown types", () => {
  const dir = path.join(os.tmpdir(), "boolean-editor-guard");
  for (const bad of [
    `${EDITOR_ASSET_PREFIX}..`,
    `${EDITOR_ASSET_PREFIX}../../server.js`,
    `${EDITOR_ASSET_PREFIX}..%2Fserver.js`,
    `${EDITOR_ASSET_PREFIX}nested/editor.js`,
    `${EDITOR_ASSET_PREFIX}editor.json`,
    `${EDITOR_ASSET_PREFIX}`,
    "/assets/other/editor.js",
    "/api/state"
  ]) {
    assert.equal(resolveEditorAsset(bad, dir), null, `expected ${bad} to be refused`);
  }
});

test("the editor bundle folder lives beside the source or the packaged exe", () => {
  const dir = editorAssetDir();
  assert.ok(path.isAbsolute(dir));
  assert.match(dir.replace(/\\/g, "/"), /(src\/assets\/monaco|\/editor)$/);
});

test("the server serves the bundle folder as static assets", () => {
  assert.match(server, /import \{ EDITOR_ASSET_PREFIX, resolveEditorAsset \} from "\.\/editor-assets\.js";/);
  assert.match(server, /p\.startsWith\(EDITOR_ASSET_PREFIX\)/);
  assert.match(server, /res\.writeHead\(404\); res\.end\("not found"\); return;/);
  // a rebuilt bundle reuses its file names, so responses must revalidate
  assert.match(server, /"cache-control": "no-cache"/);
  assert.match(server, /if \(req\.headers\["if-none-match"\] === etag\)/);
});

test("the Monaco entry keeps workers same-origin and publishes the api", () => {
  assert.match(entry, /const BASE = "\/assets\/monaco\/";/);
  assert.match(entry, /new Worker\(`\$\{BASE\}\$\{name\}\.worker\.js`/);
  assert.match(entry, /self\.BooleanMonaco = monaco;/);
  for (const label of ["json", "css", "html", "typescript", "javascript"]) {
    assert.match(entry, new RegExp(`${label}: "`), `missing worker mapping for ${label}`);
  }
});

test("the editor bundle is build output, wired into install and packaging", () => {
  assert.equal(pkg.scripts["build:editor"], "node build/build-editor.mjs");
  assert.equal(pkg.scripts.postinstall, "node build/build-editor.mjs");
  assert.ok(pkg.devDependencies["monaco-editor"], "monaco-editor must stay a devDependency");
  assert.ok(!pkg.dependencies, "the runtime must stay dependency-free");
  assert.match(buildShell, /build-editor\.mjs/);
  assert.match(buildShell, /Copy-Item \$editorSource "\$out\\editor" -Recurse -Force/);
  // A missing bundle degrades to the plain editor; it must never fail a build.
  assert.match(buildEditor, /process\.exit\(0\)/);
  assert.match(buildEditor, /if \(!fs\.existsSync\(monacoDir\)\) skip/);
  const gitignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\/src\/assets\/monaco\/$/m);
});

test("the Code workspace loads Monaco lazily and falls back to plain text", () => {
  assert.match(ui, /id="codeEditorPlain"/);
  assert.match(ui, /script\.src="\/assets\/monaco\/editor\.js"/);
  assert.match(ui, /css\.href="\/assets\/monaco\/editor\.css"/);
  assert.match(ui, /script\.onerror=\(\)=>resolve\(null\)/);
  assert.match(ui, /if\(codeEd\.editor\)codeEd\.editor\.focus\(\);\s*\n\s*else codePlain\.focus/);
  assert.match(ui, /codePlain\?\.addEventListener\("input",\(\)=>codeMarkDirty\(codePlain\.value\)\)/);
});

test("Monaco gets language modes, line numbers, and syntax-only diagnostics", () => {
  assert.match(ui, /lineNumbers:"on"/);
  assert.match(ui, /noSemanticValidation:true,noSyntaxValidation:false/);
  assert.match(ui, /monaco\.editor\.onDidChangeMarkers/);
  assert.match(ui, /getModelMarkers\(\{resource:file\.model\.uri\}\)/);
  for (const [ext, language] of [["ts", "typescript"], ["py", "python"], ["rs", "rust"], ["ps1", "powershell"]]) {
    assert.match(ui, new RegExp(`${ext}:"${language}"`), `missing language mode for .${ext}`);
  }
});

test("Problems lists open-file diagnostics and navigates to each marker", () => {
  assert.match(ui, /id="codeProblemsPanel"/);
  assert.match(ui, /function codeAllProblems\(\)/);
  assert.match(ui, /function codeRenderProblemsPanel\(\)/);
  assert.match(ui, /codeOpenFile\(row\.filePath\)/);
  assert.match(ui, /codeRevealLine\(row\.marker\.startLineNumber,row\.marker\.startColumn\)/);
  assert.match(ui, /key==="m"&&event\.shiftKey/);
  assert.match(ui, /No errors or warnings in open files/);
});

test("editor models are per file and disposed with the tab and the project", () => {
  assert.match(ui, /function codeModelFor\(file\)/);
  assert.match(ui, /function codeDisposeFile\(file\)/);
  assert.match(ui, /codeDisposeFile\(file\);\s*\n\s*codeRenderTabs\(\)/);
  assert.match(ui, /function codeResetOpenFiles\(\)\{\s*\n\s*for\(const file of codeState\.files\.values\(\)\)codeDisposeFile\(file\);/);
  assert.match(ui, /other\.viewState=codeEd\.editor\.saveViewState\(\)/);
  assert.match(ui, /codeEd\.editor\.restoreViewState\(file\.viewState\)/);
});

test("Monaco follows the app theme", () => {
  assert.match(ui, /attributeFilter:\["data-visual-theme"\]/);
  assert.match(ui, /defineTheme\("boolean"/);
  assert.match(ui, /base:dark\?"vs-dark":"vs"/);
});

test("agent file references open in Code at the referenced line", () => {
  assert.match(ui, /async function openAgentFile\(rawPath\)/);
  assert.match(ui, /match\(\/\^\(\.\+\?\):\(\\d\+\)\(\?:\:\(\\d\+\)\)\?\$\//);
  assert.match(ui, /async function codeRevealPath\(filePath,line,column\)/);
  // a plain call would toggle the workspace shut when Code is already open
  assert.match(ui, /setWorkspaceTab\("code",\{force:true\}\)/);
  assert.match(ui, /revealLineInCenter\(lineNumber\)/);
  assert.match(ui, /else if\(a\.dataset\.file\) openAgentFile\(a\.dataset\.file\)/);
  // paths outside the active project still open in the read-only notepad
  assert.match(ui, /openFileInNotepad\(filePath\);/);
  assert.match(ui, /function codeProjectRelativePath\(filePath\)/);
});

test("Code supports a persistent second Monaco editor pane", () => {
  assert.match(ui, /id="codeEditorSecondary" aria-label="Secondary file editor"/);
  assert.match(ui, /function codeCreateSecondary\(\)/);
  assert.match(ui, /function codeToggleSplit\(force\)/);
  assert.match(ui, /function codeActivateSecondary\(filePath/);
  assert.match(ui, /boolean\.code\.layout\./);
  assert.match(ui, /event\.altKey.*codeActivateSecondary/);
});
