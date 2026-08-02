import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { recommendLocalSettings } from "../src/engine.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");

test("low-memory PCs receive a small model and context recommendation", () => {
  const result = recommendLocalSettings({ ramGb: 6, backend: "cpu", gpu: null }, 2.1 * 1073741824);
  assert.equal(result.modelId, "qwen2.5-3b");
  assert.equal(result.ctx, 4096);
  assert.equal(result.gpuLayers, 0);
  assert.equal(result.accelerated, false);
});

test("typical PCs receive the balanced model without imaginary GPU acceleration", () => {
  const result = recommendLocalSettings({ ramGb: 16, backend: "cpu", gpu: { name: "GPU", vramGb: 8 } }, 4.7 * 1073741824);
  assert.equal(result.modelId, "qwen2.5-7b");
  assert.equal(result.ctx, 8192);
  assert.equal(result.gpuLayers, 0);
  assert.match(result.summary, /install a llama\.cpp GPU backend/i);
});

test("verified GPU backends receive full or bounded layer offload", () => {
  const full = recommendLocalSettings({ ramGb: 32, backend: "vulkan", gpu: { name: "GPU", vramGb: 12 } }, 4.7 * 1073741824);
  assert.equal(full.ctx, 16384);
  assert.equal(full.gpuLayers, 999);
  assert.equal(full.accelerated, true);

  const partial = recommendLocalSettings({ ramGb: 16, backend: "cuda", gpu: { name: "GPU", vramGb: 4 } }, 4.7 * 1073741824);
  assert.ok(partial.gpuLayers > 0 && partial.gpuLayers < 40);
});

test("manual context changes opt out of automatic context tuning", () => {
  assert.match(config, /autoTune: true/);
  assert.match(server, /config\.local\.autoTune = false/);
});

test("the model library explains and can install available GPU acceleration", () => {
  assert.match(ui, /Best for this PC/);
  assert.match(ui, /Enable GPU acceleration/);
  assert.match(server, /\/api\/models\/accelerator/);
});
