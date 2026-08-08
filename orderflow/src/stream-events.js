// Classifies frames coming off a TradeStation stream.
//
// Observed control frames (per the HTTP Streaming docs):
//   {"Heartbeat":1,"Timestamp":"..."}         keepalive, ignore
//   {"StreamStatus":"EndSnapshot"}            initial book delivered
//   {"StreamStatus":"GoAway"}                 server is closing; reconnect
//   {"Symbol":"AAPL","Error":"DualLogon"}     terminate the request, do not retry blindly

export const FrameKind = Object.freeze({
  HEARTBEAT: "heartbeat",
  STATUS: "status",
  ERROR: "error",
  DEPTH: "depth",
  BAR: "bar",
  QUOTE: "quote",
  UNKNOWN: "unknown"
});

// Errors where retrying the same connection will just fail again the same way.
const NON_RETRYABLE = new Set([
  "duallogon",
  "unauthorized",
  "forbidden",
  "invalidsymbol",
  "symbolnotfound",
  "notentitled",
  "subscriptionrequired"
]);

export function classifyFrame(frame) {
  if (!frame || typeof frame !== "object") return { kind: FrameKind.UNKNOWN, frame };

  if (frame.Heartbeat != null || frame.heartbeat != null) {
    return { kind: FrameKind.HEARTBEAT, frame, timestamp: frame.Timestamp || frame.timestamp || null };
  }

  const error = frame.Error ?? frame.error;
  if (typeof error === "string" && error) {
    const key = error.replace(/[^a-z]/gi, "").toLowerCase();
    return {
      kind: FrameKind.ERROR,
      frame,
      error,
      symbol: frame.Symbol || frame.symbol || null,
      message: frame.Message || frame.message || error,
      retryable: !NON_RETRYABLE.has(key)
    };
  }

  const status = frame.StreamStatus ?? frame.streamStatus;
  if (typeof status === "string" && status) {
    const normalized = status.toLowerCase();
    return {
      kind: FrameKind.STATUS,
      frame,
      status,
      endOfSnapshot: normalized === "endsnapshot",
      goAway: normalized === "goaway"
    };
  }

  if (Array.isArray(frame.Bids) || Array.isArray(frame.bids) || Array.isArray(frame.Asks) || Array.isArray(frame.asks)) {
    return { kind: FrameKind.DEPTH, frame };
  }

  if (frame.Open != null && frame.High != null && frame.Low != null && frame.Close != null) {
    return { kind: FrameKind.BAR, frame };
  }

  if (frame.Last != null || frame.Close != null || (frame.Bid != null && frame.Ask != null)) {
    return { kind: FrameKind.QUOTE, frame };
  }

  return { kind: FrameKind.UNKNOWN, frame };
}

// What the connection should do next, given a classified frame.
export function connectionAction(event) {
  if (event.kind === FrameKind.ERROR) {
    return event.retryable ? "reconnect" : "stop";
  }
  if (event.kind === FrameKind.STATUS && event.goAway) return "reconnect";
  return "continue";
}
