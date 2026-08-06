// Boolean's Monaco bundle entry. `build/build-editor.mjs` bundles this with
// esbuild into src/assets/monaco/editor.js (+ editor.css and the codicon font);
// server.js serves that folder at /assets/monaco/ and ui.html loads it lazily
// the first time the Code workspace opens. Monaco is a build-time dependency
// only — the Node backend stays dependency-free at runtime.
import * as monaco from "monaco-editor/editor/editor.main.js";

const BASE = "/assets/monaco/";

// Language services that ship a real worker. Everything else is Monarch-only
// highlighting and needs no worker at all.
const WORKER_BY_LANGUAGE = {
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  handlebars: "html",
  razor: "html",
  typescript: "ts",
  javascript: "ts"
};

self.MonacoEnvironment = {
  getWorker(_id, label) {
    const name = WORKER_BY_LANGUAGE[label] || "editor";
    return new Worker(`${BASE}${name}.worker.js`, { name: `boolean-monaco-${name}` });
  }
};

self.BooleanMonaco = monaco;
self.dispatchEvent(new Event("boolean-monaco-ready"));
