import { lightOrderFlowStatus, proxyLightOrderFlowApi, proxyLightOrderFlowEvents } from "../light-orderflow.js";

export async function lightRoutes({ req, res, p, json, accessAllowed }) {
  if (!p.startsWith("/api/light/")) return false;
  if (!accessAllowed()) {
    json({ error: "Light is available only to signed-in Boollm administrators." }, 403);
    return true;
  }
  if (req.method === "GET" && p === "/api/light/status") {
    json({ ok: true, ...(await lightOrderFlowStatus()) });
    return true;
  }
  if (req.method === "GET" && p === "/api/light/events") {
    await proxyLightOrderFlowEvents(req, res);
    return true;
  }
  const engineRoutes = new Map([
    ["/api/light/engine/status", "/api/status"],
    ["/api/light/outcomes", "/api/outcomes"],
    ["/api/light/captures", "/api/captures"],
    ["/api/light/capture/start", "/api/capture/start"],
    ["/api/light/capture/stop", "/api/capture/stop"],
    ["/api/light/calibrate", "/api/calibrate"]
  ]);
  const endpoint = engineRoutes.get(p);
  if (endpoint && ((req.method === "GET" && ["/api/status", "/api/outcomes", "/api/captures"].includes(endpoint)) || req.method === "POST")) {
    await proxyLightOrderFlowApi(req, res, endpoint);
    return true;
  }
  return false;
}
