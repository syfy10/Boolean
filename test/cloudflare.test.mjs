import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCloudflarePath,
  cloudflareResourceList,
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
