import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CLOUD, FIRST_PARTY_CLOUD_PROVIDERS, PROVIDERS } from "../src/config.js";
import { resolveTarget } from "../src/providers.js";

const EXPECTED = {
  openai: ["OpenAI", "https://api.openai.com/v1"],
  claude: ["Claude (Anthropic)", "https://api.anthropic.com/v1"],
  google: ["Google AI (Gemini)", "https://generativelanguage.googleapis.com/v1beta/openai"],
  xai: ["xAI (Grok)", "https://api.x.ai/v1"],
  deepseek: ["DeepSeek", "https://api.deepseek.com"],
  qwen: ["Alibaba Cloud (Qwen)", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"],
  baidu: ["Baidu Qianfan (ERNIE)", "https://api.baiduqianfan.ai/v1"],
  bytedance: ["ByteDance ModelArk (Doubao)", "https://operator.las.ap-southeast-1.volces.com/api/v1"],
  glm: ["GLM (Z.ai)", "https://api.z.ai/api/paas/v4"],
  zaiCoding: ["Z.AI Coding Plan", "https://api.z.ai/api/coding/paas/v4"],
  kimi: ["Moonshot AI (Kimi)", "https://api.moonshot.ai/v1"]
};

test("all requested first-party cloud providers are selectable and resolvable", async () => {
  assert.deepEqual(FIRST_PARTY_CLOUD_PROVIDERS, Object.keys(EXPECTED));
  for (const [provider, [label, baseUrl]] of Object.entries(EXPECTED)) {
    assert.ok(PROVIDERS.includes(provider));
    assert.equal(CLOUD[provider], label);
    const config = {
      provider,
      [provider]: { baseUrl, model: "test-model", apiKey: "test-key" },
      ui: {},
      budgetLimit: 0
    };
    const target = await resolveTarget(config);
    assert.equal(target.provider, provider);
    assert.equal(target.base, baseUrl);
    assert.equal(target.apiKey, "test-key");
  }
});

test("all requested providers appear in settings and the composer catalog", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  for (const provider of Object.keys(EXPECTED)) {
    assert.match(ui, new RegExp(`<option value="${provider}">`));
    assert.match(ui, new RegExp(`${provider}:`));
  }
});
