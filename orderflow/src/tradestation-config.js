// Credentials and endpoints.
//
// Secrets live in orderflow/tradestation.local.json, which the repo's existing
// *.local.json gitignore rule already covers. You fill it in; nothing here ever
// writes your client secret anywhere else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(here, "..", "tradestation.local.json");
export const TOKEN_PATH = path.join(here, "..", "tradestation.tokens.local.json");

export const DEFAULT_ENDPOINTS = Object.freeze({
  // Auth is Auth0-hosted. Confirm these against your app's settings in the
  // developer portal -- they are configurable per application.
  authorize: "https://signin.tradestation.com/authorize",
  token: "https://signin.tradestation.com/oauth/token",
  audience: "https://api.tradestation.com",
  // Start in sim. Switch to https://api.tradestation.com/v3 only deliberately.
  api: "https://sim-api.tradestation.com/v3"
});

export const LIVE_API = "https://api.tradestation.com/v3";

// TradeStation pre-registers a fixed set of localhost callback ports. Using
// anything else fails at the redirect with no useful error, so the loopback
// server is pinned to this list rather than picking a free port.
export const ALLOWED_CALLBACK_PORTS = Object.freeze([80, 3000, 3001, 8080, 31022]);

export const DEFAULT_SCOPES = ["openid", "profile", "offline_access", "MarketData", "ReadAccount", "Matrix"];

export function loadConfig(overrides = {}) {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`could not parse ${CONFIG_PATH}: ${err.message}`);
    }
  }

  const config = {
    clientId: process.env.TRADESTATION_CLIENT_ID || file.clientId || "",
    clientSecret: process.env.TRADESTATION_CLIENT_SECRET || file.clientSecret || "",
    callbackPort: Number(file.callbackPort || 3000),
    scopes: file.scopes || DEFAULT_SCOPES,
    live: Boolean(file.live),
    ...DEFAULT_ENDPOINTS,
    ...(file.endpoints || {}),
    ...overrides
  };

  if (config.live) config.api = file.endpoints?.api || LIVE_API;
  config.redirectUri = `http://localhost:${config.callbackPort}`;
  return config;
}

export function assertUsable(config) {
  const problems = [];
  if (!config.clientId) problems.push("clientId is missing");
  if (!ALLOWED_CALLBACK_PORTS.includes(config.callbackPort)) {
    problems.push(
      `callbackPort ${config.callbackPort} is not one of TradeStation's registered ports (${ALLOWED_CALLBACK_PORTS.join(", ")})`
    );
  }
  if (problems.length) {
    throw new Error(
      `TradeStation config is not usable:\n  - ${problems.join("\n  - ")}\n` +
        `Fill in ${CONFIG_PATH} (see tradestation.local.example.json).`
    );
  }
  return config;
}
