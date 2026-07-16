import assert from "node:assert/strict";
import test from "node:test";
import { autoMatchMmproj, projectorCanAcceptImages } from "../src/engine.js";

test("a compatible matching projector enables images before manual testing", () => {
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", true, null), true);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", null, undefined), true);
});

test("missing, incompatible, or failed projectors block images", () => {
  assert.equal(projectorCanAcceptImages("", true, null), false);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", false, null), false);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", true, { ok: false }), false);
});

test("a lone projector is not attached to an unrelated model", () => {
  const projector = "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf";
  assert.equal(autoMatchMmproj("Qwen3.5-4B-Q4_K_M.gguf", [projector]), null);
  assert.equal(autoMatchMmproj("Qwen_Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", [projector]), projector);
});
