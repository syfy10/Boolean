import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmailOAuth,
  getEmailAccount,
  publicEmailConnections,
  scanEmailMetadata,
  trashEmail,
  untrashEmail
} from "../src/email.js";

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

test("Outlook OAuth uses a public-client account picker", () => {
  const transaction = createEmailOAuth("outlook", "desktop-client", "http://localhost:8765/");
  const url = new URL(transaction.authorizationUrl);
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.match(url.searchParams.get("scope"), /Mail\.ReadWrite/);
  assert.match(url.searchParams.get("scope"), /offline_access/);
  assert.equal("clientSecret" in transaction, false);
});

test("public email state never exposes OAuth tokens or client ids", () => {
  const state = publicEmailConnections({ connectors: { email: {
    draftOnly: false,
    gmail: { connected: true, account: "person@example.com", clientId: "public-id", oauth: { accessToken: "secret", refreshToken: "secret2" } }
  } } });
  assert.deepEqual(state.gmail, {
    provider: "gmail", connected: true, ready: true, account: "person@example.com",
    hasClientId: true, managedAvailable: false, manualAvailable: true,
    connectionMode: "manual", health: "ready", lastCheck: "", lastCheckedAt: 0,
    supportsCleanup: true
  });
  assert.equal(state.draftOnly, false);
  assert.equal(state.confirmBeforeSend, true);
  assert.doesNotMatch(JSON.stringify(state), /secret|public-id/);
});

test("public email readiness rejects an expired access-only connection", () => {
  const state = publicEmailConnections({ connectors: { email: {
    gmail: { connected: true, account: "person@example.com", oauth: { accessToken: "expired", expiresAt: Date.now() - 1000 } }
  } } });
  assert.equal(state.gmail.connected, true);
  assert.equal(state.gmail.ready, false);
  assert.equal(state.gmail.health, "attention");
});

test("managed email setup exposes availability without exposing public client ids", () => {
  const state = publicEmailConnections({ connectors: { email: {} } }, {
    gmail: "google-public-client-id",
    outlook: "microsoft-public-client-id"
  });
  assert.equal(state.gmail.managedAvailable, true);
  assert.equal(state.outlook.managedAvailable, true);
  assert.equal(state.gmail.connectionMode, "managed");
  assert.doesNotMatch(JSON.stringify(state), /google-public|microsoft-public/);
});

test("Outlook advertises safe cleanup support when connected", () => {
  const state = publicEmailConnections({ connectors: { email: {
    outlook: { connected: true, account: "person@outlook.com", oauth: { accessToken: "ok", refreshToken: "refresh" } }
  } } });
  assert.equal(state.outlook.ready, true);
  assert.equal(state.outlook.supportsCleanup, true);
});

test("Gmail metadata scan follows pages without loading message bodies", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/messages?") && !value.includes("pageToken=")) {
      return new Response(JSON.stringify({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "next" }), { status: 200 });
    }
    if (value.includes("pageToken=next")) return new Response(JSON.stringify({ messages: [{ id: "c" }] }), { status: 200 });
    const id = value.match(/\/messages\/([^?]+)/)?.[1] || "";
    return new Response(JSON.stringify({ id, threadId: `t-${id}`, labelIds: ["CATEGORY_PROMOTIONS"], snippet: "Sale", payload: { headers: [{ name: "From", value: "shop@example.com" }, { name: "Subject", value: `Offer ${id}` }] } }), { status: 200 });
  };
  try {
    const connection = { connected: true, oauth: { accessToken: "token", expiresAt: Date.now() + 120000 } };
    const rows = await scanEmailMetadata("gmail", connection, () => {}, "older_than:2y", { limit: 3, concurrency: 2 });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.id), ["a", "b", "c"]);
    assert.ok(calls.every((url) => !url.includes("format=full")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail cleanup uses reversible trash and untrash endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify({ id: "message-1" }), { status: 200 });
  };
  try {
    const connection = { connected: true, oauth: { accessToken: "token", expiresAt: Date.now() + 120000 } };
    await trashEmail("gmail", connection, () => {}, "message-1");
    await untrashEmail("gmail", connection, () => {}, { id: "message-1" });
    assert.match(calls[0].url, /message-1\/trash$/);
    assert.match(calls[1].url, /message-1\/untrash$/);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
