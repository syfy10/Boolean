import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import {
  beforeQuoteHints,
  legendTradingDetailsFromPageText,
  normalizeSymbolInput,
  quoteFromPageText,
  symbolFromPageText
} from "../src/ui/trading-logic.js";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const ui = read("src/ui.html").replace(/\r/g, "");

test("the trading parsers are a real module, not a slice of ui.html", () => {
  // These used to be lifted out of ui.html by string offset and re-evaluated
  // with new Function(), which meant reformatting the file broke the tests and
  // the tests could pass while the shipped page was broken.
  for (const fn of [normalizeSymbolInput, symbolFromPageText, quoteFromPageText,
    legendTradingDetailsFromPageText, beforeQuoteHints]) {
    assert.equal(typeof fn, "function");
  }
  // The module must stay pure — no DOM, no shell, no network.
  const source = read("src/ui/trading-logic.js");
  for (const forbidden of ["document.", "window.", "fetch(", "hostPost", "localStorage", "SHELL"]) {
    assert.ok(!source.includes(forbidden), `trading-logic.js must not reference ${forbidden}`);
  }
  assert.ok(!ui.includes("function symbolFromPageText"), "parser still duplicated in ui.html");
});

test("ui.html takes the bundle from the server rather than defining it", () => {
  assert.match(ui, /\/\*__BOOLEAN_UI_LOGIC__\*\//);
  assert.match(ui, /window\.BooleanTradingLogic/);
});

test("the bundle is build output, wired into install and packaging", () => {
  assert.equal(pkg.scripts["build:ui-logic"], "node build/build-ui-logic.mjs");
  assert.match(pkg.scripts.postinstall, /node build\/build-ui-logic\.mjs/);
  assert.match(read("build/build-exe.ps1"), /build-ui-logic\.mjs/);
  assert.match(read(".gitignore"), /\/src\/assets\/ui-logic\.js/);
  // Packaged builds serve it from the SEA blob, so it has to be an asset.
  assert.equal(JSON.parse(read("build/sea-config.json")).assets["ui-logic.js"], "src/assets/ui-logic.js");
  // Unlike Monaco (which degrades to a textarea) this bundle is required.
  assert.match(read("build/build-ui-logic.mjs"), /process\.exit\(1\)/);
});

test("the served page carries the bundle inlined", async (t) => {
  const app = await startServer(defaultConfig(), { port: 0, sessionToken: "1" });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const html = await (await fetch(`http://127.0.0.1:${app.port}/`)).text();

  assert.ok(!html.includes("/*__BOOLEAN_UI_LOGIC__*/"), "placeholder was never replaced");
  assert.ok(html.includes("var BooleanTradingLogic"), "bundle missing from the served page");
  assert.ok(html.includes("function symbolFromPageText"), "parser missing from the served page");
});
