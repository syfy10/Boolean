import test from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../src/tools.js";

const TRADE = { contract: "NVDA", side: "buy", quantity: 10, orderType: "limit", price: 120, broker: "Robinhood", finalButton: "Place order" };

// A ctx that has already cleared tradeClicks + consent, so execution reaches the guard.
function ctxWith(trading, sinks = {}) {
  return {
    config: {
      ui: { aiBrowser: true, browserPerms: { tradeClicks: true, tradeConsentUser: "trader@example.com" } },
      cloudBackend: { sessionToken: "signed-in", user: { email: "trader@example.com" } },
      connectors: { trading }
    },
    approveAlways: sinks.approveAlways || (async () => { throw new Error("must not prompt when the guard blocks"); }),
    visibleBrowser: sinks.visibleBrowser || (async () => { throw new Error("must not click when the guard blocks"); })
  };
}

test("the kill-switch blocks a confirmed browser trade before any prompt or click", async () => {
  const out = await executeTool("visible_browser_trade", TRADE, ctxWith({ killSwitch: true }));
  assert.match(out, /^blocked:/);
  assert.match(out, /kill-switch/i);
});

test("a per-order notional cap blocks an oversized confirmed trade", async () => {
  const out = await executeTool("visible_browser_trade", TRADE, ctxWith({ maxNotionalUsd: 100 }));
  assert.match(out, /exceeds the per-order cap/i); // 10 * 120 = 1200 > 100
});

test("a symbol allowlist blocks a confirmed trade in a disallowed symbol", async () => {
  const out = await executeTool("visible_browser_trade", TRADE, ctxWith({ symbolAllowlist: ["AAPL"] }));
  assert.match(out, /not on the allowed/i);
});

test("a confirmed trade within the guardrails still goes through to the confirmed click", async () => {
  let prompted = false, clicked = false;
  const ctx = ctxWith({ maxNotionalUsd: 5000, symbolAllowlist: ["NVDA"] }, {
    approveAlways: async () => { prompted = true; return true; },
    visibleBrowser: async (cmd) => { clicked = true; assert.equal(cmd.text, "Place order"); return "clicked"; }
  });
  const out = await executeTool("visible_browser_trade", TRADE, ctx);
  assert.equal(out, "clicked");
  assert.ok(prompted, "the user is still asked to confirm");
  assert.ok(clicked, "the confirmed click still happens within the guardrails");
});

test("an unconfigured guard does not block the confirmed click (kill-switch/caps default off)", async () => {
  let clicked = false;
  const ctx = ctxWith(undefined, {
    approveAlways: async () => true,
    visibleBrowser: async () => { clicked = true; return "clicked"; }
  });
  const out = await executeTool("visible_browser_trade", TRADE, ctx);
  assert.equal(out, "clicked");
  assert.ok(clicked);
});
