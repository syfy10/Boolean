import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  return Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

function createMockMcp() {
  const state = {
    accountsCalls: 0,
    portfolioCalls: 0
  };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);

    const payload = body ? JSON.parse(body) : {};
    const method = String(payload.method || "");
    const id = payload.id;

    let result = {};
    if (method === "initialize") {
      state.initializeCalled = true;
      result = {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "Robinhood MCP", version: "1.0" },
        capabilities: {}
      };
    } else if (method === "notifications/initialized") {
      result = {};
    } else if (method === "tools/call") {
      const tool = payload.params?.name || "";
      if (tool === "get_accounts") {
        state.accountsCalls += 1;
        result = {
          structuredContent: {
            data: {
              accounts: [
                {
                  account_number: "1234567898048",
                  brokerage_account_type: "margin",
                  nickname: "Primary",
                  is_default: true,
                  agentic_allowed: false
                },
                {
                  account_number: "222233337112",
                  brokerage_account_type: "cash",
                  nickname: "Bot",
                  agentic_allowed: true
                }
              ]
            }
          }
        };
      } else if (tool === "get_portfolio") {
        state.portfolioCalls += 1;
        result = {
          structuredContent: {
            data: {
              buying_power: { buying_power: "63493.78" },
              total_value: "120000"
            }
          }
        };
      } else {
        result = { error: { message: `unknown tool ${tool}` } };
      }
    } else {
      result = { error: { message: `unknown method ${method}` } };
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });

  return { server, state };
}

test("the trading broker endpoint reports connector + active masked account", async (t) => {
  const { server: mcpServer, state } = createMockMcp();
  await new Promise((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(mcpServer));

  const config = defaultConfig();
  config.cloudBackend = { sessionToken: "admin-session", user: { email: "admin@example.com", role: "admin" } };
  config.connectors = {
    ...config.connectors,
    mcp: [{
      id: "rh",
      name: "Robinhood Legend",
      url: `http://127.0.0.1:${mcpServer.address().port}`,
      enabled: true
    }],
    trading: {
      broker: "Robinhood Legend"
    }
  };

  const app = await startServer(config, { port: 0 });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });

  const response = await fetch(`http://127.0.0.1:${app.port}/api/trading/broker?refresh=1`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.connector, "Robinhood Legend");
  assert.equal(body.account.type, "margin");
  assert.equal(body.account.nickname, "Primary");
  assert.equal(body.account.masked, "••••8048");
  assert.equal(body.account.agenticAllowed, false);
  assert.equal(body.agenticAccount.masked, "••••7112");
  assert.equal(body.anyAgentic, true);
  assert.equal(body.buyingPower, 63493.78);
  assert.equal(body.accountValue, 120000);
  assert.equal(state.accountsCalls, 1);
  assert.equal(state.portfolioCalls, 1);
});

test("trading broker endpoint reports failure without a configured connector", async (t) => {
  const config = defaultConfig();
  config.cloudBackend = { sessionToken: "admin-session", user: { email: "admin@example.com", is_admin: true } };
  config.connectors = { ...config.connectors, mcp: [], trading: {} };
  const app = await startServer(config, { port: 0 });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const response = await fetch(`http://127.0.0.1:${app.port}/api/trading/broker`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.match(body.error, /No broker connector is configured/);
});

test("trading broker endpoints reject non-admin users", async (t) => {
  const config = defaultConfig();
  config.cloudBackend = { sessionToken: "user-session", user: { email: "user@example.com", role: "user" } };
  const app = await startServer(config, { port: 0 });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const response = await fetch(`http://127.0.0.1:${app.port}/api/trading/state`);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /only to Boolean administrators/i);
});
