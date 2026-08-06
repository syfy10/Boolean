import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { legendTradingDetailsFromPageText } from "../src/ui/trading-logic.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const shell = fs.readFileSync(path.join(root, "shell", "Program.cs"), "utf8").replace(/\r/g, "");

// The Legend panel parser is imported from src/ui/trading-logic.js above, so
// these cases run the shipped code rather than a re-evaluated copy of it.

test("Legend Positions and Recent orders populate trading context", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    ENPH $39.44 ▲ $1.90 (5.06%) B $39.43 x 100 A $39.44 x 80
    Recent orders Symbol Status Side Type Qty Realized P&L
    ENPH Filled Sell Market 250 ▲ $425.18
    ENPH Open Buy Limit 25 --
    Positions Symbol Qty Mkt val Mark Avg price Last 1D open P&L 1D open P&L % Open P&L Open P&L %
    ENPH 250 $9,860.03 $39.44 $37.34 $39.44 ▲ $475.03 ▲ 5.06% ▲ $525.03 ▲ 5.62%
  `, "ENPH");

  assert.equal(details.symbol, "ENPH");
  assert.equal(details.positionQty, 250);
  assert.equal(details.marketValue, 9860.03);
  assert.equal(details.avgPrice, 37.34);
  assert.equal(details.dayPnl, 475.03);
  assert.equal(details.dayPnlPercent, 5.06);
  assert.equal(details.openPnl, 525.03);
  assert.equal(details.openPnlPercent, 5.62);
  assert.equal(details.bid, 39.43);
  assert.equal(details.ask, 39.44);
  assert.equal(details.spread, 0.01);
  assert.equal(details.openOrders, 1);
});

test("down P&L values keep their negative direction", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read("Positions TSLA 10 $3,900.00 $390.00 $400.00 $390.00 ▼ $100.00 ▼ 2.50% ▼ $100.00 ▼ 2.50%", "TSLA");
  assert.equal(details.dayPnl, -100);
  assert.equal(details.dayPnlPercent, -2.5);
  assert.equal(details.openPnl, -100);
  assert.equal(details.openPnlPercent, -2.5);
});

test("Legend futures positions and open orders keep the slash contract", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    /MYMU26 53,418 ▲ 84 (0.16%)
    Recent orders Symbol Status Side Type Qty
    /MYMU26 Open Buy Limit 1
    Positions Symbol Qty Mkt val Mark Avg price Last 1D open P&L 1D open P&L % Open P&L Open P&L %
    /MYMU26 1 $53,418.00 $53,418.00 $53,300.00 $53,418.00 ▲ $84.00 ▲ 0.16% ▲ $118.00 ▲ 0.22%
  `, "/MYMU26");
  assert.equal(details.symbol, "/MYMU26");
  assert.equal(details.positionQty, 1);
  assert.equal(details.avgPrice, 53300);
  assert.equal(details.openPnl, 118);
  assert.equal(details.openOrders, 1);
});

test("Legend empty recent-orders state reports zero instead of a false open order", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    Recent orders Symbol Status Side Type Qty
    You don't have any orders from the last 24 hours. Trade /MYMU26
    Positions You don't have any /MYMU26 positions.
  `, "/MYMU26");
  assert.equal(details.openOrders, 0);
});

test("the compact bar wires position, P&L, spread, orders, and freshness", () => {
  for (const id of ["tbFresh", "tbPosition", "tbDayPnl", "tbOpenPnl", "tbSpread", "tbOpenOrders"]) {
    assert.match(ui, new RegExp(`id="${id}"`));
  }
  assert.match(ui, /renderLegendTradingDetails\(pageQuote\.legend,lastPageQuoteAt\)/);
  assert.match(ui, /lastLegendDetails=\{\.\.\.prior,\.\.\.details\}/);
  assert.match(ui, /Position sync failed — retrying/);
  assert.match(ui, /const TRADING_STALE_MS=12000/);
  assert.match(ui, /fresh\.classList\.toggle\("stale",stale&&Number\.isFinite\(age\)\)/);
  // Placeholders read as the sentence the line makes, so the labels carry
  // their own units instead of a "Pos"/"Day" prefix column.
  assert.match(ui, /id="tbPosition">flat<\/span>/);
  assert.match(ui, /id="tbDayPnl">day --<\/span>/);
  assert.match(ui, /id="tbOpenPnl">--<\/span>/);
  assert.match(ui, /id="tbSpread">spread --<\/span>/);
  assert.match(ui, /id="tbOpenOrders">open orders --<\/span>/);
});

test("saved Trading access reopens Robinhood only from an empty native browser", () => {
  assert.match(ui, /const emptyBrowser=!currentBrowserUrl\|\|\/\^\(\?:about:blank\|edge:/);
  assert.match(ui, /if\(SHELL&&emptyBrowser&&!browserOpen\(\)&&!tradingBrokerAutoOpened\)/);
  assert.match(ui, /await openRobinhoodBrowser\(\)/);
  assert.match(ui, /robinhood\\\.com\\\/legend/);
  assert.match(ui, /"Open desktop"/);
});

test("the top of book is read whether Legend abbreviates it or spells it out", () => {
  const read = legendTradingDetailsFromPageText;
  // The compact strip, which was the only form recognised.
  const compact = read("ENPH $39.44 B $39.43 x 100 A $39.44 x 80", "ENPH");
  assert.equal(compact.bid, 39.43);
  assert.equal(compact.ask, 39.44);
  assert.equal(compact.spread, 0.01);

  // The wide form. A layout showing this reported "spread --" forever.
  const spelled = read("ENPH $40.01 Bid 40.00 Ask 40.02 Volume 2899.00", "ENPH");
  assert.equal(spelled.bid, 40);
  assert.equal(spelled.ask, 40.02);
  assert.equal(spelled.spread, 0.02);

  // A chart widget showing OHLC only genuinely has no spread to report, and
  // must not invent one out of the O and C values.
  const ohlcOnly = read("ENPH $40.01 O 40.05 H 40.05 L 40.01 C 40.01 V 2899.00", "ENPH");
  assert.equal(ohlcOnly.bid, undefined);
  assert.equal(ohlcOnly.spread, undefined);
});

// The bar's expandable panel shows the account's own tables, so the parser has
// to return every row rather than only the one matching the visible symbol.
test("every position row is read, not just the visible symbol's", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    Positions Symbol Qty Mkt val Mark Avg price Last 1D open P&L 1D open P&L % Open P&L Open P&L %
    ENPH 250 $9,860.03 $39.44 $37.34 $39.44 ▲ $475.03 ▲ 5.06% ▲ $525.03 ▲ 5.62%
    AAPL 100 $23,150.00 $231.50 $240.00 $231.50 ▼ $310.00 ▼ 1.32% ▼ $850.00 ▼ 3.54%
  `, "ENPH");

  assert.equal(details.positions.length, 2);
  assert.deepEqual(details.positions.map((row) => row.symbol), ["ENPH", "AAPL"]);
  // A losing row keeps its direction.
  const aapl = details.positions[1];
  assert.equal(aapl.qty, 100);
  assert.equal(aapl.openPnl, -850);
  assert.equal(aapl.openPnlPercent, -3.54);
  // And the visible symbol still drives the bar's own summary line.
  assert.equal(details.positionQty, 250);
  assert.equal(details.openPnl, 525.03);
});

test("current compact Legend position rows sync automatically", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    Positions Symbol Mark Quantity Avg price 1D open P&L
    UPWK $9.68 1,000 $13.55 ▼ $3,870.00
    SPCX $116.31 1 $135.00 ▼ $18.69
    SOFI $18.50 300 $7.27 ▲ $3,369.00
    Recent orders Symbol Status Side Type Qty
    SPY Working Buy Limit 1
  `, "UPWK");

  assert.equal(details.positionSyncOk, true);
  assert.equal(details.positionSyncFailed, undefined);
  assert.deepEqual(details.positions.map((row) => row.symbol), ["UPWK", "SPCX", "SOFI"]);
  assert.equal(details.positions[0].qty, 1000);
  assert.equal(details.positions[0].mark, 9.68);
  assert.equal(details.positions[0].avgPrice, 13.55);
  assert.equal(details.positions[0].openPnl, -3870);
  assert.equal(details.positionQty, 1000);
});

test("a visible but unreadable Positions widget is a retry, not an empty account", () => {
  const read = legendTradingDetailsFromPageText;
  const failed = read("Positions Symbol Mark Quantity Avg price 1D open P&L", "SPY");
  assert.equal(failed.positionSyncFailed, true);
  assert.equal(failed.positions, undefined);
  const empty = read("Positions You don't have any open positions", "SPY");
  assert.equal(empty.positionSyncOk, true);
  assert.deepEqual(empty.positions, []);
});

test("recent orders are read as rows, not just counted", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read(`
    Recent orders Symbol Status Side Type Qty Realized P&L Avg fill price Submitted
    SPY Canceled Buy Limit 1 -- -- Aug 4 13:47:07
    ENPH Filled Sell Market 250 ▲ $425.18 $39.44 Aug 4 12:15:02
    ENPH Open Buy Limit 25 -- -- Aug 4 13:55:11
  `, "ENPH");

  assert.equal(details.orders.length, 3);
  assert.deepEqual(details.orders.map((row) => [row.symbol, row.status, row.side, row.type, row.qty]), [
    ["SPY", "Canceled", "Buy", "Limit", 1],
    ["ENPH", "Filled", "Sell", "Market", 250],
    ["ENPH", "Open", "Buy", "Limit", 25]
  ]);
  assert.equal(details.orders[1].fill, 425.18);
  assert.match(details.orders[0].at, /Aug 4 13:47/);
  // The count now comes from the rows. The old loose scan matched any
  // ticker-ish word followed by a live status, and the table's own "Submitted"
  // column header satisfied that — so a page of nothing but cancelled orders
  // reported one working, and the bar offered to cancel it.
  assert.equal(details.openOrders, 1);
});

test("column headers cannot be counted as working orders", () => {
  const read = legendTradingDetailsFromPageText;
  const header = "Recent orders Symbol Status Side Type Qty Realized P&L Avg fill price Submitted Total cost/credit";
  const details = read(`${header} SPY Canceled Buy Limit 1 -- -- Aug 4 13:47:07 -- SPY Canceled Buy Limit 1 -- -- Aug 4 13:32:04 --`, "SPY");
  assert.equal(details.orders.length, 2);
  assert.equal(details.openOrders, 0, "two cancelled orders are zero working orders");
});

test("an empty orders panel reports empty rather than stale rows", () => {
  const read = legendTradingDetailsFromPageText;
  const details = read("Recent orders You don't have any SPY orders from the last 24 hours.", "SPY");
  assert.equal(details.openOrders, 0);
  assert.deepEqual(details.orders, []);
});

test("Legend parsing remains display-only and does not place trades", () => {
  const start = ui.indexOf("function legendTradingDetailsFromPageText");
  const end = ui.indexOf("async function readQuoteFromVisiblePage", start);
  const parser = ui.slice(start, end);
  assert.doesNotMatch(parser, /\b(?:fetch|hostPost)\s*\(|\.click\s*\(|\.submit\s*\(/i);
});

test("the shell preserves repeated accessibility cells in position rows", () => {
  const readerStart = shell.indexOf("async Task<string> ReadBrowserAccessibilityTextAsync");
  const readerEnd = shell.indexOf("// ── acting on controls", readerStart);
  const reader = shell.slice(readerStart, readerEnd);
  assert.doesNotMatch(reader, /!seen\.Add\(text\)/);
  assert.match(reader, /Repeated cell values are meaningful in trading tables/);
});
