import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { cloudflareCommandEnv, executeTool } from "../src/tools.js";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(String(url), opts);
  return () => { globalThis.fetch = original; };
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => ({ success: true, result: body }) });

function ctxWith(cloudflare) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-cf-"));
  return {
    projectDir,
    config: { connectors: { cloudflare } },
    approve: async () => true,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true })
  };
}

test("full access lets the agent call endpoints outside the connected account", async () => {
  let hit = "";
  const restore = stubFetch((url) => { hit = url; return okJson([{ id: "tok" }]); });
  const ctx = ctxWith({ connected: true, token: "cfat_x", accountId: "acc1", fullAccess: true });
  try {
    const out = await executeTool("cloudflare_api_request", { method: "GET", path: "/user/tokens" }, ctx);
    assert.match(hit, /\/user\/tokens$/, "the request reached the user-level endpoint");
    assert.doesNotMatch(out, /^error:/, "full access does not block the out-of-account path");
  } finally { restore(); ctx.cleanup(); }
});

test("scoped mode (full access off) still blocks endpoints outside the account", async () => {
  const restore = stubFetch(() => okJson([]));
  const ctx = ctxWith({ connected: true, token: "t", accountId: "acc1", fullAccess: false });
  try {
    const out = await executeTool("cloudflare_api_request", { method: "GET", path: "/user/tokens" }, ctx);
    assert.match(out, /^error:/, "the account-path guard rejects it");
    assert.match(out, /connected Cloudflare account/i);
  } finally { restore(); ctx.cleanup(); }
});

test("full access injects the token only for a direct Wrangler command", () => {
  const token = "cfat_env_probe_UNIQUE_9f3";
  const on = ctxWith({ connected: true, token, accountId: "acc1", fullAccess: true });
  try {
    assert.equal(cloudflareCommandEnv(on, "npx.cmd wrangler deploy")?.CLOUDFLARE_API_TOKEN, token);
    assert.equal(cloudflareCommandEnv(on, "wrangler pages deploy dist")?.CLOUDFLARE_API_TOKEN, token);
    assert.equal(cloudflareCommandEnv(on, "Write-Output $env:CLOUDFLARE_API_TOKEN"), undefined);
    assert.equal(cloudflareCommandEnv(on, "wrangler deploy; Write-Output $env:CLOUDFLARE_API_TOKEN"), undefined);
  } finally { on.cleanup(); }

  const off = ctxWith({ connected: true, token, accountId: "acc1", fullAccess: false });
  try {
    assert.equal(cloudflareCommandEnv(off, "npx.cmd wrangler deploy"), undefined);
  } finally { off.cleanup(); }
});
