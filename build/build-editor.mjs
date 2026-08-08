// Bundles Monaco into src/assets/monaco/ for the Code workspace.
//
//   node build/build-editor.mjs
//
// Monaco is a devDependency: the bundle is build output, not source, and is
// gitignored. When it is missing the Code workspace falls back to its plain
// textarea editor, so a missing monaco-editor package is a warning, not an
// error — this script stays exit-0 so `npm install` and offline clones work.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "src", "assets", "monaco");
const monacoDir = path.join(root, "node_modules", "monaco-editor");
const esm = (...parts) => path.join(monacoDir, "esm", "vs", ...parts);

function skip(reason) {
  console.log(`build-editor: skipped (${reason}). Code falls back to the plain text editor.`);
  process.exit(0);
}

if (!fs.existsSync(monacoDir)) skip("monaco-editor is not installed");

let esbuild;
try {
  ({ default: esbuild } = await import("esbuild"));
} catch {
  skip("esbuild is not installed");
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: {
    editor: path.join(root, "src", "editor", "monaco.entry.js"),
    "editor.worker": esm("editor", "editor.worker.js"),
    "json.worker": esm("language", "json", "json.worker.js"),
    "css.worker": esm("language", "css", "css.worker.js"),
    "html.worker": esm("language", "html", "html.worker.js"),
    "ts.worker": esm("language", "typescript", "ts.worker.js")
  },
  outdir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  loader: { ".ttf": "file" },
  logLevel: "warning"
});

const bytes = fs.readdirSync(outdir).reduce((sum, name) => sum + fs.statSync(path.join(outdir, name)).size, 0);
console.log(`build-editor: wrote src/assets/monaco/ (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
