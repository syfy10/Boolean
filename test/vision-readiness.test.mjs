import assert from "node:assert/strict";
import test from "node:test";
import { projectorCanAcceptImages } from "../src/engine.js";

test("a compatible matching projector enables images before manual testing", () => {
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", true, null), true);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", null, undefined), true);
});

test("missing, incompatible, or failed projectors block images", () => {
  assert.equal(projectorCanAcceptImages("", true, null), false);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", false, null), false);
  assert.equal(projectorCanAcceptImages("matching-mmproj.gguf", true, { ok: false }), false);
});
