// Persistent daily trade ledger — makes maxOrdersPerDay and dailyLossCapUsd real.
//
// Counts orders actually placed today and accumulates realized losses, resetting
// automatically when the local date rolls over. Pure transforms are separated from
// the tiny file IO so the day-roll and accumulation logic are fully unit-testable.

import fs from "node:fs";
import path from "node:path";

const LEDGER_FILE = "trade-ledger.json";

export function localDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function emptyLedger(date = localDate()) {
  return { date, ordersToday: 0, realizedLossUsd: 0 };
}

// Reset the counters when the day has rolled over; otherwise sanitize in place.
export function rollDaily(ledger, date = localDate()) {
  if (!ledger || ledger.date !== date) return emptyLedger(date);
  return {
    date,
    ordersToday: Math.max(0, Math.floor(Number(ledger.ordersToday) || 0)),
    realizedLossUsd: Math.max(0, Number(ledger.realizedLossUsd) || 0)
  };
}

// One order placed today.
export function applyPlacement(ledger, date = localDate()) {
  const rolled = rollDaily(ledger, date);
  return { ...rolled, ordersToday: rolled.ordersToday + 1 };
}

// Record a realized result. Only losses accumulate toward the daily loss cap;
// gains do not offset it (a conservative, "stop after N dollars lost" cap).
export function applyResult(ledger, realizedPnlUsd, date = localDate()) {
  const rolled = rollDaily(ledger, date);
  const pnl = Number(realizedPnlUsd) || 0;
  const loss = pnl < 0 ? -pnl : 0;
  return { ...rolled, realizedLossUsd: Math.round((rolled.realizedLossUsd + loss) * 100) / 100 };
}

// ---- IO (best-effort; a missing/corrupt file reads as an empty day) ----

export function loadLedger(dir) {
  try {
    return rollDaily(JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), "utf8")));
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(dir, ledger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LEDGER_FILE), JSON.stringify(ledger, null, 2));
  } catch { /* ledger persistence is best-effort */ }
  return ledger;
}

// The guardrail state the trade guard expects: { ordersToday, realizedLossUsd }.
export function currentTradeState(dir) {
  const l = loadLedger(dir);
  return { ordersToday: l.ordersToday, realizedLossUsd: l.realizedLossUsd };
}

export function recordTradePlacement(dir) {
  return saveLedger(dir, applyPlacement(loadLedger(dir)));
}

export function recordTradeResult(dir, realizedPnlUsd) {
  return saveLedger(dir, applyResult(loadLedger(dir), realizedPnlUsd));
}

// Overwrite today's realized loss with an authoritative total (e.g. synced from
// the broker), rather than adding to it. Never lowers below what's already
// recorded, so a bad/optimistic sync can't quietly re-open a tripped cap.
export function setRealizedLoss(dir, lossUsd) {
  const l = loadLedger(dir);
  const next = Math.max(0, Number(lossUsd) || 0, l.realizedLossUsd);
  return saveLedger(dir, { ...l, realizedLossUsd: Math.round(next * 100) / 100 });
}
