# Price-Action Trading Plan - /MNQU26 (Micro E-mini Nasdaq-100 futures)

Strategy: momentum/trend following. Buy at market when price is going up. Sell at market when price is going down. Long-only, one position at a time. No auto-execution - every order is staged for the user to confirm.

## Instrument & size
- Symbol: /MNQU26 (Micro E-mini Nasdaq-100, $2 per point per contract)
- Size: 1 contract per position (adjustable)
- Market orders only, as requested

## "Going up" - BUY signal (only when no position)
All must be true on the visible chart (1m/5m):
1. Price breaks above the prior swing high (previous 5-minute high), AND
2. Price is above the short-term moving average (9 EMA), AND
3. Price is above VWAP (optional confirmation)
Action: stage a 1-contract MARKET BUY proposal for confirmation.

## "Going down" - SELL signal (when holding long)
Either triggers an exit at market:
1. Profit protection: price falls 5+ points from the highest price since entry (trailing stop), OR
2. Trend flip: price closes below the prior swing low or the 9 EMA.
Action: stage a 1-contract MARKET SELL proposal for confirmation.

## Position rules
- One position at a time. No averaging down. No adding to a loser.
- If a signal fires and the confirmation is not completed quickly, the signal is skipped until the next clean setup.

## Risk guardrails
- Daily loss cap: -$200 per day. Once hit, no new buy proposals for the day. (P&L sync is not configured, so realized P&L is logged manually.)
- Max loss per trade: 10 points = $20 per contract (trailing stop enforces).
- Kill switch: user says "stop trading" or "halt" - no new proposals.

## Monitoring & alerts (as the user requested)
Monitor the visible Robinhood Legend page on the existing schedule. Alert ONLY when:
1. Price moved more than 10 points since the last baseline,
2. Position changed (No position <-> holding a position),
3. Open orders appeared or were filled,
4. Volume spiked significantly.
Otherwise stay silent and just track the state.

## Last known baseline
- Price 28,684.50 (+280.25, +0.99%)
- Bid 28,684.00 x3 / Ask 28,684.75 x5
- Volume 12.28K | No position | 0 open orders
- Note: the visible browser tab currently shows GOOGL, not /MNQU26 - monitoring reads whichever symbol page is visible.

## Open items for the user to confirm
1. Contract size = 1 - ok?
2. "Going up" = break of prior 5m high + above 9 EMA - ok?
3. Trailing exit distance = 5 points - ok?
4. Daily loss cap = -$200 - ok?
5. Should the monitor run more often (e.g., every 1 minute during market hours)?
