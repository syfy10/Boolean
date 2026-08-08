# Claude handoff: Light entry-candidate integration

## Boundary

`orderflow/` remains the standalone analysis engine. Boollm/Light consumes its
versioned localhost API and SSE stream; do not import Boollm `src/` modules from
this directory. The existing Robinhood/MNQ workflow remains separate.

There is still no execution path. OAuth defaults are `MarketData`,
`ReadAccount`, and `Matrix`; `Trade` is deliberately absent.

## What was added

- `src/entry-engine.js` normalizes TradeStation bars, calculates EMA9 and
  session VWAP, evaluates prior-five-minute-bar breaks, and requires the
  existing order-flow signal to confirm direction.
- Confidence below 0.55 or spoof risk above 0.35 vetoes a candidate.
- `src/live-source.js` now opens a five-minute barchart stream alongside depth
  and quotes, feeds bars into `EntryTracker`, and attaches `entry` to state.
- `src/monitor-server.js` includes `entry` in Light Engine protocol v1 SSE
  payloads. Replay creates deterministic synthetic bars so the UI contract is
  exercised without brokerage access.
- Light renders BUY/SELL/WAIT plus the first reason, EMA9, and VWAP.
- Protocol v1 now includes the last 60 normalized five-minute OHLCV bars in
  `chart.bars`. Light renders candlesticks, EMA9, session VWAP, and prior-range
  overlays instead of labeling a midpoint line as a one-minute chart.
- Light exposes six visible entry gates: five-minute structure, EMA9, VWAP,
  order flow, data/spread, and risk permission. Risk permission remains locked.
- `GET /api/outcomes` is proxied read-only into Light and its chart footer shows
  resolved, pending, directional-signal, comparability, and one-minute hit-rate
  state when sufficient samples exist.
- `test/orderflow-entry-engine.test.mjs` covers buy, sell, spoof veto, streaming
  bar replacement, normalization, and the TradeStation URL.

## Candidate contract

```json
{
  "type": "entry-candidate",
  "version": 1,
  "side": "buy | sell | wait",
  "actionable": false,
  "readOnly": true,
  "metrics": { "price": 0, "ema9": 0, "vwap": 0, "priorHigh": 0, "priorLow": 0, "bars": 0 },
  "quality": { "confidence": 0, "spoofRisk": 0, "flowScore": 0, "alignment": 0 },
  "checks": { "buyStructure": false, "sellStructure": false, "buyFlow": false, "sellFlow": false, "quality": false },
  "reasons": []
}
```

`actionable` means the analytical conditions aligned. It does not mean an
order may be placed.

## Next safe work

1. Confirm real barchart frame fields with a live regular-session capture.
2. Calibrate thresholds per symbol and regular/overnight session using multiple
   representative captures.
3. Add one-position, daily-loss, spread, volatility, order-rate, and dead-man
   vetoes. The stale-depth veto already exists.
4. Add one-minute bars only if the entry design needs them; the implemented
   price-setup contract is five-minute.
5. Only after measured SIM results, design a separate staged-order service.

Do not add `Trade` scope or order endpoints as an incremental cleanup.

## Light top workstation shell

Light's top surface now follows the supplied TradeStation reference: a compact
global header contains the New York clock, disabled Trade action, layout/help/
settings controls, and SIM state. The Matrix pane contains a two-row order
ticket preview for symbol, quantity, duration, account, order type, limit,
increment, and route plus Buy/Close/Short buttons. Every execution control is
disabled and labeled read-only. Future execution work should bind to a separate
staged-order service rather than adding network calls directly to these UI
elements.

The moon/theme, expand, and close controls are docked immediately after SIM in
the same black header row. Light's brand is title case (`Light`), not `LIGHT_`.

## Run locally

From `C:\Users\S10\Documents\Boolean`:

```powershell
npm.cmd run dev:headless
npm.cmd run orderflow:monitor -- dynamicLayering
```

Expected services:

- Boollm/Light: `http://127.0.0.1:8765/`
- Light engine: `http://127.0.0.1:8790/`
- Engine status: `http://127.0.0.1:8790/api/status`
- Outcome summary: `http://127.0.0.1:8790/api/outcomes`
- Engine SSE: `http://127.0.0.1:8790/events`

Select the top-level **Light** tab and expand its floating workspace for the
full workstation layout.

For a real TradeStation feed:

```powershell
Copy-Item orderflow/tradestation.local.example.json orderflow/tradestation.local.json
node orderflow/src/auth-cli.js
npm.cmd run orderflow:monitor -- --live ESU26 --capture
```

Never commit the local TradeStation configuration, tokens, captures containing
sensitive account context, or credentials.

## Boollm adapter

- `src/light-orderflow.js` accepts only a localhost HTTP engine and proxies a
  narrow allowlist. Override the default with `BOOLLM_LIGHT_ENGINE_URL`.
- `src/routes/light.js` owns `/api/light/*`; Light is not a Markets route or an
  Explore sub-tab.
- `src/server.js` delegates the route group.
- `src/actions.js` exposes `workspace.light`.
- `src/ui.html` contains the standalone workspace, SSE renderer, capture and
  calibration controls, entry display, Matrix preview, clock, and header.

The adapter must remain display/control plumbing. Calculations stay inside
`orderflow/` so the engine can later be extracted unchanged.

## Engine local API

- `GET /api/status`
- `GET /api/outcomes`
- `GET /api/captures`
- `POST /api/capture/start`
- `POST /api/capture/stop`
- `POST /api/calibrate?file=<capture-name>`
- `GET /events` (Light Engine protocol v1 SSE)

There is deliberately no order, account mutation, or trade endpoint.

## Verification

```powershell
node --test test/light-workspace.test.mjs test/window-layout-ui.test.mjs test/library-ui.test.mjs test/markets.test.mjs test/orderflow-*.test.mjs
```

Latest focused verification passes 128/128 for Light and window layout, plus
44/44 for the changed Light, entry-engine, outcomes, and streaming paths.
`git diff --check` passes apart from ordinary Windows LF-to-CRLF notices.
Rendered QA verified the decision gates, five-minute chart contract, outcomes
strip, disabled ticket, zero overflow, and no browser warnings or errors.

## Working-tree warning

The standalone `orderflow/` baseline is committed at `c68fe75`; the chart-bar
and handoff changes after that commit are modified but uncommitted. The Light
adapter files remain untracked, while `src/ui.html`, `src/server.js`,
`src/actions.js`, and related tests are modified.
Other modified files (`src/platform.js`, GitHub onboarding tests, and layout
work) may belong to concurrent work. Preserve them; do not reset, clean, or
broadly commit the working tree. Stage only the Light/orderflow files the user
explicitly wants included.

## Robinhood visible-page compatibility

Boollm's existing native-browser reader remains separate from the standalone
engine, but its normalized values can be used by a future
`RobinhoodVisibleSource`. The 2026-08-08 Legend layout shows `SPY ▲ $4.82
(0.63%)` in the ticker header and the actual price as chart close `C 773.38`.
`src/ui/trading-logic.js` now distinguishes those fields and understands
symbol-filtered empty Positions/Recent orders messages. Do not bypass that
normalized parser by reading the first dollar amount near the ticker.
