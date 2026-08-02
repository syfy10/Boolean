import test from "node:test";
import assert from "node:assert/strict";

import {
  autoModelHealth,
  nextAutoModelTarget,
  noteAutoModelOutcome,
  resetAutoModelHealth,
  routeForTurn,
  selectExecutionEngine,
  selectAutoModelRoute
} from "../src/model-router.js";

function config(overrides = {}) {
  return {
    provider: "zaiCoding",
    local: { model: "qwen-small.gguf", mmprojMap: {} },
    zaiCoding: { apiKey: "zai-key", model: "GLM-5.1" },
    google: { apiKey: "google-key", model: "gemini-3.6-flash" },
    openai: { apiKey: "openai-key", model: "gpt-5.1" },
    ui: {
      autoRouteModels: true,
      codingAgent: { compatibilityMode: "auto" },
      modelRouting: {
        selected: "chat",
        preference: "balanced",
        allowEscalation: true,
        profiles: {},
        projects: {}
      }
    },
    ...overrides
  };
}

test.beforeEach(() => resetAutoModelHealth());
test.afterEach(() => resetAutoModelHealth());

test("Auto classifies image, coding, research, fast, and general turns", () => {
  assert.equal(routeForTurn([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,a" } }] }]), "vision");
  assert.equal(routeForTurn([{ role: "user", content: "Fix the CSS bug and run the tests" }], { turnMode: "action" }), "coding");
  assert.equal(routeForTurn([{ role: "user", content: "Research the latest sources and compare them" }]), "research");
  assert.equal(routeForTurn([{ role: "user", content: "Summarize this" }]), "fast");
  assert.equal(routeForTurn([{ role: "user", content: "I want to talk through a long-term product strategy with several tradeoffs, constraints, customer expectations, operational concerns, and alternatives before deciding what direction makes the most sense for the next year." }]), "chat");
});

test("Auto off preserves the composer model", () => {
  const cfg = config({ ui: { autoRouteModels: false, modelRouting: {} } });
  const result = selectAutoModelRoute(cfg, [{ role: "user", content: "Fix the app" }], { turnMode: "action" });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.target, { provider: "zaiCoding", model: "GLM-5.1" });
});

test("manual execution-engine choices are never overridden", () => {
  for (const engine of ["boolean", "codex", "claude-code"]) {
    const result = selectExecutionEngine({ codingEngine: engine }, [{ role: "user", content: "Build the app" }], {
      codexReady: true,
      claudeReady: true
    });
    assert.equal(result.engine, engine);
    assert.equal(result.automatic, false);
  }
});

test("Auto tries the selected Boolean API before any coding subscription", () => {
  const cfg = config({ codingEngine: "auto" });
  cfg.ui.modelRouting.subscriptionEngines = { codex: true, claudeCode: true, preferred: "codex" };
  let result = selectExecutionEngine(cfg, [{ role: "user", content: "Fix the CSS and run tests" }], { codexReady: true, claudeReady: true });
  assert.equal(result.engine, "boolean");
  assert.equal(result.route, "coding");
  assert.match(result.reason, /first attempt/i);

  result = selectExecutionEngine(cfg, [{ role: "user", content: "Fix the CSS and run tests" }], { escalationRequired: true, codexReady: true, claudeReady: true });
  assert.equal(result.engine, "codex");
  assert.equal(result.route, "coding");

  result = selectExecutionEngine(cfg, [{ role: "user", content: "Fix the CSS and run tests" }], { escalationRequired: true, codexReady: false, claudeReady: true });
  assert.equal(result.engine, "claude-code");

  result = selectExecutionEngine(cfg, [{ role: "user", content: "Fix the CSS and run tests" }], { escalationRequired: true, codexReady: false, claudeReady: false });
  assert.equal(result.engine, "boolean");
  assert.match(result.reason, /not.*ready|no approved/i);
});

test("Auto never escalates chat, research, or vision to a coding subscription", () => {
  const cfg = config({ codingEngine: "auto" });
  cfg.ui.modelRouting.subscriptionEngines = { codex: true, claudeCode: true, preferred: "codex" };
  assert.equal(selectExecutionEngine(cfg, [{ role: "user", content: "Hello there" }], { escalationRequired: true, codexReady: true, claudeReady: true }).engine, "boolean");
  assert.equal(selectExecutionEngine(cfg, [{ role: "user", content: "Research current sources" }], { route: "research", escalationRequired: true, taskExecution: true, codexReady: true, claudeReady: true }).engine, "boolean");
  assert.equal(selectExecutionEngine(cfg, [{ role: "user", content: "Review this screenshot" }], { hasImages: true, escalationRequired: true, taskExecution: true, codexReady: true, claudeReady: true }).engine, "boolean");

  cfg.ui.modelRouting.profiles.chat = { engine: "claude-code", provider: "auto", model: "" };
  assert.equal(selectExecutionEngine(cfg, [{ role: "user", content: "Hello there" }], { route: "chat", escalationRequired: true, codexReady: true, claudeReady: true }).engine, "boolean");
});

test("Auto can escalate a failed project task even when its short follow-up is not classified as coding", () => {
  const cfg = config({ codingEngine: "auto" });
  cfg.ui.modelRouting.subscriptionEngines = { codex: true, claudeCode: true, preferred: "claude-code" };
  const result = selectExecutionEngine(cfg, [{ role: "user", content: "do it" }], {
    route: "fast",
    taskExecution: true,
    escalationRequired: true,
    codexReady: true,
    claudeReady: true
  });
  assert.equal(result.engine, "claude-code");
});

test("a saved task profile selects its connected provider and retains fallbacks", () => {
  const cfg = config();
  cfg.ui.modelRouting.profiles.coding = { provider: "openai", model: "gpt-5.1" };
  const result = selectAutoModelRoute(cfg, [{ role: "user", content: "Build the feature" }], { turnMode: "action" });
  assert.equal(result.route, "coding");
  assert.deepEqual(result.target, { provider: "openai", model: "gpt-5.1" });
  assert.ok(result.alternates.some((candidate) => candidate.provider === "zaiCoding"));
});

test("vision routing excludes connected text-only providers", () => {
  const cfg = config();
  const result = selectAutoModelRoute(cfg, [{ role: "user", content: "Review this screenshot" }], { hasImages: true });
  assert.equal(result.route, "vision");
  assert.ok(["google", "openai"].includes(result.target.provider));
  assert.equal(result.alternates.some((candidate) => candidate.provider === "zaiCoding"), false);
  assert.equal(result.alternates.some((candidate) => candidate.provider === "local"), false);
});

test("a project lock overrides the generic profile without losing safe fallbacks", () => {
  const projectDir = "C:\\work\\important";
  const cfg = config();
  cfg.ui.modelRouting.profiles.coding = { provider: "openai", model: "gpt-5.1" };
  cfg.ui.modelRouting.projects[projectDir] = { mode: "locked", provider: "google", model: "gemini-3.6-flash" };
  const result = selectAutoModelRoute(cfg, [{ role: "user", content: "Fix it" }], { turnMode: "action", projectDir });
  assert.deepEqual(result.target, { provider: "google", model: "gemini-3.6-flash" });
  assert.match(result.reason, /project lock/i);
  assert.ok(nextAutoModelTarget(result, result.target));
});

test("health failures cool down an automatic candidate and successful outcomes are recorded", () => {
  resetAutoModelHealth();
  const cfg = config();
  cfg.ui.modelRouting.preference = "quality";
  const first = selectAutoModelRoute(cfg, [{ role: "user", content: "Build the API" }], { turnMode: "action" });
  noteAutoModelOutcome(first.target, { ok: false, latencyMs: 100, error: "temporary outage" });
  const second = selectAutoModelRoute(cfg, [{ role: "user", content: "Build the API" }], { turnMode: "action" });
  assert.notDeepEqual(second.target, first.target);
  assert.ok(autoModelHealth(first.target).cooldownUntil > Date.now());
  noteAutoModelOutcome(second.target, { ok: true, latencyMs: 80 });
  assert.equal(autoModelHealth(second.target).successes, 1);
  resetAutoModelHealth();
});
