import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { recordUsage, resetUsage, summarizeUsage, checkBudget, monthSpend, costOf, _setUsageDirForTest } = await import("../src/usage.js");

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saz-budget-"));
  _setUsageDirForTest(dir);
}

test("monthSpend returns zero for a fresh install", () => {
  fresh();
  assert.strictEqual(monthSpend(), 0);
});

test("recordUsage accumulates monthly cost across multiple calls", () => {
  fresh();
  // glm-4.6: $0.60/1M in, $2.20/1M out
  recordUsage("glm", "glm-4.6", 1_000_000, 500_000);
  recordUsage("glm", "glm-4.6", 1_000_000, 500_000);
  const expected = 2 * costOf(1_000_000, 500_000, "glm-4.6");
  assert.ok(Math.abs(monthSpend() - expected) < 0.0001, `expected ~${expected}, got ${monthSpend()}`);
});

test("checkBudget returns ok when no limit is set", () => {
  fresh();
  recordUsage("glm", "glm-4.6", 1_000_000, 0);
  const b = checkBudget(0);
  assert.strictEqual(b.level, "ok");
  assert.strictEqual(b.pct, 0);
});

test("checkBudget warns at 80% threshold", () => {
  fresh();
  // glm-4.6 input: $0.60/1M → 3M tokens = $1.80
  // Set limit to $2.00 so $1.80 = 90% → warning
  recordUsage("glm", "glm-4.6", 3_000_000, 0);
  const b = checkBudget(2);
  assert.strictEqual(b.level, "warning");
  assert.ok(b.pct >= 0.8 && b.pct < 1);
});

test("checkBudget reports exceeded when spend passes the limit", () => {
  fresh();
  // gpt-4.1 input: $2/1M → 10M tokens = $20
  recordUsage("openai", "gpt-4.1", 10_000_000, 0);
  const b = checkBudget(10);
  assert.strictEqual(b.level, "exceeded");
  assert.strictEqual(b.pct, 1);
});

test("local model usage does not inflate budget (free pricing)", () => {
  fresh();
  recordUsage("local", "qwen2.5-7b.gguf", 5_000_000, 5_000_000);
  assert.strictEqual(monthSpend(), 0);
  const b = checkBudget(1);
  assert.strictEqual(b.level, "ok");
});

test("summarizeUsage includes budget block when limit is provided", () => {
  fresh();
  // glm-4.6: $0.60/1M in, $2.20/1M out → 2M in + 1M out = $1.20 + $2.20 = $3.40
  recordUsage("glm", "glm-4.6", 2_000_000, 1_000_000);
  const s = summarizeUsage("gpt-5.1", 5);
  assert.ok(s.budget, "summarizeUsage should include a budget object");
  // $3.40 / $5 = 0.68 → ok (below 80%)
  assert.ok(s.budget.spent > 0);
  assert.strictEqual(s.budget.limit, 5);
});

test("summarizeUsage triggers warning when budget is tight", () => {
  fresh();
  // glm-4.6: 1M in + 1M out → $0.60 + $2.20 = $2.80; limit $3.50 → 80%
  recordUsage("glm", "glm-4.6", 1_000_000, 1_000_000);
  const s = summarizeUsage("gpt-5.1", 3.5);
  assert.ok(s.budget.pct >= 0.8);
  assert.strictEqual(s.budget.level, "warning");
});

test("resetUsage clears monthly tracking", () => {
  fresh();
  recordUsage("glm", "glm-4.6", 1_000_000, 0);
  assert.ok(monthSpend() > 0);
  resetUsage();
  assert.strictEqual(monthSpend(), 0);
});
