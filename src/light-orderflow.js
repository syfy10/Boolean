const DEFAULT_UPSTREAM = process.env.BOOLLM_LIGHT_ENGINE_URL || "http://127.0.0.1:8790";

function localUpstream(value = DEFAULT_UPSTREAM) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Light order-flow upstream must be a localhost HTTP service.");
  }
  return url;
}

export async function lightOrderFlowStatus(upstream = DEFAULT_UPSTREAM) {
  const base = localUpstream(upstream);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(new URL("/api/status", base), { signal: controller.signal });
    const engine = response.ok ? await response.json() : null;
    return { connected: response.ok, upstream: base.origin, connector: "orderflow", protocolVersion: engine?.protocol?.version || null, engine };
  } catch (error) {
    return {
      connected: false,
      upstream: base.origin,
      error: error?.name === "AbortError" ? "Light monitor timed out." : "Light monitor is not running."
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyLightOrderFlowApi(req, res, endpoint, upstream = DEFAULT_UPSTREAM) {
  const base = localUpstream(upstream);
  const allowed = new Set(["/api/status", "/api/outcomes", "/api/captures", "/api/capture/start", "/api/capture/stop", "/api/calibrate"]);
  if (!allowed.has(endpoint)) throw new Error("Unsupported Light engine command.");
  const target = new URL(endpoint, base);
  if (endpoint === "/api/calibrate") {
    const requestUrl = new URL(req.url, "http://localhost");
    const file = requestUrl.searchParams.get("file");
    if (file) target.searchParams.set("file", file);
  }
  const response = await fetch(target, { method: req.method, headers: { Accept: "application/json" } });
  const text = await response.text();
  res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

export async function proxyLightOrderFlowEvents(req, res, upstream = DEFAULT_UPSTREAM) {
  const base = localUpstream(upstream);
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once?.("close", abort);
  try {
    const response = await fetch(new URL("/events", base), {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error(`Light monitor returned HTTP ${response.status}.`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();
    for await (const chunk of response.body) {
      if (res.destroyed || controller.signal.aborted) break;
      res.write(chunk);
    }
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const message = String(error?.message || error).replace(/[\r\n]+/g, " ");
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    res.write(`event: light-error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    res.off?.("close", abort);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export const LIGHT_ORDERFLOW_UPSTREAM = DEFAULT_UPSTREAM;
