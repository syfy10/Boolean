import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  capabilityProbeTool,
  capabilityProbeUnsupportedError,
  evaluateCapabilityProbeReply,
  modelCapabilityKey,
  modelCapabilityProfile,
  nativeToolSupport,
  parseBooleanPatch,
  recordNativeToolSupport
} from "../src/model-capabilities.js";

function config(overrides = {}) {
  return {
    provider: "zaiCoding",
    zaiCoding: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      model: "GLM-5-Turbo"
    },
    modelCapabilities: {},
    ui: { codingAgent: { compatibilityMode: "auto" } },
    ...overrides
  };
}

test("GLM-5-Turbo on the Z.AI Coding Plan uses the compatibility tool bridge", () => {
  const cfg = config();
  const target = { provider: "zaiCoding", base: cfg.zaiCoding.baseUrl, model: cfg.zaiCoding.model };
  const profile = modelCapabilityProfile(cfg, target, { vision: false });
  assert.equal(nativeToolSupport(cfg, target), false);
  assert.equal(profile.mode, "patch");
  assert.equal(profile.label, "Compatible coding");
  assert.equal(profile.capabilities.fileEdit, true);
  assert.equal(profile.capabilities.terminal, true);
  assert.equal(profile.capabilities.browser, true);
  assert.equal(profile.capabilities.deploy, true);
  assert.equal(profile.capabilities.vision, false);
  assert.match(profile.warning, /validated compatibility bridge/i);
});

test("capability records are scoped to provider endpoint and model and override inference", () => {
  const cfg = config();
  const target = { provider: "zaiCoding", base: cfg.zaiCoding.baseUrl, model: cfg.zaiCoding.model };
  const other = { ...target, model: "GLM-5.1" };
  recordNativeToolSupport(cfg, target, true, "probe passed");
  assert.equal(nativeToolSupport(cfg, target), true);
  assert.equal(nativeToolSupport(cfg, other), null);
  assert.notEqual(modelCapabilityKey(cfg, target), modelCapabilityKey(cfg, other));
  assert.equal(modelCapabilityProfile(cfg, target).mode, "native");
});

test("forced review mode blocks mutation capabilities even for a native model", () => {
  const cfg = config({
    provider: "openai",
    openai: { baseUrl: "https://api.openai.com/v1", model: "tool-model" },
    ui: { codingAgent: { compatibilityMode: "review" } }
  });
  const target = { provider: "openai", base: cfg.openai.baseUrl, model: cfg.openai.model };
  recordNativeToolSupport(cfg, target, true);
  const profile = modelCapabilityProfile(cfg, target, { vision: true });
  assert.equal(profile.mode, "review");
  assert.equal(profile.capabilities.fileEdit, false);
  assert.equal(profile.capabilities.terminal, false);
  assert.equal(profile.capabilities.vision, true);
});

test("the harmless capability probe recognizes only the exact native function call", () => {
  const tool = capabilityProbeTool();
  assert.equal(tool.function.name, "boolean_capability_probe");
  assert.deepEqual(tool.function.parameters.properties, {});
  assert.equal(evaluateCapabilityProbeReply({
    tool_calls: [{ type: "function", function: { name: "boolean_capability_probe", arguments: "{}" } }]
  }).supported, true);
  assert.equal(evaluateCapabilityProbeReply({ content: "I would call the probe." }).supported, false);
  assert.equal(evaluateCapabilityProbeReply({
    tool_calls: [{ type: "function", function: { name: "write_file", arguments: "{}" } }]
  }).supported, false, "an unrelated requested tool is never accepted or executed");
});

test("only explicit provider tool-support errors become a limited capability result", () => {
  assert.equal(capabilityProbeUnsupportedError({
    message: "This model does not support function calling."
  }), true);
  assert.equal(capabilityProbeUnsupportedError({
    body: '{"error":{"message":"tools are unsupported"}}'
  }), true);
  assert.equal(capabilityProbeUnsupportedError({
    message: "Network connection timed out."
  }), false);
});

test("Boolean patches require one explicit fenced block with exact bounded edits", () => {
  const root = path.join(os.tmpdir(), "boolean-patch-root");
  const parsed = parseBooleanPatch([
    "```boolean_patch",
    JSON.stringify({ edits: [{ path: "src/app.js", old: "const old = 1;", new: "const next = 2;" }] }),
    "```"
  ].join("\n"), root);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "replace");
  assert.equal(parsed[0].path, "src/app.js");
  assert.equal(parseBooleanPatch('{"edits":[]}', root), null, "bare JSON is never translated into an edit");
  assert.throws(() => parseBooleanPatch([
    "```boolean_patch", '{"edits":[]}', "```",
    "```boolean_patch", '{"edits":[]}', "```"
  ].join("\n"), root), /exactly one/i);
  assert.throws(() => parseBooleanPatch([
    "```boolean_patch",
    JSON.stringify({ edits: [{ path: "../outside.js", content: "unsafe" }] }),
    "```"
  ].join("\n"), root), /outside/i);
});
