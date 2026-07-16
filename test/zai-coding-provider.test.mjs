import test from "node:test";
import assert from "node:assert/strict";

import { backendUp, resolveTarget } from "../src/providers.js";

function codingConfig(overrides = {}) {
  return {
    provider: "zaiCoding",
    zaiCoding: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      model: "GLM-4.7",
      apiKey: "test-key",
      approvedUse: false,
      ...overrides
    }
  };
}

test("Z.AI Coding Plan stays disabled until supported use is confirmed", async () => {
  const config = codingConfig();
  await assert.rejects(resolveTarget(config), /approved Boolean|supported/);
  assert.equal(await backendUp(config), false);
});

test("approved Z.AI Coding Plan resolves through its dedicated endpoint", async () => {
  const config = codingConfig({ approvedUse: true, model: "GLM-5.1" });
  assert.deepEqual(await resolveTarget(config), {
    base: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "test-key",
    model: "GLM-5.1",
    provider: "zaiCoding"
  });
  assert.equal(await backendUp(config), true);
});
