import test from "node:test";
import assert from "node:assert/strict";
import { CLOUD, PROVIDERS } from "../src/config.js";
import { providerImageSupport, resolveTarget } from "../src/providers.js";

test("Google AI is a first-class Gemini provider", async () => {
  assert.ok(PROVIDERS.includes("google"));
  assert.equal(CLOUD.google, "Google AI (Gemini)");

  const config = {
    provider: "google",
    google: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.6-flash",
      apiKey: "google-key"
    },
    ui: {},
    budgetLimit: 0
  };

  const target = await resolveTarget(config);
  assert.equal(target.provider, "google");
  assert.equal(target.base, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(target.model, "gemini-3.6-flash");
  assert.equal(target.apiKey, "google-key");
  assert.equal(providerImageSupport(config), true);
});
