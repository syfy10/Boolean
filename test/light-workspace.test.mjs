import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";

import { lightOrderFlowStatus, proxyLightOrderFlowApi, proxyLightOrderFlowEvents } from "../src/light-orderflow.js";
import { lightRoutes } from "../src/routes/light.js";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("Light is a standalone workspace rather than a Markets mode", () => {
  const ui = read("src/ui.html");
  assert.match(ui, /data-ws="light"[^>]*title="Light trading workspace"/);
  assert.match(ui, /data-sidebar-workspace="light"[\s\S]*?<span>Light<\/span>/);
  assert.match(ui, /id="lightPanel"[^>]*aria-label="Light trading workstation"/);
  assert.match(ui, /document\.body\.classList\.toggle\("light-open", activeWsTab === "light"\)/);
  assert.match(ui, /else if \(ws === "light"\) \{ ensureLight\(\); \}/);
  assert.doesNotMatch(ui, /data-market-mode="light"/);
  assert.doesNotMatch(ui, /data-workspace-page="light"/);
});

test("Light is visible and reachable only for signed-in Boollm administrators", () => {
  const ui = read("src/ui.html");
  const server = read("src/server.js");
  assert.match(ui, /document\.querySelectorAll\('\[data-ws="light"\],\[data-sidebar-workspace="light"\]'\)\.forEach\(control=>\{/);
  assert.match(ui, /control\.hidden=!allowed;[\s\S]*?control\.setAttribute\("aria-hidden",String\(!allowed\)\)/);
  assert.match(ui, /!allowed&&\(EXPLORE_WORKSPACES\.includes\(current\)\|\|current==="light"\)/);
  assert.match(ui, /if\(ws==="light"&&!adminFeatureAccessAllowed\(\)\)\{[\s\S]*?Light is available only to signed-in Boollm administrators\./);
  assert.match(server, /lightRoutes\(\{ req, res, p, json, accessAllowed: \(\) => marketAccessAllowed\(config\) \}\)/);
});

test("Light presents the requested trading-terminal panes", () => {
  const ui = read("src/ui.html");
  for (const label of ["MATRIX", "QUOTES", "ORDERS", "CHART"]) assert.match(ui, new RegExp(label));
  for (const id of ["lightDepth", "lightSignal", "lightBestBid", "lightBestAsk", "lightChartCandles", "lightDecisionChecks", "lightOutcomes"]) assert.match(ui, new RegExp(`id="${id}"`));
  assert.match(ui, /new EventSource\("\/api\/light\/events"\)/);
  for (const id of ["lightCalibrationState", "lightCaptureStart", "lightCaptureStop", "lightCaptureSelect", "lightCalibrate"]) assert.match(ui, new RegExp(`id="${id}"`));
  for (const id of ["lightHeaderClock", "lightHeaderDate", "lightTicketSymbol", "lightTicketPrice"]) assert.match(ui, new RegExp(`id="${id}"`));
  assert.match(ui, /Read-only order ticket preview/);
  assert.match(ui, /Preview only · trading permission is intentionally disabled/);
  assert.match(ui, /class="light-trade"[^>]*disabled/);
  assert.match(ui, /UNCALIBRATED/);
  assert.match(ui, /Read-only analysis · no order execution/);
});

test("Light keeps dark-only integrated window controls", () => {
  const ui = read("src/ui.html");
  assert.match(ui, /\.workspace-float\[data-workspace="light"\] #workspaceFloatTheme\{ display:none; \}/);
  assert.match(ui, /\.workspace-float\[data-workspace="light"\] \.workspace-float-bar\{[\s\S]*?background:#11181e; border-bottom:1px solid #26323a;/);
  assert.match(ui, /\.workspace-float\[data-workspace="light"\] \.workspace-float-actions button\{[\s\S]*?width:38px; height:100%;[\s\S]*?border-radius:0;[\s\S]*?background:#11181e;/);
  assert.match(ui, /id="workspaceFloatExpand"[^>]*data-maximized="false"[^>]*><svg/);
  assert.match(ui, /id="workspaceFloatClose"[^>]*><svg/);
  assert.match(ui, /\.workspace-float\[data-workspace="light"\] \.workspace-float-bar\{[^}]*width:68px;[^}]*background:#11181e;/);
  assert.match(ui, /\.workspace-float\[data-workspace="light"\] \.workspace-float-actions\{[^}]*width:68px;[^}]*grid-template-columns:repeat\(2,34px\);/);
  assert.doesNotMatch(ui, /data-workspace="light"[^}]*grid-template-columns:repeat\(3,34px\)/);
  assert.match(ui, /const darkOnly=ws==="light";[\s\S]*?theme\.hidden=darkOnly;[\s\S]*?if\(darkOnly\)applyWorkspaceTheme\("dark"\)/);
  assert.match(ui, /button\.dataset\.maximized=String\(maximized\)/);
  assert.doesNotMatch(ui, /button\.textContent=maximized/);
});

test("Light routes are separately gated and decline other prefixes", async () => {
  const calls = [];
  const base = { req: { method: "GET" }, res: {}, json: (...args) => calls.push(args), accessAllowed: () => false };
  assert.equal(await lightRoutes({ ...base, p: "/api/markets/settings" }), false);
  assert.equal(await lightRoutes({ ...base, p: "/api/light/status" }), true);
  assert.equal(calls[0][1], 403);
  assert.match(calls[0][0].error, /Light/);
});

test("Light proxies only a localhost SSE monitor", async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ protocol: { name: "light-engine", version: 1 }, engine: "orderflow", readOnly: true }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"type":"state","signal":{"state":"neutral"}}\n\n');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("Light monitor");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const status = await lightOrderFlowStatus(origin);
  assert.equal(status.connected, true);
  assert.equal(status.upstream, origin);
  assert.equal(status.connector, "orderflow");
  assert.equal(status.protocolVersion, 1);
  assert.equal(status.engine.readOnly, true);
  await assert.rejects(() => lightOrderFlowStatus("https://example.com"), /localhost/);

  const proxy = http.createServer((req, res) => proxyLightOrderFlowEvents(req, res, origin));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(await response.text(), /"type":"state"/);
});

test("Light engine commands use a narrow allowlisted local API", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const origin = `http://127.0.0.1:${upstreamPort}`;
  const proxy = http.createServer((req, res) => proxyLightOrderFlowApi(req, res, "/api/capture/start", origin));
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/command`, { method: "POST" });
  assert.deepEqual(await response.json(), { ok: true, method: "POST", path: "/api/capture/start" });
  await assert.rejects(() => proxyLightOrderFlowApi({ method: "POST" }, {}, "/api/trade", origin), /Unsupported/);
  const outcomes = http.createServer((req, res) => proxyLightOrderFlowApi(req, res, "/api/outcomes", origin));
  const outcomesPort = await listen(outcomes);
  t.after(() => close(outcomes));
  const outcomeResponse = await fetch(`http://127.0.0.1:${outcomesPort}/outcomes`);
  assert.deepEqual(await outcomeResponse.json(), { ok: true, method: "GET", path: "/api/outcomes" });
});

test("server delegates the standalone Light route group", () => {
  const server = read("src/server.js");
  assert.match(server, /import \{ lightRoutes \} from "\.\/routes\/light\.js";/);
  assert.match(server, /lightRoutes\(\{ req, res, p, json, accessAllowed:/);
});
