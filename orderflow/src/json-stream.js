// Incremental parser for TradeStation's chunked HTTP streams.
//
// The docs warn that intermediate proxies re-chunk the response: a single JSON
// object may span several chunks, and several objects may arrive in one. So we
// scan for balanced braces rather than trusting chunk or newline boundaries.

const DEFAULT_MAX_FRAME_BYTES = 1 << 20;

export function createJsonStreamParser(options = {}) {
  const onValue = options.onValue || (() => {});
  const onError = options.onError || (() => {});
  const maxFrameBytes = options.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES;

  let buf = "";
  let pos = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  function reset() {
    buf = "";
    pos = 0;
    depth = 0;
    start = -1;
    inString = false;
    escaped = false;
  }

  function write(chunk) {
    if (chunk == null) return;
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

    let consumed = 0;
    for (let i = pos; i < buf.length; i++) {
      const c = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{" || c === "[") {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (c === "}" || c === "]") {
        if (depth === 0) continue; // stray closer from a desynced stream
        depth--;
        if (depth === 0 && start >= 0) {
          emit(buf.slice(start, i + 1));
          start = -1;
          consumed = i + 1;
        }
      }
    }

    if (consumed > 0) {
      buf = buf.slice(consumed);
      if (start >= 0) start -= consumed;
    }
    pos = buf.length;

    if (buf.length > maxFrameBytes) {
      onError(new Error(`stream frame exceeded ${maxFrameBytes} bytes; resetting parser`));
      reset();
    }
  }

  function emit(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      onError(new Error(`unparseable stream frame: ${err.message}`), raw);
      return;
    }
    onValue(value);
  }

  function end() {
    if (buf.trim()) onError(new Error("stream ended mid-frame"), buf);
    reset();
  }

  return { write, end, reset, get pending() { return buf.length; } };
}

// Convenience for tests and replay: parse a complete string into frames.
export function parseAll(text, options = {}) {
  const values = [];
  const errors = [];
  const parser = createJsonStreamParser({
    ...options,
    onValue: (v) => values.push(v),
    onError: (e, raw) => errors.push({ error: e, raw })
  });
  parser.write(text);
  return { values, errors, pending: parser.pending };
}
