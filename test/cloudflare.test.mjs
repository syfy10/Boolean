import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCloudflarePath,
  createCloudflareOAuth,
  cloudflareResourceList,
  exchangeCloudflareOAuthCode,
  verifyCloudflareOAuthToken,
  verifyCloudflareToken
} from "../src/cloudflare.js";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

test("verifies a Cloudflare token and returns accessible accounts", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/user/tokens/verify")) {
      return response({ success: true, result: { id: "token-id", status: "active" } });
    }
    return response({ success: true, result: [{ id: "a".repeat(32), name: "Demo", type: "standard" }] });
  };
  try {
    const result = await verifyCloudflareToken("secret-token");
    assert.equal(result.status, "active");
    assert.deepEqual(result.accounts, [{ id: "a".repeat(32), name: "Demo", type: "standard" }]);
    assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifies a Cloudflare OAuth token without the API-token verification endpoint", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return response({ success: true, result: [{ id: "b".repeat(32), name: "OAuth Demo", type: "standard" }] });
  };
  try {
    const result = await verifyCloudflareOAuthToken("oauth-access-token");
    assert.equal(result.status, "active");
    assert.equal(result.tokenId, "");
    assert.deepEqual(result.accounts, [{ id: "b".repeat(32), name: "OAuth Demo", type: "standard" }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/accounts\?per_page=50$/);
    assert.doesNotMatch(calls[0].url, /\/user\/tokens\/verify$/);
    assert.equal(calls[0].options.headers.authorization, "Bearer oauth-access-token");
  } finally {
    global.fetch = originalFetch;
  }
});

test("resource inventory remains scoped to the selected Cloudflare account", async () => {
  const originalFetch = global.fetch;
  let requested = "";
  global.fetch = async (url) => {
    requested = url;
    return response({ success: true, result: [] });
  };
  try {
    await cloudflareResourceList({ token: "token", accountId: "b".repeat(32) }, "workers");
    assert.match(requested, new RegExp(`/accounts/${"b".repeat(32)}/workers/scripts$`));
  } finally {
    global.fetch = originalFetch;
  }
});

test("advanced Cloudflare paths reject requests outside the connected account", async () => {
  const connection = { token: "token", accountId: "c".repeat(32) };
  await assert.rejects(
    () => assertCloudflarePath(connection, `/accounts/${"d".repeat(32)}/workers/scripts`, "GET"),
    /connected Cloudflare account/
  );
  assert.equal(
    await assertCloudflarePath(connection, `/accounts/${"c".repeat(32)}/pages/projects`, "POST"),
    `/accounts/${"c".repeat(32)}/pages/projects`
  );
});

test("creates Cloudflare desktop OAuth authorization with PKCE", () => {
  const result = createCloudflareOAuth(
    "client-123",
    "https://boollm.com/oauth/cloudflare/callback",
    ["workers-platform.read", "account-settings.read"]
  );
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/oauth2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://boollm.com/oauth/cloudflare/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("scope"), "workers-platform.read account-settings.read");
  assert.ok(result.verifier.length >= 43);
});

test("exchanges a Cloudflare OAuth authorization code without a client secret", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return response({ access_token: "oauth-token", refresh_token: "refresh", expires_in: 3600, scope: "workers-platform.read" });
  };
  try {
    const oauth = await exchangeCloudflareOAuthCode({
      clientId: "client-123",
      redirectUri: "https://boollm.com/oauth/cloudflare/callback",
      verifier: "verifier",
      scopes: ["workers-platform.read"]
    }, "code-123");
    assert.equal(oauth.accessToken, "oauth-token");
    assert.equal(request.url, "https://dash.cloudflare.com/oauth2/token");
    const form = new URLSearchParams(request.options.body);
    assert.equal(form.get("code_verifier"), "verifier");
    assert.equal(form.get("client_secret"), null);
  } finally {
    global.fetch = originalFetch;
  }
});
