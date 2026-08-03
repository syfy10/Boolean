import test from "node:test";
import assert from "node:assert/strict";
import { verifyCloudflareToken } from "../src/cloudflare.js";

function stubFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((fragment) => String(url).includes(fragment));
    const r = key ? routes[key] : { ok: false, status: 404, body: { success: false, errors: [{ message: "not found" }] } };
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return () => { globalThis.fetch = original; };
}

test("classic token verifies via /user/tokens/verify and keeps its token id", async () => {
  const restore = stubFetch({
    "/user/tokens/verify": { ok: true, status: 200, body: { success: true, result: { status: "active", id: "tok_123", expires_on: "" } } },
    "/accounts": { ok: true, status: 200, body: { success: true, result: [{ id: "acc_1", name: "My Account" }] } }
  });
  try {
    const out = await verifyCloudflareToken("classic-token");
    assert.equal(out.tokenId, "tok_123");
    assert.equal(out.status, "active");
    assert.equal(out.accounts.length, 1);
    assert.equal(out.accounts[0].id, "acc_1");
  } finally { restore(); }
});

test("a cfat_ token that the verify endpoint rejects still connects via account listing", async () => {
  const restore = stubFetch({
    // Newer prefixed token: /user/tokens/verify is not supported -> 400.
    "/user/tokens/verify": { ok: false, status: 400, body: { success: false, errors: [{ message: "Unsupported token type" }] } },
    "/accounts": { ok: true, status: 200, body: { success: true, result: [{ id: "acc_9", name: "Prefixed Acct" }] } }
  });
  try {
    const out = await verifyCloudflareToken("cfat_realtoken");
    assert.equal(out.status, "active", "the token connects even though verify was unavailable");
    assert.equal(out.tokenId, "", "no token id when the verify endpoint could not be used");
    assert.equal(out.accounts[0].id, "acc_9", "accounts are discovered via the fallback");
  } finally { restore(); }
});

test("a genuinely invalid token still fails after the fallback", async () => {
  const restore = stubFetch({
    "/user/tokens/verify": { ok: false, status: 401, body: { success: false, errors: [{ message: "Invalid token" }] } },
    "/accounts": { ok: false, status: 401, body: { success: false, errors: [{ message: "Invalid token" }] } }
  });
  try {
    await assert.rejects(() => verifyCloudflareToken("bogus"), /Invalid token/);
  } finally { restore(); }
});
