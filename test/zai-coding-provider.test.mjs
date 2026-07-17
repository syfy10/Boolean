import test from "node:test";
import assert from "node:assert/strict";

import { backendUp, providerImageSupport, resolveTarget } from "../src/providers.js";
import { executeTool } from "../src/tools.js";

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

test("generic API connections enforce confirmation only for the Z.AI Coding Plan endpoint", async () => {
  const codingPlan = {
    provider: "customApi",
    customApi: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      model: "GLM-5.1",
      apiKey: "test-key",
      approvedUse: false
    }
  };
  await assert.rejects(resolveTarget(codingPlan), /approved Boolean|supported/);
  assert.equal(await backendUp(codingPlan), false);

  codingPlan.customApi.approvedUse = true;
  assert.equal((await resolveTarget(codingPlan)).provider, "customApi");
  assert.equal(await backendUp(codingPlan), true);

  const otherProvider = {
    provider: "customApi",
    customApi: {
      baseUrl: "https://models.example.com/v1",
      model: "example-chat",
      apiKey: "test-key",
      approvedUse: false
    }
  };
  assert.deepEqual(await resolveTarget(otherProvider), {
    base: "https://models.example.com/v1",
    apiKey: "test-key",
    model: "example-chat",
    provider: "customApi"
  });
  assert.equal(await backendUp(otherProvider), true);
});

test("a pasted full chat-completions URL is normalized to the provider base", async () => {
  const config = codingConfig({
    approvedUse: true,
    baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions/"
  });
  assert.equal((await resolveTarget(config)).base, "https://api.z.ai/api/coding/paas/v4");
});

test("Z.AI Coding Plan is treated as text-only before screenshot content is sent", () => {
  assert.equal(providerImageSupport(codingConfig({ approvedUse: true, model: "GLM-5.1" })), false);
  assert.equal(providerImageSupport({
    provider: "customApi",
    customApi: { baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "GLM-5.1" }
  }), false);
  assert.equal(providerImageSupport({ provider: "glm", glm: { model: "GLM-5V-Turbo" } }), true);
  assert.equal(providerImageSupport({ provider: "glm", glm: { model: "GLM-5.1" } }), false);
});

test("screenshots stay out of a text-only Z.AI request and layout inspection remains available", async () => {
  const pendingImages = [];
  const config = codingConfig({ approvedUse: true, model: "GLM-5.1" });
  const screenshot = await executeTool("screenshot_page", {}, {
    config,
    pendingImages,
    captureScreenshot: async () => ({ ok: true, image: "cG5n", url: "http://localhost:3210", result: "Demo page" }),
    onImage: () => {}
  });
  assert.equal(pendingImages.length, 0);
  assert.match(screenshot, /text-only/);
  assert.match(screenshot, /inspect_page_layout/);

  let command;
  const result = await executeTool("inspect_page_layout", { selector: ".scan-panel", scroll: 400 }, {
    config,
    visibleBrowser: async (value) => { command = value; return "layout result"; }
  });
  assert.deepEqual(command, { action: "inspect_layout", selector: ".scan-panel", scroll: 400 });
  assert.equal(result, "layout result");
});
