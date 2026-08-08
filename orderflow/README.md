# orderflow

Order-book pressure analysis for TradeStation market depth.

```bash
node orderflow/src/cli.js                          # run every scenario
npm run orderflow:monitor -- dynamicLayering       # watch it work, at localhost:8790
node --test test/orderflow-*.test.mjs              # the tests
```

## Connecting it to TradeStation

```bash
cp orderflow/tradestation.local.example.json orderflow/tradestation.local.json
# fill in clientId and clientSecret — both files are gitignored
node orderflow/src/auth-cli.js                     # one-time browser login
npm run orderflow:monitor -- --live ESU26 --capture
node orderflow/src/calibrate.js orderflow/captures/<file>.ndjson
```

Prerequisites, none of which the code can do for you:

1. API access approved in the TradeStation developer portal (Client ID + Secret).
2. A CME market-depth entitlement on the account. Non-professional futures
   accounts often get this free or near-free; confirm your own classification.
3. `callbackPort` must be one of **80, 3000, 3001, 8080, 31022** — TradeStation
   pre-registers those and nothing else. Any other port fails at the redirect
   with no useful error.
4. Do **not** be signed into the TradeStation desktop platform with the same
   user ID. That produces a `DualLogon` error, which the client treats as fatal
   and refuses to retry.

Everything defaults to `sim-api.tradestation.com`. Set `"live": true` to switch.

## What this is

A read-only indicator. It watches the ladder and reports whether buying or
selling pressure is real, with a confidence term and a plain-English reason for
every reading. It does not place orders, and its output is not advice.

## Why it is built the way it is

The naive reading of a depth ladder — "large offers stacked above the market
means supply, so sell" — is precisely the inference that layering is designed to
manufacture. Navinder Sarao made roughly $40m by producing that exact signal on
demand: several large sell orders held 3–4 ticks above the touch, re-priced
continuously so they tracked the market without ever being filled, and pulled
the moment price approached.

So resting size is discounted three ways before it counts toward anything:

| Filter | What it asks | Why |
| --- | --- | --- |
| **Distance** | how far from the touch? | size 6 ticks away moves price far less than size at the touch; weighted `exp(-ticks/λ)` |
| **Persistence** | how long has it rested? | size that has sat for seconds is intent, size posted 200ms ago is a claim |
| **Credibility** | does this level keep flickering? | a price that repeatedly vanishes and returns is being quoted for effect |

On top of that, a **confidence** term collapses when the book looks
manufactured — driven by per-level flicker, the instrument's cancel-to-trade
ratio (Sarao cancelled ~99% of what he sent), data freshness, and whether the
independent components agree. Any signal below the confidence floor is reported
as NEUTRAL regardless of its score.

Aggressive volume is also damped by **follow-through**: heavy selling that fails
to move price is absorption, not bearishness, and letting the raw sell ratio
read as bearish there would cancel out the very signal worth having.

## Does it work?

That is what `scenarios.js` is for. Watching a live book cannot tell you whether
the spoof filter works, because you never learn which walls were genuine. In the
synthetic scenarios we know, because we built them:

| Scenario | Naive book score | Filtered score | Signal | Confidence |
| --- | --- | --- | --- | --- |
| `balanced` | 0 | 0 | neutral | 0.79 |
| `genuineSellWall` | -49 | **-45** | **sell** | 0.99 |
| `bidAbsorption` | +50 | **+40** | **buy** | 0.98 |
| `dynamicLayering` | **-63** | **-2** | **neutral** | **0.05** |

The last row is the one that matters. A reconstruction of Sarao's technique
looks strongly bearish to a raw depth reading and is refused by the engine.

## Layout

| File | Role |
| --- | --- |
| `json-stream.js` | incremental parser for chunked HTTP streams; objects may span chunks |
| `stream-events.js` | classifies heartbeats, `EndSnapshot`, `GoAway`, and errors |
| `depth-normalize.js` | maps TradeStation frames to a stable internal shape |
| `book-state.js` | rebuilds the ladder and remembers how each level behaved |
| `signal-engine.js` | scoring, confidence, reasons, hysteresis |
| `entry-engine.js` | read-only 5-minute structure + EMA9/VWAP + order-flow confirmation |
| `reconnect-governor.js` | protects the 30/min, 10-concurrent depth quota |
| `scenarios.js` | synthetic order flow, including the layering reconstruction |
| `replay.js` | drives events through the pipeline on a virtual clock |
| `tradestation-config.js` | credentials, endpoints, callback-port validation |
| `tradestation-auth.js` | OAuth with PKCE, refresh, token storage |
| `auth-cli.js` | one-time browser login on the loopback redirect |
| `tradestation-client.js` | the live stream: reconnects, backoff, quota, fatal errors |
| `live-source.js` | depth + quotes wired into the book and the engine |
| `capture.js` | records raw stream bytes for offline replay |
| `synth-capture.js` | writes a capture from a scenario, so the capture path works before any brokerage access |
| `calibrate.js` | turns captures into measured thresholds, and refuses when they are not a usable baseline |
| `outcome-tracker.js` | records what the engine said and what price did next |
| `monitor-server.js` | serves the UI, streams engine state over SSE |
| `ui/index.html` | the monitor window |

## Known limits

- **Aggregated depth, not per-order.** TradeStation publishes MBP, so there is
  no queue position and no add/cancel events. Cancellations are *inferred* by
  diffing frames and attributing decrements to prints at the same price.
- **Retail latency.** Hundreds of milliseconds, not microseconds. This is a
  discretionary aid, not a latency strategy.
- **The thresholds are guesses.** `cancelTolerance`, `persistenceFullMs` and the
  component weights were tuned against synthetic data. They must be recalibrated
  against a recorded live session before the confidence term means anything.
  Real futures books cancel far more than they trade even when nobody is
  misbehaving.

## Calibrating

`calibrate.js` is the answer to "the thresholds are guesses". Capture a real
session, run it over the capture, and it reports what the instrument actually
does — the p50/p90/p99 of cancel:trade, level rest times, flicker and spread —
then suggests `cancelTolerance`, `cancelPenaltyRange` and `persistenceFullMs`
from measurements rather than from the synthetic scenarios.

It also prints **the depth field names it actually saw**, and warns loudly if
frames normalized to an empty book. `depth-normalize.js` currently accepts
several plausible spellings because the real ones are unconfirmed; the first
capture settles it.

**It will refuse to suggest values it does not trust**, and that guard is the
important part. A naive "p90 of whatever I captured is normal" fails in both
directions: calibrating on a session that happened to be manipulated raises the
cancel tolerance until the manipulation looks normal — disarming the exact
filter it is meant to support — while a very quiet session drives the tolerance
to zero and penalises everything. Neither failure announces itself. So it checks
sample size, what share of the book looked manufactured, and whether the result
lands in a plausible band for a liquid futures book, and explains itself when it
declines. Pass several sessions at once; one session is a sample, not a baseline.

You can exercise the whole path today without any brokerage access:

```bash
node orderflow/src/synth-capture.js balanced
node orderflow/src/calibrate.js orderflow/captures/synthetic-balanced.ndjson
```

## Measuring whether it works

`outcome-tracker.js` records every reading alongside what price actually did at
5s, 30s, 1m and 5m, plus maximum favourable and adverse excursion. Resolved
observations are appended to `orderflow/outcomes/` and summarised at
`GET /api/outcomes`.

Observations are taken on a fixed cadence in every state, **including NEUTRAL**.
That is deliberate: without neutral samples there is no control group, and a
signal that only fires in trends looks predictive purely because the market
drifts. The summary reports `comparable: false` until both directional and
neutral samples exist, and no claim about predictiveness is supportable before
then.

It runs in replay too, so the pipeline that has to work during the first live
session has already been exercised for hours before it.

## Scope boundary

This project is **standalone**. It does not touch, extend or replace the
Robinhood-based MNQ workflow in `price_action_plan_MNQU26.md`, which continues
to run on its own terms.

Concretely, `orderflow/` imports nothing from `src/`. Its only footprint outside
this directory is two `package.json` scripts, its own `test/orderflow-*` files,
and `.gitignore` entries. Deleting the directory would leave the rest of the
repo working. Keep it that way.

It is also **read-only against the market**: `MarketData`, `ReadAccount`, and `Matrix` are
the only OAuth scopes requested. There is no order placement here, and adding
the `Trade` scope would be a deliberate decision, not an incremental one.

## Next

Everything that can be done without brokerage access is done. What remains
genuinely needs the feed:

- **Confirm the field names.** `depth-normalize.js` and `normalizeBar` both
  accept several plausible spellings because the real ones are unconfirmed.
  `calibrate.js` prints what it saw; the bar tracker rejects and counts undated
  bars rather than guessing. Check both on the first live frame.
- **Calibration** — capture several regular-session days and run `calibrate.js`
  over all of them at once. Nothing below this line means much until that
  happens.
- **Warmup verification** — `fetchBarHistory` is tested against a fake fetch but
  has never seen a real response.
- **Phase 3** — always-on-top window, as its own small WinForms + WebView2
  executable pointed at `http://127.0.0.1:8790`. `BoollmPetForm` in
  `shell/Program.cs` is the reference for the `TopMost` pattern, but this ships
  as a separate binary rather than a form inside the Boollm shell, so the two
  stay independent.
- **Phase 4** — the recording half is built (`outcome-tracker.js`). What remains
  is the analysis: once there are real sessions on disk, find out whether the
  signal predicts anything. An LLM review pass over `orderflow/outcomes/` is a
  good fit for that — pattern-finding over a static log, run once a day, costing
  cents. It is *not* a fit for the decision loop; see below.

## Risk management and adaptation (design, not yet built)

Markets change, so thresholds calibrated on one month drift by the next. That is
a real problem, but it splits into two halves that must be built very
differently.

### Risk enforcement is deterministic. Always.

Risk limits are the worst possible place for a model. A daily loss cap has to
fire at exactly its limit, every time, in microseconds, **even when the network
is down and nothing intelligent is reachable**. If a model decides whether to
halt, a model outage means no halt — unbounded loss at exactly the moment things
are going wrong.

So the guards are plain code, checked every tick, with no way to be talked out
of it:

| Guard | Fires when |
| --- | --- |
| Position cap | contracts exceed the limit |
| Daily loss cap | P&L below the limit — **latches off for the day** |
| Order rate limit | orders per minute exceed the limit (runaway-loop protection) |
| Dead-man's switch | no depth frame for N seconds → halt rather than trade on stale state |
| Spread guard | spread wider than N ticks |
| Volatility guard | realized volatility outside the calibrated range |
| Session guard | outside the hours the thresholds were calibrated for |
| Manual kill | one command, unconditional |

Every one is a boolean over a number. None of them needs intelligence, and none
of them may be overridden by anything that does.

### Adaptation has three tiers, and only the third needs a model

1. **Rolling recalibration** — re-run `calibrate.js` over a trailing window of
   sessions on a schedule. Handles slow drift with no model at all. Do this
   first; it covers most of what "the market changed" actually means.
2. **Regime bucketing** — classify sessions by measurable features (realized
   volatility, spread, depth, time of day) and keep per-regime thresholds. Plus
   an **edge-decay circuit breaker**: if hit rate falls below the calibrated
   baseline by a set margin, cut size automatically and stop if it falls
   further. Arithmetic over the outcome log.
3. **LLM review** — statistics can say the hit rate dropped; they cannot say
   *why*, and cannot notice that conditions are unlike the calibration set in a
   way nobody thought to measure. A model reading outcome logs plus session
   context can hypothesise causes, flag unfamiliar conditions in words, and
   propose parameter changes with written rationale and the evidence behind
   them.

### How a proposal becomes live

Never directly. This governance layer is the part that makes tier 3 safe:

- **Proposals write to a staging file**, never to live config.
- **Hard bounds in code** the model cannot change; out-of-range proposals are
  rejected before a human sees them.
- **One-way ratchet.** Changes that *reduce* risk may auto-apply. Anything that
  increases exposure requires explicit human sign-off. No exceptions.
- **Champion / challenger.** Proposed parameters run in shadow mode on the same
  feed, logged separately, placing no orders. Promote only after beating the
  champion over a pre-declared number of sessions.
- **Full audit trail** — what changed, why, on what evidence, and what happened
  next, so a bad change can be walked backwards.
- **Rate limit on change itself** — at most one parameter change per week.

### The trap this design exists to avoid

Auto-adaptation is how you build a system that fits yesterday perfectly and
tomorrow never. Every individual adjustment looks justified; collectively they
are curve-fitting to noise. Guards: minimum sample sizes, out-of-sample
validation on a window the model never saw, and a strong prior toward changing
nothing. A model asked "what should I adjust?" will always find something — ask
instead whether the evidence justifies a change, and let "no" be the expected
answer.

Build order: guards first (before any live order exists), then rolling
recalibration, then the circuit breaker, and only then the LLM layer — in
advisory mode, writing to staging.

## Entry candidates

`entry-engine.js` combines the two independent inputs without allowing either
one to trade by itself:

1. Five-minute price structure must break the prior bar's high or low while
   aligned with EMA9 and session VWAP.
2. The order-flow engine must agree in the same direction at the configured
   score and confidence floors.
3. Spoof risk must remain below the veto threshold.

The result is `BUY`, `SELL`, or `WAIT`, always with `readOnly: true`, checks,
metrics, and reasons. It is streamed to Light as `payload.entry`. No order
object is created and no Trade scope is requested. See `CLAUDE_HANDOFF.md` for
the exact integration boundary and next work.
