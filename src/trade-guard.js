// Trade guardrails for the price-action "signal + stage" workflow.
//
// SAFETY: Nothing in this module places an order. It evaluates whether a
// model-proposed order is allowed to be STAGED for the user's review. Execution
// always remains a separate, explicit, human-confirmed step through the broker
// connector. The guard is deny-by-default: trading signals are off until the
// user turns them on, and a kill-switch halts everything instantly.

export function defaultTradeGuard() {
  return {
    enabled: false,          // master switch — off until the user opts in
    killSwitch: false,       // instant halt for all staging
    symbolAllowlist: [],     // [] = any symbol; otherwise only these
    maxNotionalUsd: 0,       // 0 = no cap; per-order notional ceiling
    maxOrdersPerDay: 0,      // 0 = no cap; staged-order count ceiling per day
    dailyLossCapUsd: 0,      // 0 = no cap; stop staging once realized loss hits this
    maxRiskPerTradeUsd: 0    // 0 = no cap; ceiling on entry-to-stop risk for one order
  };
}

export function normalizeTradeGuard(raw = {}) {
  const d = defaultTradeGuard();
  return {
    enabled: raw.enabled === true,
    killSwitch: raw.killSwitch === true,
    symbolAllowlist: Array.isArray(raw.symbolAllowlist)
      ? raw.symbolAllowlist.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
      : d.symbolAllowlist,
    maxNotionalUsd: Math.max(0, Number(raw.maxNotionalUsd) || 0),
    maxOrdersPerDay: Math.max(0, Number(raw.maxOrdersPerDay) || 0),
    dailyLossCapUsd: Math.max(0, Number(raw.dailyLossCapUsd) || 0),
    maxRiskPerTradeUsd: Math.max(0, Number(raw.maxRiskPerTradeUsd) || 0)
  };
}

// ── auto-disarm ────────────────────────────────────────────────────────
// Trade-click consent used to last forever once given. It now expires, so an
// account armed hours ago is not still armed when you have forgotten about it.
// One rule, shared by the guard, /api/trading/state, and the trading bar.
export const DEFAULT_ARM_WINDOW_MINUTES = 30;

export function armWindowMs(trading = {}) {
  const raw = Number(trading?.armWindowMinutes);
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ARM_WINDOW_MINUTES;
  return Math.round(minutes * 60_000);
}

// When the current arming lapses (0 = never / not armed).
export function armExpiresAt(config = {}) {
  const window = armWindowMs(config?.connectors?.trading);
  if (window <= 0) return 0;
  const at = Number(config?.ui?.browserPerms?.tradeConsentAt) || 0;
  return at > 0 ? at + window : 0;
}

// True when this signed-in user has live, unexpired trade-click consent.
export function tradeConsentActive(config = {}, now = Date.now()) {
  const perms = config?.ui?.browserPerms || {};
  if (perms.tradeClicks !== true) return false;
  const user = String(config?.cloudBackend?.user?.email || config?.cloudBackend?.user?.id || "").trim().toLowerCase();
  const consented = String(perms.tradeConsentUser || "").trim().toLowerCase();
  if (!user || consented !== user) return false;
  const expires = armExpiresAt(config);
  return expires === 0 ? true : now <= expires;
}

const SIDES = new Set(["buy", "sell"]);

// The order types a broker ticket actually offers, and which of its own prices
// each one needs. `entry` names the price the order would fill near, which is
// what the notional and the bracket are measured from.
//
// NAMING: an order's own trigger is `triggerPrice` and its trail is
// `trailAmount`. `stopPrice`/`targetPrice` remain the PROTECTIVE BRACKET — the
// exit levels — because a "Stop" order type and a stop-loss are different
// things and sharing one field name would silently conflate the two.
export const ORDER_TYPES = Object.freeze({
  "market":           { label: "Market",           needs: [],                              entry: "reference" },
  "limit":            { label: "Limit",            needs: ["limitPrice"],                  entry: "limit" },
  "stop":             { label: "Stop",             needs: ["triggerPrice"],                entry: "trigger" },
  "stop-limit":       { label: "Stop limit",       needs: ["triggerPrice", "limitPrice"],  entry: "limit" },
  "trail-stop":       { label: "Trail stop",       needs: ["trailAmount"],                 entry: "reference" },
  "trail-stop-limit": { label: "Trail stop limit", needs: ["trailAmount", "limitPrice"],   entry: "limit" },
  "moc":              { label: "Market on close",  needs: [],                              entry: "reference" },
  "loc":              { label: "Limit on close",   needs: ["limitPrice"],                  entry: "limit" }
});

// How long the order lives. The guard does not judge these; it normalizes them
// so the ticket, the description, and the broker page all say the same thing.
export const TIME_IN_FORCE = Object.freeze({
  "day": "Day",
  "gtc": "Good till canceled",
  "ext": "Extended",
  "gtc-ext": "Good till canceled extended",
  "am": "AM",
  "pm": "PM"
});

const PRICE_LABELS = { limitPrice: "limit price", triggerPrice: "stop price", trailAmount: "trail amount" };

export function normalizeOrderType(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return Object.hasOwn(ORDER_TYPES, key) ? key : "";
}

export function normalizeTimeInForce(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return Object.hasOwn(TIME_IN_FORCE, key) ? key : "day";
}

const money = (n) => Math.round(n * 100) / 100;

// ── bracket math ───────────────────────────────────────────────────────
// Shared by the guard, the /api/trading/ticket/check endpoint, and the
// trading bar, so the dollar figures the user reads are the same ones the
// guard enforces. Prices only — nothing here places or sizes an order.
//
// A bracket straddles the entry in the direction of the EXPOSURE, not of the
// order. Buying to open is long, so the stop sits below. Selling to close that
// same long is still protecting a long, so its stop also sits below — orienting
// the bracket to the order's side instead would reject every protective exit.
export function bracketRisk({ side, quantity, entryPrice, stopPrice, targetPrice, reducesPosition } = {}) {
  const qty = Number(quantity) || 0;
  const entry = Number(entryPrice) || 0;
  const stop = Number(stopPrice) || 0;
  const target = Number(targetPrice) || 0;
  const buying = String(side || "").trim().toLowerCase() === "buy";
  const long = reducesPosition === true ? !buying : buying;
  const out = { riskUsd: 0, rewardUsd: 0, riskRewardRatio: 0, stopSideOk: true, targetSideOk: true, long };
  if (qty <= 0 || entry <= 0) return out;
  if (stop > 0) {
    out.stopSideOk = long ? stop < entry : stop > entry;
    out.riskUsd = money(Math.abs(entry - stop) * qty);
  }
  if (target > 0) {
    out.targetSideOk = long ? target > entry : target < entry;
    out.rewardUsd = money(Math.abs(target - entry) * qty);
  }
  if (out.riskUsd > 0 && out.rewardUsd > 0) {
    out.riskRewardRatio = Math.round((out.rewardUsd / out.riskUsd) * 100) / 100;
  }
  return out;
}

// Returns { allowed, reason, order } where `order` is the normalized proposal.
// `state` supplies runtime counters the guard can't know on its own:
//   { ordersToday:number, realizedLossUsd:number }
// options.skipEnabled: skip the master `enabled` gate (used by the confirmed
// browser-click path, which has its own tradeClicks on/off switch). The
// kill-switch and every risk cap still apply.
//
// A bracket (stopPrice/targetPrice) is optional. When one is given the guard
// can price the worst case BEFORE the order exists, which is what lets
// maxRiskPerTradeUsd and the projected side of dailyLossCapUsd bite up front
// instead of only after record_trade_result reports the damage.
export function evaluateTradeGuard(rawGuard, rawOrder = {}, state = {}, options = {}) {
  const guard = normalizeTradeGuard(rawGuard);
  const symbol = String(rawOrder.symbol || "").trim().toUpperCase();
  const side = String(rawOrder.side || "").trim().toLowerCase();
  const orderType = normalizeOrderType(rawOrder.orderType || "market");
  const timeInForce = normalizeTimeInForce(rawOrder.timeInForce);
  const quantity = Number(rawOrder.quantity);
  const limitPrice = Number(rawOrder.limitPrice) || 0;
  const triggerPrice = Number(rawOrder.triggerPrice) || 0;
  const trailAmount = Number(rawOrder.trailAmount) || 0;
  const referencePrice = Number(rawOrder.referencePrice) || 0;
  const stopPrice = Number(rawOrder.stopPrice) || 0;
  const targetPrice = Number(rawOrder.targetPrice) || 0;
  // An order that only closes existing exposure is not new risk. Reducing a
  // position must never be blocked by a risk ceiling — that would trap the
  // user in the very position the cap exists to limit.
  const reducesPosition = rawOrder.reducesPosition === true;

  const block = (reason) => ({ allowed: false, reason, order: { symbol, side, orderType, quantity, limitPrice } });

  if (!options.skipEnabled && !guard.enabled) return block("Trade staging is off. Turn on the trade guard in Settings before staging any order.");
  if (guard.killSwitch) return block("Kill-switch is ON — all trades are halted. Turn it off to resume.");
  if (!symbol) return block("No symbol given for the proposed order.");
  if (!SIDES.has(side)) return block(`Invalid side '${rawOrder.side}'. Use buy or sell.`);
  if (!orderType) {
    return block(`Invalid order type '${rawOrder.orderType}'. Use one of: ${Object.keys(ORDER_TYPES).join(", ")}.`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) return block("Quantity must be a positive number.");
  // Each type carries its own prices, and an order missing one of them would
  // reach the broker half-filled.
  const given = { limitPrice, triggerPrice, trailAmount };
  for (const field of ORDER_TYPES[orderType].needs) {
    if (!(given[field] > 0)) {
      return block(`A ${ORDER_TYPES[orderType].label.toLowerCase()} order needs a positive ${PRICE_LABELS[field]}.`);
    }
  }
  if (stopPrice < 0 || targetPrice < 0) return block("Bracket prices must be positive.");

  if (guard.symbolAllowlist.length && !guard.symbolAllowlist.includes(symbol)) {
    return block(`${symbol} is not on the allowed-symbols list (${guard.symbolAllowlist.join(", ")}).`);
  }

  // The price this order would fill near, which is what the notional and the
  // bracket are both measured against.
  const entrySource = ORDER_TYPES[orderType].entry;
  const unitPrice = entrySource === "limit" ? limitPrice : entrySource === "trigger" ? triggerPrice : referencePrice;
  const notionalUsd = unitPrice > 0 ? Math.round(quantity * unitPrice * 100) / 100 : 0;
  if (guard.maxNotionalUsd > 0) {
    if (!notionalUsd) return block(`Cannot check the per-order limit ($${guard.maxNotionalUsd}) without a price. Provide a limit or reference price.`);
    if (notionalUsd > guard.maxNotionalUsd) {
      return block(`Order notional $${notionalUsd} exceeds the per-order cap of $${guard.maxNotionalUsd}.`);
    }
  }

  const ordersToday = Math.max(0, Number(state.ordersToday) || 0);
  if (guard.maxOrdersPerDay > 0 && ordersToday >= guard.maxOrdersPerDay) {
    return block(`Daily staged-order limit reached (${ordersToday}/${guard.maxOrdersPerDay}). No more orders will be staged today.`);
  }

  const realizedLossUsd = Math.max(0, Number(state.realizedLossUsd) || 0);
  if (guard.dailyLossCapUsd > 0 && realizedLossUsd >= guard.dailyLossCapUsd) {
    return block(`Daily loss cap reached ($${realizedLossUsd} ≥ $${guard.dailyLossCapUsd}). Staging is halted for today.`);
  }

  const bracket = bracketRisk({ side, quantity, entryPrice: unitPrice, stopPrice, targetPrice, reducesPosition });
  const exposure = bracket.long ? "long" : "short";
  if (stopPrice > 0 && unitPrice > 0 && !bracket.stopSideOk) {
    return block(bracket.long
      ? `A ${exposure} position's stop must sit below the entry price ($${stopPrice} is not below $${unitPrice}).`
      : `A ${exposure} position's stop must sit above the entry price ($${stopPrice} is not above $${unitPrice}).`);
  }
  if (targetPrice > 0 && unitPrice > 0 && !bracket.targetSideOk) {
    return block(bracket.long
      ? `A ${exposure} position's target must sit above the entry price ($${targetPrice} is not above $${unitPrice}).`
      : `A ${exposure} position's target must sit below the entry price ($${targetPrice} is not below $${unitPrice}).`);
  }
  // Risk ceilings apply to orders that open or add exposure. A closing order
  // carries no new risk, so it stays available even when a cap is exhausted.
  if (!reducesPosition && bracket.riskUsd > 0) {
    if (guard.maxRiskPerTradeUsd > 0 && bracket.riskUsd > guard.maxRiskPerTradeUsd) {
      return block(`Entry-to-stop risk $${bracket.riskUsd} exceeds the per-trade risk cap of $${guard.maxRiskPerTradeUsd}.`);
    }
    if (guard.dailyLossCapUsd > 0 && realizedLossUsd + bracket.riskUsd > guard.dailyLossCapUsd) {
      return block(`Stopping out would put today's loss at $${money(realizedLossUsd + bracket.riskUsd)}, past the daily cap of $${guard.dailyLossCapUsd}. Tighten the stop or cut the size.`);
    }
  }
  if (!reducesPosition && guard.maxRiskPerTradeUsd > 0 && stopPrice <= 0) {
    return block(`A per-trade risk cap of $${guard.maxRiskPerTradeUsd} is set, so this order needs a stop price to price its worst case.`);
  }

  return {
    allowed: true,
    reason: "Within guardrails. Staged for your confirmation — not submitted.",
    order: {
      symbol, side, orderType, timeInForce, quantity,
      limitPrice, triggerPrice, trailAmount, entryPrice: unitPrice, notionalUsd,
      stopPrice, targetPrice, reducesPosition,
      riskUsd: bracket.riskUsd, rewardUsd: bracket.rewardUsd, riskRewardRatio: bracket.riskRewardRatio
    }
  };
}
