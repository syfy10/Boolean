import test from "node:test";
import assert from "node:assert/strict";
import { createEmailOAuth, getEmailAccount, publicEmailConnections } from "../src/email.js";

test("Gmail OAuth uses PKCE, offline access, and no client secret", () => {
  const transaction = createEmailOAuth("gmail", "desktop-client", "http://127.0.0.1:8765/email/oauth/callback");
  const url = new URL(transaction.authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), "desktop-client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope"), /gmail\.modify/);
  assert.ok(transaction.verifier.length > 40);
  assert.equal("clientSecret" in transaction, false);
});

test("public email state never exposes OAuth tokens or client ids", () => {
  const state = publicEmailConnections({ connectors: { email: {
    draftOnly: false,
    gmail: { connected: true, account: "person@example.com", clientId: "public-id", oauth: { accessToken: "secret", refreshToken: "secret2" } }
  } } });
  assert.deepEqual(state.gmail, { provider: "gmail", connected: true, account: "person@example.com", hasClientId: true });
  assert.equal(state.draftOnly, false);
  assert.equal(state.confirmBeforeSend, true);
  assert.doesNotMatch(JSON.stringify(state), /secret|public-id/);
});

test("expired Gmail access refreshes locally and persists before account lookup", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(options.headers.authorization, "Bearer new-access");
    return new Response(JSON.stringify({ emailAddress: "person@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const connection = { connected: true, clientId: "desktop-client", oauth: { accessToken: "old", refreshToken: "refresh", expiresAt: 1 } };
    let saved = 0;
    const account = await getEmailAccount("gmail", connection, () => saved++);
    assert.equal(account, "person@example.com");
    assert.equal(connection.oauth.accessToken, "new-access");
    assert.equal(saved, 1);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
