// OAuth against TradeStation (Auth0-hosted).
//
// PKCE is always sent. For an app configured as a Regular Web App the client
// secret is used as well; for a Native/SPA app configured with PKCE the secret
// is simply absent. Sending the challenge either way means the same code works
// whichever way Client Experience provisions your application.

import crypto from "node:crypto";
import fs from "node:fs";

import { TOKEN_PATH } from "./tradestation-config.js";

const REFRESH_SKEW_MS = 60_000;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function buildAuthorizeUrl(config, { challenge, state }) {
  const url = new URL(config.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("audience", config.audience);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function postToken(config, body, fetchImpl) {
  const params = new URLSearchParams(body);
  params.set("client_id", config.clientId);
  if (config.clientSecret) params.set("client_secret", config.clientSecret);

  const res = await fetchImpl(config.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `token request failed (${res.status}): ${payload.error || "unknown"} — ${payload.error_description || text.slice(0, 200)}`
    );
  }
  return payload;
}

export function toTokenRecord(payload, now = Date.now(), previous = null) {
  return {
    accessToken: payload.access_token,
    // A rotating-token configuration returns a new refresh token each time; a
    // non-rotating one omits it, so keep the previous value rather than losing it.
    refreshToken: payload.refresh_token || previous?.refreshToken || null,
    expiresAt: now + (Number(payload.expires_in) || 1200) * 1000,
    scope: payload.scope || previous?.scope || null,
    obtainedAt: now
  };
}

export async function exchangeCode(config, { code, verifier }, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now ? deps.now() : Date.now();
  const payload = await postToken(
    config,
    { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier },
    fetchImpl
  );
  return toTokenRecord(payload, now);
}

export async function refreshTokens(config, tokens, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now ? deps.now() : Date.now();
  if (!tokens?.refreshToken) throw new Error("no refresh token stored; run the auth flow again");
  const payload = await postToken(
    config,
    { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    fetchImpl
  );
  return toTokenRecord(payload, now, tokens);
}

export function isExpired(tokens, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!tokens?.accessToken) return true;
  return tokens.expiresAt - now <= skewMs;
}

export function createTokenStore(filePath = TOKEN_PATH) {
  return {
    path: filePath,
    read() {
      if (!fs.existsSync(filePath)) return null;
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return null;
      }
    },
    write(tokens) {
      fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      return tokens;
    },
    clear() {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  };
}

// Single entry point for the stream client: hand it this and it never has to
// think about expiry. Concurrent callers share one in-flight refresh.
export function createTokenProvider(config, store, deps = {}) {
  const now = deps.now || Date.now;
  let pending = null;

  return async function getAccessToken() {
    const tokens = store.read();
    if (!tokens) throw new Error(`no tokens at ${store.path}; run: node orderflow/src/auth-cli.js`);
    if (!isExpired(tokens, now())) return tokens.accessToken;

    if (!pending) {
      pending = refreshTokens(config, tokens, deps)
        .then((fresh) => {
          store.write(fresh);
          return fresh.accessToken;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}
