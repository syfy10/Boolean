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
    dailyLossCapUsd: 0       // 0 = no cap; stop staging once realized loss hits this
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
    dailyLossCapUsd: Math.max(0, Number(raw.dailyLossCapUsd) || 0)
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
const TYPES = new Set(["market", "limit"]);

// Returns { allowed, reason, order } where `order` is the normalized proposal.
// `state` supplies runtime counters the guard can't know on its own:
//   { ordersToday:number, realizedLossUsd:number }
// options.skipEnabled: skip the master `enabled` gate (used by the confirmed
// browser-click path, which has its own tradeClicks on/off switch). The
// kill-switch and every risk cap still apply.
export function evaluateTradeGuard(rawGuard, rawOrder = {}, state = {}, options = {}) {
  const guard = normalizeTradeGuard(rawGuard);
  const symbol = String(rawOrder.symbol || "").trim().toUpperCase();
  const side = String(rawOrder.side || "").trim().toLowerCase();
  const orderType = String(rawOrder.orderType || "market").trim().toLowerCase();
  const quantity = Number(rawOrder.quantity);
  const limitPrice = Number(rawOrder.limitPrice) || 0;
  const referencePrice = Number(rawOrder.referencePrice) || 0;

  const block = (reason) => ({ allowed: false, reason, order: { symbol, side, orderType, quantity, limitPrice } });

  if (!options.skipEnabled && !guard.enabled) return block("Trade staging is off. Turn on the trade guard in Settings before staging any order.");
  if (guard.killSwitch) return block("Kill-switch is ON — all trades are halted. Turn it off to resume.");
  if (!symbol) return block("No symbol given for the proposed order.");
  if (!SIDES.has(side)) return block(`Invalid side '${rawOrder.side}'. Use buy or sell.`);
  if (!TYPES.has(orderType)) return block(`Invalid order type '${rawOrder.orderType}'. Use market or limit.`);
  if (!Number.isFinite(quantity) || quantity <= 0) return block("Quantity must be a positive number.");
  if (orderType === "limit" && limitPrice <= 0) return block("A limit order needs a positive limit price.");

  if (guard.symbolAllowlist.length && !guard.symbolAllowlist.includes(symbol)) {
    return block(`${symbol} is not on the allowed-symbols list (${guard.symbolAllowlist.join(", ")}).`);
  }

  const unitPrice = orderType === "limit" ? limitPrice : referencePrice;
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

  return {
    allowed: true,
    reason: "Within guardrails. Staged for your confirmation — not submitted.",
    order: { symbol, side, orderType, quantity, limitPrice, notionalUsd }
  };
}
