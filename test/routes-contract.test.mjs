import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { marketsRoutes } from "../src/routes/markets.js";

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("a route module declines anything outside its prefix", async () => {
  // The contract: return false and let the handler keep looking. Getting this
  // wrong would silently swallow every other route.
  const calls = [];
  const ctx = {
    req: { method: "GET" },
    p: "/api/threads",
    url: new URL("http://localhost/api/threads"),
    config: defaultConfig(),
    json: (...args) => calls.push(args),
    readBody: async () => ({}),
    saveConfig: () => {},
    marketAccessAllowed: () => true
  };
  assert.equal(await marketsRoutes(ctx), false);
  assert.equal(calls.length, 0, "a declined request must not write a response");
});

test("the markets group is gated on admin access before any route runs", async () => {
  const responses = [];
  const ctx = {
    req: { method: "GET" },
    p: "/api/markets/sectors",
    url: new URL("http://localhost/api/markets/sectors"),
    config: defaultConfig(),
    json: (body, code) => responses.push({ body, code }),
    readBody: async () => ({}),
    saveConfig: () => {},
    marketAccessAllowed: () => false
  };
  assert.equal(await marketsRoutes(ctx), true, "a refused request is still handled");
  assert.equal(responses[0].code, 403);
  assert.match(responses[0].body.error, /administrators/);
});

test("server.js delegates to the route module rather than inlining the group", () => {
  const server = read("src/server.js");
  assert.match(server, /import \{ marketsRoutes \} from "\.\/routes\/markets\.js";/);
  assert.match(server, /if \(await marketsRoutes\(\{[^}]*\}\)\) return;/);
  // The group must not be duplicated back into the handler.
  assert.ok(!server.includes('p === "/api/markets/sectors"'), "markets routes still inline in server.js");
  assert.match(read("src/routes/markets.js"), /p === "\/api\/markets\/sectors"/);
});

test("the extracted group still answers over HTTP", async (t) => {
  const config = defaultConfig();
  const app = await startServer(config, { port: 0, sessionToken: "1" });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  // Not an admin in a default config, so the gate — inside the module — answers.
  const response = await fetch(`http://127.0.0.1:${app.port}/api/markets/sectors`);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /administrators/);

  // A route the module does not own must still reach the main handler.
  const other = await fetch(`http://127.0.0.1:${app.port}/api/status`);
  assert.equal(other.status, 200);
});
