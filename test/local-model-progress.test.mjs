import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { localLoadProgressFromLine } from "../src/engine.js";
import { isLightweightLocalChat } from "../src/agent.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");

test("llama.cpp startup output maps to monotonic user-facing load phases", () => {
  assert.deepEqual(
    localLoadProgressFromLine("llama_model_loader: loaded meta data with 33 key-value pairs"),
    { phase: "reading model", pct: 35 }
  );
  assert.deepEqual(
    localLoadProgressFromLine("load_tensors: offloading 12 repeating layers to GPU"),
    { phase: "loading model", pct: 55 }
  );
  assert.deepEqual(
    localLoadProgressFromLine("llama_context: KV cache size = 512.00 MiB"),
    { phase: "preparing context", pct: 75 }
  );
  assert.deepEqual(
    localLoadProgressFromLine("warming up the model with an empty run"),
    { phase: "warming up", pct: 88 }
  );
  assert.deepEqual(
    localLoadProgressFromLine("main: server is listening at http://127.0.0.1:8783"),
    { phase: "starting server", pct: 95 }
  );
  assert.deepEqual(localLoadProgressFromLine("load progress 42.4%"), { phase: "loading", pct: 42 });
  assert.equal(localLoadProgressFromLine("ordinary diagnostic output"), null);
});

test("local model progress streams from the engine to a visible staged bar", () => {
  assert.match(server, /onStatus: \(text, detail\) => send\(\{ type: "status", text, \.\.\.\(detail \|\| \{\}\) \}\)/);
  assert.match(ui, /class="load-progress" hidden/);
  assert.match(ui, /ev\.kind==="local-model-load"/);
  assert.match(ui, /classList\.toggle\("local-model-load",!!load\)/);
  assert.match(ui, /load-fill"\);\s*if\(fill&&fill\.style\.width!==width\) fill\.style\.width=width;/);
});

test("local generation reports evaluation and writing instead of claiming readiness early", () => {
  assert.match(agent, /onStatus\?\.\("Model loaded - evaluating your request\.\.\."\)/);
  assert.match(agent, /onStatus\?\.\("Writing your answer\.\.\."\)/);
  assert.doesNotMatch(agent, /onStatus\?\.\("Model ready - preparing your answer\.\.\."\)/);
});

test("new and missing local context settings use the faster 8k default", () => {
  assert.match(config, /ctx: 8192,\s+\/\/ fast first-load default/);
  assert.match(config, /if \(!cfg\.local\.ctx\) cfg\.local\.ctx = 8192/);
});

test("simple local conversation avoids the expensive agent tool catalog", () => {
  for (const prompt of ["hi", "Hello!", "what can you do for me?", "tell me a short story"]) {
    assert.equal(isLightweightLocalChat(prompt), true, prompt);
  }
  for (const prompt of ["build a website", "check this project", "hello, connect my Cloudflare account"]) {
    assert.equal(isLightweightLocalChat(prompt), false, prompt);
  }
});
