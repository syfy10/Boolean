import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  createPkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  toTokenRecord,
  isExpired,
  createTokenProvider
} from "../orderflow/src/tradestation-auth.js";
import { loadConfig, assertUsable, ALLOWED_CALLBACK_PORTS } from "../orderflow/src/tradestation-config.js";

const CONFIG = {
  clientId: "abc123",
  clientSecret: "shh",
  authorize: "https://signin.tradestation.com/authorize",
  token: "https://signin.tradestation.com/oauth/token",
  audience: "https://api.tradestation.com",
  redirectUri: "http://localhost:3000",
  scopes: ["openid", "offline_access", "MarketData"]
};

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

test("the PKCE challenge is the S256 hash of the verifier", () => {
  const { verifier, challenge, method } = createPkcePair();
  assert.equal(method, "S256");
  const expected = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(challenge, expected);
  assert.doesNotMatch(challenge, /[+/=]/, "must be base64url, not base64");
});

test("the authorize URL carries everything TradeStation needs", () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, { challenge: "chal", state: "st8" }));
  assert.equal(url.origin + url.pathname, "https://signin.tradestation.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc123");
  assert.equal(url.searchParams.get("audience"), "https://api.tradestation.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st8");
  assert.match(url.searchParams.get("scope"), /offline_access/);
  assert.doesNotMatch(url.search, /client_secret/, "the secret must never ride on the authorize URL");
});

test("the code exchange posts the verifier and the secret", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, body: new URLSearchParams(init.body) };
    return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 1200, scope: "MarketData" });
  };

  const tokens = await exchangeCode(CONFIG, { code: "code1", verifier: "ver1" }, { fetchImpl, now: () => 1000 });

  assert.equal(seen.url, CONFIG.token);
  assert.equal(seen.body.get("grant_type"), "authorization_code");
  assert.equal(seen.body.get("code"), "code1");
  assert.equal(seen.body.get("code_verifier"), "ver1");
  assert.equal(seen.body.get("client_secret"), "shh");
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.expiresAt, 1000 + 1200 * 1000);
});

test("a PKCE-only app sends no client secret", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = new URLSearchParams(init.body);
    return jsonResponse({ access_token: "at", expires_in: 60 });
  };
  await exchangeCode({ ...CONFIG, clientSecret: "" }, { code: "c", verifier: "v" }, { fetchImpl });
  assert.equal(body.get("client_secret"), null);
});

test("a refresh that returns no new refresh token keeps the existing one", () => {
  const previous = { refreshToken: "rt-original", scope: "MarketData" };
  const record = toTokenRecord({ access_token: "at2", expires_in: 1200 }, 5000, previous);
  assert.equal(record.refreshToken, "rt-original");
  assert.equal(record.scope, "MarketData");
});

test("a rotating configuration replaces the refresh token", () => {
  const record = toTokenRecord(
    { access_token: "at2", refresh_token: "rt-new", expires_in: 1200 },
    0,
    { refreshToken: "rt-old" }
  );
  assert.equal(record.refreshToken, "rt-new");
});

test("tokens are treated as expired before they actually are", () => {
  const tokens = { accessToken: "at", expiresAt: 100_000 };
  assert.equal(isExpired(tokens, 0), false);
  assert.equal(isExpired(tokens, 30_000), false, "70s of life left is fine");
  assert.equal(isExpired(tokens, 45_000), true, "55s of life left is inside the 60s skew, so refresh early");
  assert.equal(isExpired(tokens, 100_000), true);
  assert.equal(isExpired(null, 0), true);
});

test("a failed token request surfaces the provider's error text", async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: "invalid_grant", error_description: "refresh token expired" }, false, 403);
  await assert.rejects(
    () => refreshTokens(CONFIG, { refreshToken: "rt" }, { fetchImpl }),
    /invalid_grant.*refresh token expired/
  );
});

test("concurrent callers share a single refresh instead of racing", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({ access_token: "fresh", expires_in: 1200 });
  };
  const stored = { accessToken: "stale", refreshToken: "rt", expiresAt: 0 };
  const store = { path: "memory", read: () => stored, write: (t) => Object.assign(stored, t) };
  const provider = createTokenProvider(CONFIG, store, { fetchImpl, now: () => 1_000_000 });

  const results = await Promise.all([provider(), provider(), provider()]);
  assert.deepEqual(results, ["fresh", "fresh", "fresh"]);
  assert.equal(calls, 1, "three concurrent calls must not trigger three refreshes");
});

test("a still-valid token is used without hitting the network", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };
  const stored = { accessToken: "good", refreshToken: "rt", expiresAt: 10_000_000 };
  const store = { path: "memory", read: () => stored, write: () => {} };
  const provider = createTokenProvider(CONFIG, store, { fetchImpl, now: () => 0 });
  assert.equal(await provider(), "good");
});

test("config rejects a callback port TradeStation has not registered", () => {
  assert.throws(
    () => assertUsable({ clientId: "x", callbackPort: 8790 }),
    /not one of TradeStation's registered ports/
  );
  assert.throws(() => assertUsable({ clientId: "", callbackPort: 3000 }), /clientId is missing/);
  assert.ok(ALLOWED_CALLBACK_PORTS.includes(3000));
});

test("config defaults to the simulation environment", () => {
  const config = loadConfig({ clientId: "x" });
  assert.match(config.api, /sim-api\.tradestation\.com/);
  assert.equal(config.redirectUri, `http://localhost:${config.callbackPort}`);
});
