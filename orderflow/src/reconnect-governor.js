// Guards the market-depth quota.
//
// TradeStation caps market depth at 30 requests per minute and 10 concurrent
// connections. A naive reconnect-on-error loop burns that in seconds and locks
// you out mid-session, which is a far worse failure than a slow reconnect. All
// timing is injected so this is testable without waiting.

export const DEFAULT_GOVERNOR_CONFIG = Object.freeze({
  maxPerWindow: 30,
  windowMs: 60_000,
  maxConcurrent: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: 0.25,
  // Leave headroom so a burst of reconnects cannot consume the entire quota.
  reserve: 5
});

export function createReconnectGovernor(config = {}) {
  const cfg = { ...DEFAULT_GOVERNOR_CONFIG, ...config };
  const random = cfg.random || Math.random;
  let attempts = []; // timestamps of connection attempts
  let open = 0;
  let failures = 0;

  function prune(now) {
    const cutoff = now - cfg.windowMs;
    attempts = attempts.filter((t) => t > cutoff);
  }

  function canConnect(now) {
    prune(now);
    if (open >= cfg.maxConcurrent) {
      return { ok: false, reason: "max-concurrent", waitMs: cfg.baseDelayMs };
    }
    const budget = cfg.maxPerWindow - cfg.reserve;
    if (attempts.length >= budget) {
      const oldest = attempts[0];
      return {
        ok: false,
        reason: "quota",
        waitMs: Math.max(0, oldest + cfg.windowMs - now)
      };
    }
    return { ok: true, reason: null, waitMs: 0 };
  }

  function noteConnect(now) {
    prune(now);
    attempts.push(now);
    open++;
  }

  function noteDisconnect() {
    open = Math.max(0, open - 1);
  }

  function noteSuccess() {
    failures = 0;
  }

  // Exponential backoff with jitter; jitter matters because a shared outage
  // otherwise has every stream reconnecting on the same tick.
  function noteFailure() {
    failures++;
    const raw = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (failures - 1));
    const spread = raw * cfg.jitter;
    return Math.round(raw - spread + random() * spread * 2);
  }

  return {
    canConnect,
    noteConnect,
    noteDisconnect,
    noteSuccess,
    noteFailure,
    get stats() {
      return { open, failures, attemptsInWindow: attempts.length };
    }
  };
}
