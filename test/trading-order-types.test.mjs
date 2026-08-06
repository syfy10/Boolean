import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTradeGuard, ORDER_TYPES, TIME_IN_FORCE, normalizeOrderType, normalizeTimeInForce } from "../src/trade-guard.js";
import { normalizeTicketDefaults, normalizeTicketFields } from "../src/server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");

const ON = { enabled: true };
const base = { symbol: "SPY", side: "buy", quantity: 100, referencePrice: 771.33 };

// ── the eight types ────────────────────────────────────────────────────

test("every order type the broker offers is accepted", () => {
  assert.deepEqual(Object.keys(ORDER_TYPES), ["market", "limit", "stop", "stop-limit",
    "trail-stop", "trail-stop-limit", "moc", "loc"]);
  assert.equal(normalizeOrderType("Stop Limit"), "stop-limit");
  assert.equal(normalizeOrderType("TRAIL_STOP"), "trail-stop");
  assert.equal(normalizeOrderType("nonsense"), "");
  assert.match(evaluateTradeGuard(ON, { ...base, orderType: "nonsense" }).reason, /Invalid order type/i);
});

test("each type is refused without the prices it carries", () => {
  const needs = {
    limit: [{}, /limit order needs a positive limit price/i],
    stop: [{}, /stop order needs a positive stop price/i],
    "stop-limit": [{ triggerPrice: 769 }, /stop limit order needs a positive limit price/i],
    "trail-stop": [{}, /trail stop order needs a positive trail amount/i],
    "trail-stop-limit": [{ trailAmount: 1 }, /trail stop limit order needs a positive limit price/i],
    loc: [{}, /limit on close order needs a positive limit price/i]
  };
  for (const [orderType, [extra, expected]] of Object.entries(needs)) {
    const verdict = evaluateTradeGuard(ON, { ...base, orderType, ...extra });
    assert.equal(verdict.allowed, false, `${orderType} should need its price`);
    assert.match(verdict.reason, expected);
  }
  // Market and MOC carry no price of their own and must stay allowed.
  assert.equal(evaluateTradeGuard(ON, { ...base, orderType: "market" }).allowed, true);
  assert.equal(evaluateTradeGuard(ON, { ...base, orderType: "moc" }).allowed, true);
});

test("a complete order of each type prices itself from the right field", () => {
  const limit = evaluateTradeGuard(ON, { ...base, orderType: "limit", limitPrice: 700 });
  assert.equal(limit.order.entryPrice, 700, "a limit order fills near its limit");
  assert.equal(limit.order.notionalUsd, 70000);

  const stop = evaluateTradeGuard(ON, { ...base, orderType: "stop", triggerPrice: 780 });
  assert.equal(stop.order.entryPrice, 780, "a stop order fills near its trigger");

  const stopLimit = evaluateTradeGuard(ON, { ...base, orderType: "stop-limit", triggerPrice: 780, limitPrice: 781 });
  assert.equal(stopLimit.order.entryPrice, 781, "a stop limit fills at its limit, not its trigger");

  // A trailing stop has no fixed price, so the live quote is the only estimate.
  const trail = evaluateTradeGuard(ON, { ...base, orderType: "trail-stop", trailAmount: 1.5 });
  assert.equal(trail.order.entryPrice, 771.33);
  assert.equal(trail.order.trailAmount, 1.5);
});

// The collision this naming exists to prevent: a "Stop" order type and a
// stop-loss are different things, and one field for both would silently make a
// protective exit into an entry trigger.
test("the order's trigger and the protective bracket stay separate", () => {
  const verdict = evaluateTradeGuard(ON, {
    ...base, orderType: "stop-limit", triggerPrice: 780, limitPrice: 781,
    stopPrice: 760, targetPrice: 800
  });
  assert.equal(verdict.allowed, true, verdict.reason);
  assert.equal(verdict.order.triggerPrice, 780);
  assert.equal(verdict.order.stopPrice, 760);
  // Risk is measured from the fill price to the BRACKET stop, not the trigger.
  assert.equal(verdict.order.riskUsd, 2100);
  assert.equal(verdict.order.rewardUsd, 1900);
});

test("a bracket is still judged against the entry the order type implies", () => {
  // Buying with a limit at 700, a protective stop above it is upside down even
  // though it sits below the live quote of 771.33.
  const verdict = evaluateTradeGuard(ON, { ...base, orderType: "limit", limitPrice: 700, stopPrice: 750 });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /stop must sit below the entry price/i);
});

// ── time in force ──────────────────────────────────────────────────────

test("time in force is normalized and defaults to day", () => {
  assert.deepEqual(Object.keys(TIME_IN_FORCE), ["day", "gtc", "ext", "gtc-ext", "am", "pm"]);
  assert.equal(normalizeTimeInForce("GTC"), "gtc");
  assert.equal(normalizeTimeInForce("gtc ext"), "gtc-ext");
  assert.equal(normalizeTimeInForce(""), "day");
  assert.equal(normalizeTimeInForce("forever"), "day", "an unknown lifetime must not become a long-lived order");
  assert.equal(evaluateTradeGuard(ON, { ...base, orderType: "market", timeInForce: "GTC" }).order.timeInForce, "gtc");
});

// ── the ticket UI ──────────────────────────────────────────────────────

test("the bar's order types match the guard's, exactly", () => {
  const start = ui.indexOf("  const TICKET_ORDER_TYPES=");
  const end = ui.indexOf("  const emptyTicketState=", start);
  assert.ok(start >= 0 && end > start, "TICKET_ORDER_TYPES not found");
  const block = ui.slice(start, end);
  const { TICKET_ORDER_TYPES, TICKET_TIF, TICKET_ORDER_TYPE_OPTIONS, TICKET_TIF_OPTIONS } =
    new Function(`${block}\nreturn {TICKET_ORDER_TYPES,TICKET_TIF,TICKET_ORDER_TYPE_OPTIONS,TICKET_TIF_OPTIONS};`)();

  assert.deepEqual(Object.keys(TICKET_ORDER_TYPES), Object.keys(ORDER_TYPES),
    "a type the bar offers and the guard rejects would be an unfixable ticket");
  assert.deepEqual(Object.keys(TICKET_TIF), Object.keys(TIME_IN_FORCE));
  assert.deepEqual(Object.keys(TICKET_ORDER_TYPE_OPTIONS), Object.keys(ORDER_TYPES));
  assert.deepEqual(Object.keys(TICKET_TIF_OPTIONS), Object.keys(TIME_IN_FORCE));
  for (const [key, label] of Object.entries(TICKET_TIF)) {
    assert.equal(TICKET_TIF_OPTIONS[key][0], label, `${key} should try its compact label first`);
  }
  assert.ok(TICKET_TIF_OPTIONS.gtc.some(label => /good till canceled/i.test(label)));
  assert.ok(TICKET_ORDER_TYPE_OPTIONS["trail-stop-limit"].some(label => /trailing stop limit/i.test(label)));
  // The bar's field names map onto the guard's price names.
  const map = { limit: "limitPrice", trigger: "triggerPrice", trail: "trailAmount" };
  for (const [type, spec] of Object.entries(TICKET_ORDER_TYPES)) {
    assert.deepEqual(spec.needs.map((field) => map[field]), ORDER_TYPES[type].needs,
      `${type} asks for different prices in the bar than in the guard`);
  }
});

test("only the prices the chosen type needs are shown", () => {
  const start = ui.indexOf("  function renderTicketInputs()");
  const end = ui.indexOf("\n  function renderTicketRisk()", start);
  const render = ui.slice(start, end);
  assert.match(render, /const needs=TICKET_ORDER_TYPES\[ticketState\.type\]\?\.needs\|\|\[\];/);
  assert.match(render, /el\.hidden=!needs\.includes\(field\)/);
  // And switching type clears a price the new type does not carry, so it
  // cannot ride along on the next send.
  const bind = ui.slice(ui.indexOf('$("tbOrderType")?.addEventListener'), ui.indexOf('$("tbTif")?.addEventListener'));
  for (const field of ["limit", "trigger", "trail"]) {
    assert.match(bind, new RegExp(`if\\(!needs\\.includes\\("${field}"\\)\\) ticketState\\.${field}="";`));
  }
});

test("account settings persist and survive a symbol change", () => {
  assert.deepEqual(normalizeTicketDefaults({}), {});
  assert.deepEqual(normalizeTicketDefaults({ exchange: " ARCA ", junk: "x" }), { exchange: "ARCA" });
  assert.equal(normalizeTicketDefaults({ instruction: "x".repeat(200) }).instruction.length, 60);

  // A new symbol starts a new order but keeps the account setup.
  const start = ui.indexOf("  const emptyTicket=()=>({...emptyTicketState(),");
  const block = ui.slice(start, ui.indexOf("\n  // Fill in what the page already knows", start));
  for (const key of ["positionEffect", "exchange", "taxLot", "accountName", "cancelAt", "tif"]) {
    assert.match(block, new RegExp(`${key}:ticketState\\.${key}`), `${key} should survive a symbol change`);
  }
});

test("an explicit position effect outranks the read position", () => {
  const start = ui.indexOf("  function ticketClosesPosition(");
  const closes = ui.slice(start, ui.indexOf("\n  }", start));
  assert.match(closes, /if\(ticketState\.positionEffect==="to-close"\) return true;/);
  assert.match(closes, /if\(ticketState\.positionEffect==="to-open"\) return false;/);
  assert.match(closes, /return ticketReducesPosition\(symbol\);/);
});

test("the send order carries the new labels", () => {
  assert.deepEqual(Object.keys(normalizeTicketFields({
    orderType: "Order type", timeInForce: "TIF", trigger: "Stop price", trail: "Trail", positionEffect: "Position effect"
  })), ["orderType", "timeInForce", "trigger", "trail", "positionEffect"]);
});
