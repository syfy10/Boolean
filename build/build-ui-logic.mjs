// Bundles the browser-side logic modules in src/ui/ into src/assets/ui-logic.js.
//
//   node build/build-ui-logic.mjs
//
// ui.html is one enormous inline <script>, which meant the only way to unit-test
// anything in it was to slice the function out by string offset and re-evaluate
// it with new Function(). Logic that moves into src/ui/ is a real ES module: the
// tests import it, and the browser gets this bundle inlined into ui.html by the
// server as it serves the page.
//
// Unlike build-editor.mjs (Monaco, which degrades to a plain textarea when
// absent) this bundle is required — the page cannot render its trading bar
// without it — so a failure here is fatal rather than a skip.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "ui", "index.js");
const outfile = path.join(root, "src", "assets", "ui-logic.js");

let esbuild;
try {
  ({ default: esbuild } = await import("esbuild"));
} catch {
  console.error("build-ui-logic: esbuild is not installed. Run `npm install` first.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  // A classic script assigning one global, so ui.html's existing inline script
  // can destructure it without becoming a module itself.
  format: "iife",
  globalName: "BoollmTradingLogic",
  platform: "browser",
  target: ["chrome110"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning"
});

const bytes = fs.statSync(outfile).size;
console.log(`build-ui-logic: wrote src/assets/ui-logic.js (${(bytes / 1024).toFixed(1)} KB)`);
