import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findWorkspaceFiles, findWorkspaceSymbols, scoreFuzzyPath, searchWorkspaceText } from "../src/workspace-files.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-search-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "server.js"), "export const port = 8765;\nconst marker = 'findMe';\n");
  fs.writeFileSync(path.join(root, "src", "lib", "util.js"), "// findme lives here too\nexport const x = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\nNothing to see.\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "const marker = 'findMe';\n");
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  return root;
}

test("fuzzy path scoring rewards file-name matches and rejects non-matches", () => {
  // the query lives in the file name, not only in the folders above it
  assert.ok(scoreFuzzyPath("src/util.js", "util") > scoreFuzzyPath("util/src/other.js", "util"));
  assert.ok(scoreFuzzyPath("src/server.js", "srvjs") > 0);
  assert.equal(scoreFuzzyPath("src/util.js", "zzz"), -1);
  // an empty query ranks nothing but rejects nothing
  assert.equal(scoreFuzzyPath("src/util.js", ""), 0);
});

test("equally scored paths rank the shortest first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-rank-"));
  try {
    fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "server.js"), "");
    fs.writeFileSync(path.join(root, "src", "lib", "other-service.js"), "");
    const ranked = findWorkspaceFiles(root, "srvjs").matches.map((hit) => hit.path);
    assert.equal(ranked[0], "src/server.js");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("quick open ranks project files and skips generated folders", () => {
  const root = fixture();
  try {
    const found = findWorkspaceFiles(root, "util");
    assert.equal(found.matches[0].path, "src/lib/util.js");
    assert.ok(!found.matches.some((hit) => hit.path.includes("node_modules")));

    // no query lists the project, still without generated folders
    const all = findWorkspaceFiles(root, "");
    const paths = all.matches.map((hit) => hit.path);
    assert.ok(paths.includes("README.md"));
    assert.ok(!paths.some((item) => item.startsWith("node_modules/")));

    assert.deepEqual(findWorkspaceFiles(root, "nosuchthing").matches, []);
    assert.equal(findWorkspaceFiles(root, "util", { limit: 1 }).matches.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("project search reports every match with its line and column", () => {
  const root = fixture();
  try {
    const found = searchWorkspaceText(root, "findMe");
    const hit = found.matches.find((match) => match.path === "src/server.js");
    assert.equal(hit.line, 2);
    assert.equal(hit.column, "const marker = '".length + 1);
    assert.equal(hit.text, "const marker = 'findMe';");
    // case-insensitive by default, so the lowercase copy is found too
    assert.ok(found.matches.some((match) => match.path === "src/lib/util.js"));
    assert.ok(!found.matches.some((match) => match.path.includes("node_modules")));

    const exact = searchWorkspaceText(root, "findMe", { caseSensitive: true });
    assert.ok(!exact.matches.some((match) => match.path === "src/lib/util.js"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("project search stays bounded and skips binary files", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "many.txt"), "needle\n".repeat(200));
    const capped = searchWorkspaceText(root, "needle", { limit: 5 });
    assert.equal(capped.matches.length, 5);
    assert.equal(capped.truncated, true);

    // one file cannot crowd out the rest of the project
    const perFile = searchWorkspaceText(root, "needle", { perFile: 3 });
    assert.equal(perFile.matches.filter((match) => match.path === "many.txt").length, 3);

    fs.writeFileSync(path.join(root, "big.txt"), "needle\n" + "x".repeat(3_000_000));
    assert.ok(!searchWorkspaceText(root, "needle").matches.some((match) => match.path === "big.txt"));
    assert.ok(!searchWorkspaceText(root, "PNG").matches.some((match) => match.path === "logo.png"));

    assert.throws(() => searchWorkspaceText(root, "a"), { code: "WORKSPACE_QUERY_SHORT" });
    assert.throws(() => searchWorkspaceText(root, "   "), { code: "WORKSPACE_QUERY_SHORT" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the search route serves both modes from the active project", () => {
  assert.match(server, /findWorkspaceFiles, findWorkspaceSymbols, searchWorkspaceText/);
  assert.match(server, /p === "\/api\/workspace\/search"/);
  assert.match(server, /mode === "text"/);
  assert.match(server, /mode === "symbols" \? findWorkspaceSymbols/);
  assert.match(server, /caseSensitive: url\.searchParams\.get\("case"\) === "1"/);
});

test("the palette opens on Ctrl+P and Ctrl+Shift+F inside Code only", () => {
  assert.match(ui, /id="codePalette"/);
  assert.match(ui, /id="codePaletteInput"/);
  assert.match(ui, /if\(!document\.body\.classList\.contains\("code-open"\)\)return;/);
  assert.match(ui, /key==="p"&&!event\.shiftKey.*codePaletteOpen\("files"\)/);
  assert.match(ui, /key==="t"&&!event\.shiftKey.*codePaletteOpen\("symbols"\)/);
  assert.match(ui, /key==="f"&&event\.shiftKey.*codePaletteOpen\("text"\)/);
  assert.match(ui, /id="codeSearch"/);
});

test("workspace symbols power Ctrl+T and F12 definition navigation", () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, "src", "server.js"), "export function startServer() {}\nclass Router {}\n");
    fs.writeFileSync(path.join(root, "src", "worker.py"), "def process_job(value):\n    return value\n");
    const symbols = findWorkspaceSymbols(root, "server");
    assert.equal(symbols.matches[0].name, "startServer");
    assert.equal(symbols.matches[0].path, "src/server.js");
    assert.equal(findWorkspaceSymbols(root, "process_job").matches[0].kind, "function");
    assert.match(ui, /function codeGoToDefinition\(editor\)/);
    assert.match(ui, /KeyCode\.F12/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("palette results are keyboard driven and open at the matched line", () => {
  assert.match(ui, /event\.key==="ArrowDown".*codePaletteMove\(1\)/);
  assert.match(ui, /event\.key==="Escape".*codePaletteClose\(\)/);
  assert.match(ui, /await codeOpenFile\(hit\.path\);\s*\n\s*if\(hit\.line&&codeState\.active===hit\.path\)codeRevealLine\(hit\.line,hit\.column\)/);
  // a slow earlier query must not overwrite newer results
  assert.match(ui, /if\(token!==codePalette\.token\)return;/);
});
