import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { rollDaily, applyPlacement, applyResult, currentTradeState, recordTradePlacement, recordTradeResult } from "../src/trade-ledger.js";
import { executeTool } from "../src/tools.js";

const TODAY = "2026-08-02";

test("rollDaily resets counters when the day changes and sanitizes otherwise", () => {
  assert.deepEqual(rollDaily({ date: "2026-08-01", ordersToday: 5, realizedLossUsd: 200 }, TODAY), { date: TODAY, ordersToday: 0, realizedLossUsd: 0 });
  assert.deepEqual(rollDaily({ date: TODAY, ordersToday: 3, realizedLossUsd: 50 }, TODAY), { date: TODAY, ordersToday: 3, realizedLossUsd: 50 });
});

test("applyPlacement counts orders; applyResult accumulates only losses", () => {
  let l = applyPlacement({ date: TODAY, ordersToday: 0, realizedLossUsd: 0 }, TODAY);
  l = applyPlacement(l, TODAY);
  assert.equal(l.ordersToday, 2);
  l = applyResult(l, -120.5, TODAY);
  l = applyResult(l, 80, TODAY); // a gain does not offset the loss cap
  assert.equal(l.realizedLossUsd, 120.5);
});

test("the ledger persists and reloads through a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-ledger-"));
  try {
    recordTradePlacement(dir);
    recordTradePlacement(dir);
    recordTradeResult(dir, -75);
    assert.deepEqual(currentTradeState(dir), { ordersToday: 2, realizedLossUsd: 75 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("record_trade_result tool feeds the daily loss and reports cap status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-ledger-tool-"));
  const ctx = { sazDir: dir, config: { connectors: { trading: { dailyLossCapUsd: 200 } } } };
  try {
    assert.match(await executeTool("record_trade_result", { realizedPnlUsd: -120, note: "closed NVDA" }, ctx), /Realized loss today: \$120/);
    const out = await executeTool("record_trade_result", { realizedPnlUsd: -100 }, ctx);
    assert.match(out, /REACHED/, "crossing the cap is reported");
    assert.equal(currentTradeState(dir).realizedLossUsd, 220);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a confirmed browser trade increments the daily order count, and the cap then blocks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-ledger-trade-"));
  const trade = { contract: "NVDA", side: "buy", quantity: 1, orderType: "limit", price: 100, broker: "RH", finalButton: "Place order" };
  const ctx = {
    sazDir: dir,
    config: {
      ui: { aiBrowser: true, browserPerms: { tradeClicks: true, tradeConsentUser: "u@e.com" } },
      cloudBackend: { sessionToken: "s", user: { email: "u@e.com" } },
      connectors: { trading: { maxOrdersPerDay: 2 } }
    },
    approveAlways: async () => true,
    visibleBrowser: async () => "clicked"
  };
  try {
    assert.equal(await executeTool("visible_browser_trade", trade, ctx), "clicked");
    assert.equal(await executeTool("visible_browser_trade", trade, ctx), "clicked");
    assert.equal(currentTradeState(dir).ordersToday, 2);
    const third = await executeTool("visible_browser_trade", trade, ctx);
    assert.match(third, /^blocked:/);
    assert.match(third, /Daily staged-order limit reached/i);
    assert.equal(currentTradeState(dir).ordersToday, 2, "the blocked trade was not counted");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sync_trade_pnl pulls a loss from the connector and sets the daily loss cap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-pnl-"));
  const ctx = {
    sazDir: dir,
    config: { connectors: { trading: { dailyLossCapUsd: 300, pnl: { connector: "RH", tool: "get_accounts", path: "result.realized_pnl_today" } } } },
    mcpCall: async () => ({ result: { realized_pnl_today: -250 } })
  };
  try {
    const out = await executeTool("sync_trade_pnl", {}, ctx);
    assert.match(out, /loss \$250/);
    assert.equal(currentTradeState(dir).realizedLossUsd, 250);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sync_trade_pnl is fail-closed: an unreadable P&L leaves the cap unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-pnl-fail-"));
  recordTradeResult(dir, -180); // an existing tripped-ish loss
  const ctx = {
    sazDir: dir,
    config: { connectors: { trading: { dailyLossCapUsd: 200, pnl: { connector: "RH", tool: "get_accounts", path: "result.realized_pnl_today" } } } },
    mcpCall: async () => ({ result: { something_else: "n/a" } }) // no number at the path
  };
  try {
    const out = await executeTool("sync_trade_pnl", {}, ctx);
    assert.match(out, /UNCHANGED \(fail-closed\)/);
    assert.equal(currentTradeState(dir).realizedLossUsd, 180, "the existing loss is preserved, not zeroed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sync_trade_pnl never lowers an already-recorded loss (a gain can't re-open a tripped cap)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-pnl-gain-"));
  recordTradeResult(dir, -260);
  const ctx = {
    sazDir: dir,
    config: { connectors: { trading: { dailyLossCapUsd: 250, pnl: { connector: "RH", tool: "get_accounts", path: "pnl" } } } },
    mcpCall: async () => ({ pnl: 40 }) // a gain
  };
  try {
    await executeTool("sync_trade_pnl", {}, ctx);
    assert.equal(currentTradeState(dir).realizedLossUsd, 260, "recorded loss is not lowered by a later gain");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
