import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { evaluateTradeGuard, normalizeTradeGuard, defaultTradeGuard } from "../src/trade-guard.js";
import { executeTool } from "../src/tools.js";

const ON = { enabled: true };
const order = (extra = {}) => ({ symbol: "NVDA", side: "buy", quantity: 5, orderType: "limit", limitPrice: 100, ...extra });

test("staging is denied by default until the user opts in", () => {
  assert.equal(evaluateTradeGuard(defaultTradeGuard(), order()).allowed, false);
  assert.match(evaluateTradeGuard({}, order()).reason, /off|turn on/i);
});

test("kill-switch halts all staging", () => {
  const v = evaluateTradeGuard({ enabled: true, killSwitch: true }, order());
  assert.equal(v.allowed, false);
  assert.match(v.reason, /kill-switch/i);
});

test("a valid order within guardrails is allowed and its notional is computed", () => {
  const v = evaluateTradeGuard(ON, order({ quantity: 3, limitPrice: 50 }));
  assert.equal(v.allowed, true);
  assert.equal(v.order.notionalUsd, 150);
});

test("guardrails block disallowed symbol, oversized notional, order count, and loss cap", () => {
  assert.match(evaluateTradeGuard({ enabled: true, symbolAllowlist: ["AAPL"] }, order()).reason, /not on the allowed/i);
  assert.match(evaluateTradeGuard({ enabled: true, maxNotionalUsd: 100 }, order({ quantity: 5, limitPrice: 100 })).reason, /exceeds the per-order cap/i);
  assert.match(evaluateTradeGuard({ enabled: true, maxOrdersPerDay: 3 }, order(), { ordersToday: 3 }).reason, /Daily staged-order limit/i);
  assert.match(evaluateTradeGuard({ enabled: true, dailyLossCapUsd: 200 }, order(), { realizedLossUsd: 250 }).reason, /loss cap/i);
});

test("malformed proposals are rejected", () => {
  assert.match(evaluateTradeGuard(ON, order({ side: "hold" })).reason, /Invalid side/i);
  assert.match(evaluateTradeGuard(ON, order({ quantity: 0 })).reason, /positive/i);
  assert.match(evaluateTradeGuard(ON, order({ orderType: "limit", limitPrice: 0 })).reason, /limit price/i);
});

test("normalizeTradeGuard uppercases the allowlist and clamps negatives", () => {
  const g = normalizeTradeGuard({ enabled: true, symbolAllowlist: ["nvda", " aapl "], maxNotionalUsd: -5 });
  assert.deepEqual(g.symbolAllowlist, ["NVDA", "AAPL"]);
  assert.equal(g.maxNotionalUsd, 0);
});

test("the stage_trade tool stages but never submits, and honors the guard", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-stage-"));
  const base = { config: { connectors: {} }, projectDir, approve: async () => true };
  try {
    // Disabled by default -> blocked, nothing staged.
    const off = await executeTool("stage_trade", order(), { ...base, config: { connectors: { trading: { enabled: false } } } });
    assert.match(off, /^blocked:/);

    // Enabled -> a clearly-unsubmitted staged proposal.
    const on = await executeTool("stage_trade",
      { symbol: "NVDA", side: "buy", quantity: 2, orderType: "limit", limitPrice: 120, rationale: "broke above 118 resistance" },
      { ...base, config: { connectors: { trading: { enabled: true } } } });
    assert.match(on, /NOT SUBMITTED/);
    assert.match(on, /BUY 2 NVDA/);
    assert.match(on, /broke above 118 resistance/);
    assert.doesNotMatch(on, /^error:/);
  } finally { fs.rmSync(projectDir, { recursive: true, force: true }); }
});

test("live browser trades are opt-in, never unattended, and always use explicit approval", async () => {
  const trade = {
    contract: "/MNQU26", side: "buy", quantity: 1, orderType: "limit",
    price: 28678, broker: "Robinhood Legend", finalButton: "Place order"
  };
  let approvals = 0;
  let clicks = 0;
  const ctx = {
    config: {
      ui: { aiBrowser: true, browserPerms: { tradeClicks: false, tradeConsentUser: "trader@example.com" } },
      cloudBackend: { sessionToken: "signed-in", user: { email: "trader@example.com" } }
    },
    approve: async () => { throw new Error("ordinary approval must not be used"); },
    approveAlways: async (summary, meta) => {
      approvals++;
      assert.match(summary, /BUY 1 \/MNQU26/);
      assert.match(summary, /LIMIT @ 28678/);
      assert.match(summary, /Robinhood Legend/);
      assert.equal(meta.kind, "trade");
      assert.equal(meta.trade.quantity, 1);
      return true;
    },
    visibleBrowser: async (command) => {
      clicks++;
      assert.equal(command.action, "click");
      assert.equal(command.text, "Place order");
      assert.equal(command.confirmedTrade.contract, "/MNQU26");
      return "clicked";
    }
  };

  assert.match(await executeTool("visible_browser_trade", trade, ctx), /off/i);
  assert.equal(approvals, 0);
  ctx.config.ui.browserPerms.tradeClicks = true;
  assert.equal(await executeTool("visible_browser_trade", trade, { ...ctx, unattended: true }), "blocked: live trades cannot run from scheduled or unattended work.");
  assert.equal(approvals, 0);
  assert.equal(await executeTool("visible_browser_trade", trade, ctx), "clicked");
  assert.equal(approvals, 1);
  assert.equal(clicks, 1);
});

test("live browser trading requires consent from the current signed-in Boolean user", async () => {
  const trade = { contract: "/MNQU26", side: "sell", quantity: 1, orderType: "market", broker: "Robinhood Legend", finalButton: "Place order" };
  const base = {
    ui: { aiBrowser: true, browserPerms: { tradeClicks: true, tradeConsentUser: "first@example.com" } },
    cloudBackend: { sessionToken: "session", user: { email: "second@example.com" } }
  };
  const result = await executeTool("visible_browser_trade", trade, {
    config: base,
    approveAlways: async () => { throw new Error("must not prompt"); },
    visibleBrowser: async () => { throw new Error("must not click"); }
  });
  assert.match(result, /risk agreement matches the current user/);
});

test("ordinary visible browser clicks cannot bypass the live-trade confirmation", async () => {
  let clicked = false;
  const result = await executeTool("visible_browser_click", { text: "Sell" }, {
    config: { ui: { aiBrowser: true, browserPerms: { tradeClicks: true } } },
    visibleBrowser: async () => { clicked = true; return "clicked"; }
  });
  assert.match(result, /possible live-trade control/);
  assert.equal(clicked, false);
});
