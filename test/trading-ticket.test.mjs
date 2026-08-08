import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTradeGuard, normalizeTradeGuard, defaultTradeGuard, bracketRisk } from "../src/trade-guard.js";
import { normalizeTicketFields, tradeClickPermission } from "../src/server.js";
import { correctSharePrice } from "../src/ui/ticket.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const shell = fs.readFileSync(path.join(root, "shell", "Program.cs"), "utf8").replace(/\r/g, "");

const ON = { enabled: true };
const buy = (extra = {}) => ({ symbol: "ENPH", side: "buy", quantity: 100, orderType: "market", referencePrice: 40, ...extra });

// ── bracket math ───────────────────────────────────────────────────────

test("a bracket prices its own risk and reward from the entry", () => {
  const math = bracketRisk({ side: "buy", quantity: 100, entryPrice: 40, stopPrice: 38, targetPrice: 45 });
  assert.equal(math.riskUsd, 200);
  assert.equal(math.rewardUsd, 500);
  assert.equal(math.riskRewardRatio, 2.5);
  assert.equal(math.stopSideOk, true);
  assert.equal(math.targetSideOk, true);
});

// A protective exit is the common case in the bar: you are long and the ticket
// sells to close, but the stop and target still describe the long you hold.
test("a closing order's bracket follows the position, not the order side", () => {
  const exit = { side: "sell", quantity: 250, entryPrice: 39.56, stopPrice: 38.1, targetPrice: 42, reducesPosition: true };
  const math = bracketRisk(exit);
  assert.equal(math.long, true);
  assert.equal(math.stopSideOk, true);
  assert.equal(math.targetSideOk, true);
  assert.equal(math.riskUsd, 365);
  assert.equal(math.rewardUsd, 610);
  assert.equal(math.riskRewardRatio, 1.67);
  // The same prices opening a fresh short would be upside down.
  const opening = bracketRisk({ ...exit, reducesPosition: false });
  assert.equal(opening.long, false);
  assert.equal(opening.stopSideOk, false);
});

test("a short's bracket is the mirror of a long's", () => {
  const short = bracketRisk({ side: "sell", quantity: 10, entryPrice: 100, stopPrice: 105, targetPrice: 90 });
  assert.equal(short.riskUsd, 50);
  assert.equal(short.rewardUsd, 100);
  assert.equal(short.stopSideOk, true);
  assert.equal(short.targetSideOk, true);
  // The same prices on a buy are upside down.
  const wrong = bracketRisk({ side: "buy", quantity: 10, entryPrice: 100, stopPrice: 105, targetPrice: 90 });
  assert.equal(wrong.stopSideOk, false);
  assert.equal(wrong.targetSideOk, false);
});

test("an incomplete bracket prices only the leg it has", () => {
  const stopOnly = bracketRisk({ side: "buy", quantity: 5, entryPrice: 20, stopPrice: 18 });
  assert.equal(stopOnly.riskUsd, 10);
  assert.equal(stopOnly.rewardUsd, 0);
  assert.equal(stopOnly.riskRewardRatio, 0);
  assert.deepEqual(bracketRisk({}), { riskUsd: 0, rewardUsd: 0, riskRewardRatio: 0, stopSideOk: true, targetSideOk: true, long: false });
});

// ── the guard ──────────────────────────────────────────────────────────

test("the guard reports the bracket it was given", () => {
  const verdict = evaluateTradeGuard(ON, buy({ stopPrice: 38, targetPrice: 46 }));
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.order.riskUsd, 200);
  assert.equal(verdict.order.rewardUsd, 600);
  assert.equal(verdict.order.riskRewardRatio, 3);
});

test("a stop or target on the wrong side of the entry is rejected", () => {
  assert.match(evaluateTradeGuard(ON, buy({ stopPrice: 42 })).reason, /stop must sit below/i);
  assert.match(evaluateTradeGuard(ON, buy({ targetPrice: 38 })).reason, /target must sit above/i);
  const sell = { symbol: "ENPH", side: "sell", quantity: 100, orderType: "market", referencePrice: 40 };
  assert.match(evaluateTradeGuard(ON, { ...sell, stopPrice: 38 }).reason, /stop must sit above/i);
  assert.match(evaluateTradeGuard(ON, { ...sell, targetPrice: 42 }).reason, /target must sit below/i);
  // The message names the exposure being protected, which is what the prices
  // describe — a closing sell is judged as the long it is unwinding.
  assert.match(evaluateTradeGuard(ON, { ...sell, stopPrice: 42, reducesPosition: true }).reason, /long position's stop must sit below/i);
});

test("the per-trade risk cap blocks an oversized stop distance", () => {
  const guard = { enabled: true, maxRiskPerTradeUsd: 150 };
  assert.match(evaluateTradeGuard(guard, buy({ stopPrice: 38 })).reason, /exceeds the per-trade risk cap/i);
  assert.equal(evaluateTradeGuard(guard, buy({ stopPrice: 39 })).allowed, true);
});

test("a risk cap without a stop cannot be checked, so it is refused", () => {
  const verdict = evaluateTradeGuard({ enabled: true, maxRiskPerTradeUsd: 150 }, buy());
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /needs a stop price/i);
});

// This is what the bracket buys you: the daily cap can bite before the order
// exists rather than after record_trade_result reports the damage.
test("a stop-out that would breach the daily loss cap is blocked up front", () => {
  const guard = { enabled: true, dailyLossCapUsd: 200 };
  const verdict = evaluateTradeGuard(guard, buy({ stopPrice: 37 }), { realizedLossUsd: 0 });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /past the daily cap/i);
  // Losses already taken today count against the same budget.
  assert.match(evaluateTradeGuard(guard, buy({ stopPrice: 39 }), { realizedLossUsd: 150 }).reason, /past the daily cap/i);
  assert.equal(evaluateTradeGuard(guard, buy({ stopPrice: 39 }), { realizedLossUsd: 50 }).allowed, true);
});

test("closing a position is never blocked by a risk ceiling", () => {
  const guard = { enabled: true, maxRiskPerTradeUsd: 10, dailyLossCapUsd: 200 };
  const exit = { symbol: "ENPH", side: "sell", quantity: 250, orderType: "market", referencePrice: 39.56,
    stopPrice: 38.1, targetPrice: 42, reducesPosition: true };
  const verdict = evaluateTradeGuard(guard, exit, { realizedLossUsd: 190 });
  assert.equal(verdict.allowed, true, verdict.reason);
  assert.equal(verdict.order.reducesPosition, true);
  // The same order treated as new exposure would not survive either cap.
  assert.equal(evaluateTradeGuard(guard, { ...exit, reducesPosition: false }, { realizedLossUsd: 190 }).allowed, false);
});

test("a loss cap already reached still halts everything, bracket or not", () => {
  const guard = { enabled: true, dailyLossCapUsd: 200 };
  assert.match(evaluateTradeGuard(guard, buy({ stopPrice: 39.9 }), { realizedLossUsd: 200 }).reason, /loss cap reached/i);
});

test("the risk cap normalizes and defaults to off", () => {
  assert.equal(defaultTradeGuard().maxRiskPerTradeUsd, 0);
  assert.equal(normalizeTradeGuard({ maxRiskPerTradeUsd: -5 }).maxRiskPerTradeUsd, 0);
  assert.equal(normalizeTradeGuard({ maxRiskPerTradeUsd: "250" }).maxRiskPerTradeUsd, 250);
});

test("brackets stay optional — an order without one behaves as before", () => {
  const verdict = evaluateTradeGuard(ON, buy());
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.order.riskUsd, 0);
  assert.equal(verdict.order.notionalUsd, 4000);
});

// ── the per-share price read ───────────────────────────────────────────


// The bug this exists for: a Positions table rendered above the quote puts the
// market-value column first, so a 250-share position read as a $9,890 share
// price — and every risk number downstream is then 250x wrong.
test("the market-value column is not mistaken for a share price", () => {
  const correct = correctSharePrice;
  const quote = correct({ symbol: "ENPH", price: 9890 }, { positionQty: 250, marketValue: 9890, mark: 39.56 });
  assert.equal(quote.price, 39.56);
  // The tooltip names the rule that produced the number, so the next price
  // that looks wrong can be diagnosed by hovering rather than by guessing.
  assert.equal(quote.priceSource, "Positions mark column");
});

test("a plausible headline price is left alone", () => {
  const correct = correctSharePrice;
  // The chart headline ticks ahead of the Positions row all the time; a small
  // disagreement must not pin the bar to the slower number.
  const quote = correct({ symbol: "ENPH", price: 39.61 }, { positionQty: 250, marketValue: 9890, mark: 39.56 });
  assert.equal(quote.price, 39.61);
  assert.equal(quote.priceSource, undefined);
});

test("a price with no Positions row to check against is left alone", () => {
  const correct = correctSharePrice;
  assert.equal(correct({ symbol: "AAPL", price: 231.4 }, {}).price, 231.4);
  assert.equal(correct({ symbol: "AAPL", price: 231.4 }, { mark: 0 }).price, 231.4);
});

// ── ticket wiring ──────────────────────────────────────────────────────

test("the bar is four lines and the ticket carries side, qty, type, and bracket", () => {
  for (const line of ["tb-line-hold", "tb-line-limits", "tb-line-ticket", "tb-line-risk"]) {
    assert.match(ui, new RegExp(`class="tb-line ${line}"`));
  }
  for (const id of ["tbSideBuy", "tbSideSell", "tbQty", "tbQtyUp", "tbQtyDown", "tbOrderType", "tbTif",
    "tbTrigger", "tbLimit", "tbTrail", "tbStop", "tbTarget", "tbCost", "tbEffect", "tbDescribe",
    "tbRiskLoss", "tbRiskGain", "tbRiskRatio", "tbGuard", "tbMore", "tbMorePanel", "tbSend"]) {
    assert.match(ui, new RegExp(`id="${id}"`), `${id} is missing from the trading bar`);
  }
  // Everything set once per account lives behind More so the bar stays four
  // lines while carrying the broker's whole ticket.
  for (const id of ["tbPositionEffect", "tbInstruction", "tbExchange", "tbTaxLot", "tbAccountName",
    "tbSubmitAt", "tbSubmitOn", "tbCancelAt", "tbCancelOn"]) {
    assert.match(ui, new RegExp(`id="${id}"`), `${id} is missing from the More panel`);
  }
  assert.match(ui, /id="tbMorePanel" hidden/, "the More panel starts closed");
  // Send starts disabled and is only enabled by a server verdict.
  assert.match(ui, /id="tbSend" type="button" disabled/);
});

test("the compact ticket has a hard pane floor and dense resize rules", () => {
  assert.match(shell, /const int chatMin = 520;/);
  const compact = ui.slice(ui.indexOf("@container(max-width:560px)"), ui.indexOf("\n  }", ui.indexOf("@container(max-width:560px)")) + 4);
  assert.match(compact, /\.trading-bar\{ gap:4px; padding:6px 8px; \}/);
  assert.match(compact, /#tbBook,[\s\S]*?#tbRange/);
  assert.match(compact, /\.tb-risk-loss,[\s\S]*?\.tb-ratio\{ display:none; \}/);
});

test("the ticket runs on the page-read loop, not the model", () => {
  const start = ui.indexOf("  // ── Order ticket ─");
  const end = ui.indexOf("  function startTradingBarTicker()", start);
  assert.ok(start >= 0 && end > start, "ticket module not found");
  const ticket = ui.slice(start, end);
  // Its inputs are the same page-read values the rest of the bar already has.
  assert.match(ticket, /lastQuotePrice/);
  assert.match(ticket, /lastLegendDetails/);
  assert.match(ticket, /lastStrategySignal/);
  // And it never asks a model for anything.
  assert.doesNotMatch(ticket, /sendMessage\(|askAI\(|\/api\/(?:chat|run|agent)\b/);
  assert.match(ui, /void refreshTradingBar\(\);\s*\},5000\)/);
});

test("a ticket send re-checks the guard against the server before it types", () => {
  const start = ui.indexOf("  async function sendTicket()");
  const end = ui.indexOf("  function bindTicket()", start);
  assert.ok(start >= 0 && end > start, "sendTicket not found");
  const send = ui.slice(start, end);
  const check = send.indexOf("/api/trading/ticket/check");
  const firstControl = send.indexOf("runBrowserControl(");
  const firstAttempt = send.indexOf('attempt("');
  assert.ok(check >= 0, "sendTicket does not re-check the guard");
  assert.ok(check < firstControl && check < firstAttempt,
    "the guard must be re-checked before anything is typed or clicked");
  assert.match(send, /if\(!verdict\?\.canSend\)/);
  assert.match(send, /\/api\/trading\/ticket\/placed/);
  // Side before quantity: most order forms only reveal the quantity and
  // bracket fields once a side is chosen.
  assert.ok(send.indexOf('action:"select_order_side"') < send.indexOf('await fill("quantity"'),
    "the side must be chosen before any field is filled");
  assert.doesNotMatch(send, /attempt\("click",payload\.side===\"buy\"\?fields\.buy:fields\.sell\)/,
    "side selection must not fuzzy-match immediate market-order buttons");
});

// The bug: the guard was only re-asked when a ticket field was edited, so
// pressing Arm left the previous "auto-disarmed" verdict on screen with Send
// greyed out — a bar reading "Armed 27m" beside "trade clicks have
// auto-disarmed", refusing to send an order it would have allowed.
test("a verdict is retired when the rails around the ticket change", () => {
  const start = ui.indexOf("  function ticketCheckSignature()");
  const end = ui.indexOf("\n  }", start);
  assert.ok(start >= 0 && end > start, "ticketCheckSignature not found");
  const signature = ui.slice(start, end);
  // Arming, the kill-switch and today's counters all change the answer, so
  // they all have to be part of what the cached answer is keyed on.
  for (const field of ["armed", "killSwitch", "ordersToday", "realizedLossUsd", "dailyLossCapUsd"]) {
    assert.match(signature, new RegExp(`state\\.${field}`), `${field} does not retire a stale verdict`);
  }
  // And the ticket itself.
  for (const field of ["quantity", "stopPrice", "side"]) {
    assert.match(signature, new RegExp(`payload\\.${field}`));
  }

  const render = ui.slice(ui.indexOf("  function renderTicket(quote)"), ui.indexOf("  // Size the order so a stop-out costs"));
  assert.match(render, /ticketCheckSignature\(\)!==ticketCheckedSignature/);
  // A stale verdict must be cleared, not merely refreshed alongside — showing
  // "checking…" beats showing an answer that contradicts the Arm button.
  assert.match(render, /ticketCheck=null;\s*scheduleTicketCheck\(0\);/);
});

test("the ticket resets when the symbol changes", () => {
  assert.match(ui, /normalizeSymbolInput\(symbol\)!==normalizeSymbolInput\(ticketState\.symbol\)\)\{\s*ticketState=emptyTicket\(\);/);
});

test("a field the user typed into is never overwritten by the refresh", () => {
  const start = ui.indexOf("  function prefillTicket(");
  const end = ui.indexOf("\n  function renderTicketInputs(", start);
  const prefill = ui.slice(start, end);
  for (const field of ["side", "qty", "stop", "target"]) {
    assert.match(prefill, new RegExp(`touched\\.${field}`), `${field} can be clobbered mid-edit`);
  }
});

test("ticket field labels are bounded and default to nothing", () => {
  assert.deepEqual(normalizeTicketFields({}), {});
  // One label or a list of them, since brokers name the same control
  // differently and the built-in guesses will not cover every form.
  assert.deepEqual(normalizeTicketFields({ quantity: " Shares ", nonsense: "x" }), { quantity: ["Shares"] });
  assert.deepEqual(normalizeTicketFields({ place: ["Review order", " Place ", ""] }), { place: ["Review order", "Place"] });
  assert.equal(normalizeTicketFields({ place: "x".repeat(400) }).place[0].length, 120);
  assert.equal(normalizeTicketFields({ place: Array.from({ length: 20 }, (_, i) => `b${i}`) }).place.length, 6);
});

// Legend's final button is "Buy SPY", not "Place order", and its order type is
// a dropdown rather than a text field — so a fixed label list could never
// finish a ticket, and a limit order could not be set up at all.
test("labels expand per ticket, and the order type is a dropdown", () => {
  const start = ui.indexOf("  const TICKET_FIELD_DEFAULTS=");
  const end = ui.indexOf("\n  const ticketNumber=", start);
  const block = ui.slice(start, end);
  const ticketFields = new Function("lastTradingBarState", `${block}\nreturn ticketFields;`)({ ticketFields: {} });

  const buy = ticketFields({ symbol: "SPY", side: "buy" });
  assert.equal(buy.place[0], "Buy SPY");
  assert.ok(buy.place.includes("Place order"), "the generic fallbacks survive");
  const sell = ticketFields({ symbol: "ENPH", side: "sell" });
  assert.equal(sell.place[0], "Sell ENPH");
  assert.ok(sell.place.includes("Short ENPH"));
  // Legend opens a short with "Short" and closes a long with "Sell".
  assert.deepEqual(sell.sell, ["Sell", "Short"]);
  // An unexpanded placeholder must never be searched for literally.
  for (const label of ticketFields({}).place) assert.doesNotMatch(label, /[{}]/);

  const send = ui.slice(ui.indexOf("  async function sendTicket()"), ui.indexOf("  function bindTicket()"));
  assert.match(send, /selectPicker\(fields\.orderType,/);
  assert.match(send, /TICKET_ORDER_TYPE_OPTIONS\[payload\.orderType\]/);
  assert.match(send, /selectPicker\(fields\.timeInForce,/);
  assert.match(send, /TICKET_TIF_OPTIONS\[payload\.timeInForce\]/);
  // A type's price inputs only exist once the ticket is in that mode.
  assert.ok(send.indexOf("selectPicker(fields.orderType") < send.indexOf("ticketOrderPrices(payload)"),
    "the order type must be switched before its prices are typed");
  // Market and Day are every broker's defaults; reaching for those dropdowns
  // to confirm them is a step that can only fail.
  assert.match(send, /if\(payload\.orderType!=="market"&&typeLabel\)/);
  assert.match(send, /if\(payload\.timeInForce&&payload\.timeInForce!=="day"\)/);
});

// The failure that produced "it says sending but nothing was sent": the shell
// ran the click script, the script threw because no element matched, and
// ExecuteScriptAsync swallowed that into "null" — which the old code turned
// into the action name and reported as ok:true. Every step "succeeded" and no
// order existed.
test("a browser control script that throws is reported as a failure", () => {
  const shell = fs.readFileSync(path.join(root, "shell", "Program.cs"), "utf8").replace(/\r/g, "");
  const start = shell.indexOf("async Task ExecuteBrowserControlAsync");
  const end = shell.indexOf("\n    }", shell.indexOf("PostToChat(new { type = \"browserControlResult\", id, ok = true, url = t.Url, result = result", start));
  const body = shell.slice(start, end);
  assert.match(body, /catch\(e\)\{return JSON\.stringify\(\{ok:false,error:/);
  // Legend keeps its controls in React portals, shadow roots and frames, where
  // a top-frame querySelectorAll sees nothing — so acting on a control tries
  // the accessibility tree first, the same surface the page reader uses.
  assert.match(body, /TryAccessibilityActionAsync\(t, action, command\)/);
  assert.ok(body.indexOf("TryAccessibilityActionAsync") < body.indexOf('else if (action == "click")'),
    "the accessibility path must be tried before the DOM scan");
  assert.match(shell, /const string AxTypeFunction[\s\S]*?getOwnPropertyDescriptor\(proto,'value'\)/,
    "React ignores a plain value assignment; the native setter is required");
  assert.match(shell, /"Accessibility\.getFullAXTree"[\s\S]*?"DOM\.resolveNode"/);
  assert.match(body, /ok = false;/);
  assert.match(body, /PostToChat\(new \{ type = "browserControlResult", id, ok = false/);
  // And the old silent fallback is gone.
  assert.doesNotMatch(body, /JsonSerializer\.Deserialize<string>\(resultJson\) \?\? action/);
});

// ── cancelling ─────────────────────────────────────────────────────────

test("cancelling needs the same click consent as sending", () => {
  const armed = {
    ui: { browserPerms: { tradeClicks: true, tradeConsentUser: "s10@outlook.com", tradeConsentAt: Date.now() } },
    cloudBackend: { sessionToken: "t", user: { email: "s10@outlook.com", role: "admin" } }
  };
  assert.equal(tradeClickPermission(armed).canClick, true);

  const off = { ...armed, ui: { browserPerms: { ...armed.ui.browserPerms, tradeClicks: false } } };
  assert.equal(tradeClickPermission(off).canClick, false);
  assert.match(tradeClickPermission(off).reason, /trade clicks is off/i);

  const lapsed = { ...armed, ui: { browserPerms: { ...armed.ui.browserPerms, tradeConsentAt: Date.now() - 999_999_999 } } };
  assert.equal(tradeClickPermission(lapsed).canClick, false);
  assert.match(tradeClickPermission(lapsed).reason, /auto-disarmed/i);

  const otherUser = { ...armed, cloudBackend: { sessionToken: "t", user: { email: "someone@else.com", role: "admin" } } };
  assert.equal(tradeClickPermission(otherUser).canClick, false);
  const nonAdmin = { ...armed, cloudBackend: { sessionToken: "t", user: { email: "s10@outlook.com", role: "user" } } };
  assert.equal(tradeClickPermission(nonAdmin).canClick, false);
  assert.match(tradeClickPermission(nonAdmin).reason, /administrator/i);
});

// A resting order is exposure. Refusing to cancel while the kill-switch is on
// would trap the user in the thing the halt was meant to escape, so cancelling
// is deliberately outside the guard — same reasoning as exempting closing
// orders from the risk ceilings.
test("cancelling is not gated on the kill-switch or the risk caps", () => {
  const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8").replace(/\r/g, "");
  const start = server.indexOf('p === "/api/trading/cancel/check"');
  const block = server.slice(server.lastIndexOf("//", start) - 600, start + 400);
  assert.match(block, /NOT gated on the kill-switch/i);
  const handler = server.slice(start, start + 400);
  assert.doesNotMatch(handler, /killSwitch|evaluateTradeGuard|dailyLossCapUsd|maxRiskPerTradeUsd/);
  assert.match(handler, /tradeClickPermission\(config\)/);
});

test("cancel is only offered when the page shows working orders", () => {
  assert.match(ui, /id="tbCancel"[^>]*hidden/, "the button must start hidden, not disabled-looking");
  const start = ui.indexOf("  function renderCancelButton()");
  const end = ui.indexOf("\n  async function cancelWorkingOrders()", start);
  const render = ui.slice(start, end);
  assert.match(render, /button\.hidden=working<=0;/);
  // The label states the count, so it is never a guess about what it cancels.
  assert.match(render, /Cancel \$\{working\} order/);

  const cancelStart = ui.indexOf("  async function cancelWorkingOrders()");
  const cancel = ui.slice(cancelStart, ui.indexOf("  function bindTicket()", cancelStart));
  assert.match(cancel, /\/api\/trading\/cancel\/check/);
  assert.ok(cancel.indexOf("/api/trading/cancel/check") < cancel.indexOf('action:"click"'),
    "permission must be checked before anything is clicked");
  // A bare "Cancel" is the dialog's dismiss button, so specific labels go first.
  const labels = ui.slice(ui.indexOf("cancel:["), ui.indexOf("]", ui.indexOf("cancel:[")));
  assert.ok(labels.indexOf('"Cancel order"') < labels.indexOf('"Cancel"'),
    "a bare Cancel must be the last resort");
  assert.match(cancel, /missingControl\("cancel control",tried\)/);
  // The shared reporter names what was tried, what the page has, and where.
  const missing = ui.slice(ui.indexOf("  async function missingControl("), ui.indexOf("\n  }", ui.indexOf("  async function missingControl(")));
  assert.match(missing, /No \$\{what\} on the broker page\. Tried: \$\{tried\.join\(", "\)\}/);
  assert.match(missing, /Acted on: \$\{probe\.url\}/);
});

// A broker's per-row cancel is usually just called "Cancel". With several live
// orders on screen, matching that bare word could cancel a different one than
// the row you pressed.
test("a per-row cancel refuses a bare match when it would be ambiguous", () => {
  const start = ui.indexOf("  async function cancelOrderRow(");
  const cancel = ui.slice(start, ui.indexOf("  // Shared with the bulk cancel", start));
  assert.match(cancel, /const specific=\[`Cancel \$\{row\.symbol\} order`/);
  // The generic labels are only added when exactly one order can be meant.
  assert.match(cancel, /liveCount===1\s*\?\s*\[\.\.\.specific,\.\.\.ticketFields\(/);
  assert.match(cancel, /could take the wrong one/);
  assert.ok(cancel.indexOf("/api/trading/cancel/check") < cancel.indexOf('action:"click"'),
    "permission must be checked before anything is clicked");
});

test("Legend cancellation is scoped to the matching order row", () => {
  assert.match(ui, /action:"cancel_order",symbol:row\.symbol/);
  assert.match(ui, /action:"cancel_order",symbol:liveRows\[0\]\.symbol/);
  assert.match(shell, /action == "cancel_order"/);
  assert.match(shell, /smallest visible row-like ancestor containing both the/);
  assert.match(shell, /no visible Cancel control in the/);
  assert.match(shell, /TryCancelOrderAccessibilityAsync/);
  assert.match(shell, /string\.Equals\(AxRole\(list\[i\]\), "row"/);
  assert.match(shell, /ResolveAxControlAsync\(t, "Cancel"/);
  assert.match(shell, /action == "select_order_side"/);
  assert.match(shell, /ResolveAxExactControlAsync/);
  assert.match(shell, /no safe non-executing/);
  assert.match(shell, /await delay\(900\)/);
  assert.match(ui, /Cancel failed — couldn't locate the broker's cancel control/);
  assert.match(ui, /id="tbErrorDetails"/);
});

// The send types into whichever order form the broker page has open, so closing
// a position for a symbol that page is not showing would put one symbol's size
// into another symbol's ticket.
test("closing a position only sends for the symbol the page is showing", () => {
  const start = ui.indexOf("  async function closePositionRow(");
  const close = ui.slice(start, ui.indexOf("\n  // Cancel one specific order", start));
  assert.match(close, /ticketState\.positionEffect="to-close";/);
  assert.match(close, /ticketState\.type="market";/);
  // A different symbol loads the ticket and stops, rather than sending.
  const guardIndex = close.indexOf("if(normalizeSymbolInput(symbol)!==here)");
  const sendIndex = close.indexOf("await sendTicket()");
  assert.ok(guardIndex >= 0 && guardIndex < sendIndex, "the symbol check must come before the send");
  assert.match(close, /Open \$\{symbol\} on the broker page before sending/);
  // And it re-asks the guard for the rewritten ticket before sending it.
  assert.ok(close.indexOf("await runTicketCheck()") < sendIndex);
});

test("a send reports what it actually did to the page", () => {
  const start = ui.indexOf("  async function sendTicket()");
  const end = ui.indexOf("  function bindTicket()", start);
  const send = ui.slice(start, end);
  // Every label tried is named on failure, and so is what the page does have,
  // so an unmatched control can be fixed in settings instead of guessed at.
  assert.match(send, /Tried: \$\{tried\.join\(", "\)\}/);
  assert.match(send, /action:"controls"/);
  assert.match(send, /The page shows:/);
  for (const call of ["missing(`safe non-executing ${payload.side} control`,side.tried)",
    "missing(`${slot} field`,hit.tried)",
    'missing("place button",placed.tried)']) {
    assert.ok(send.includes(call), `${call} is not reported with the page's real controls`);
  }
  // A missing place button reports the ticket as filled, never as sent.
  assert.match(send, /place button/);
  assert.match(send, /The order is on the broker page — press its own button/);
  const placedPost = send.indexOf("/api/trading/ticket/placed");
  assert.ok(send.indexOf("if(!placed.label)") < placedPost,
    "the order must not be counted as placed before the place click is confirmed");
  // The report outlives the next refresh.
  assert.match(send, /ticketSendReport=\{ok:false/);
  assert.match(ui, /if\(ticketSendReport\)\{/);
  // The ok flag alone is not trusted: an older shell build reported ok:true
  // for a script that threw, so the step's own success string is checked too.
  assert.match(send, /const didAct=\(action,result\)=>/);
  assert.match(send, /result\?\.ok!==false&&didAct\(action,result\)/);
});

test("account identity shares the buying-power slot instead of another line", () => {
  assert.match(ui, /\.trading-bar \.tb-account\{ display:none; \}/);
  assert.match(ui, /const masked=String\(acct\.masked\|\|""\)\.trim\(\)/);
  assert.match(ui, /\$\{masked\?` · \$\{masked\}`:""\}/);
  assert.doesNotMatch(ui, /acct\.masked\} · manual only/);
  assert.match(ui, /set side \+ qty/);
});
