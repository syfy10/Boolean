import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("desktop browser snapshots are available to scheduled page monitors", () => {
  assert.match(ui, /function publishBrowserSnapshot\(browser\)/);
  assert.match(ui, /\/api\/browser\/context-snapshot/);
  assert.match(server, /CURRENT VISIBLE BROWSER SNAPSHOT/);
  assert.match(server, /Treat the symbol or contract visible in this snapshot as the monitored instrument/);
  assert.match(server, /\["read", "inspect_layout"\]/);
  assert.match(server, /if \(!item\.threadId\) item\.threadId = t\.id/);
});

test("a page navigation refreshes the cached snapshot instead of pinning a ticker", () => {
  assert.match(ui, /shellBrowserPage=\{url:d\.url\|\|"",title:d\.title\|\|""\};[\s\S]*?publishBrowserSnapshot/);
  assert.doesNotMatch(server, /Treat GOOGL as the monitored instrument/);
});
