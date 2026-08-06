import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

async function serve(t, options = {}) {
  const app = await startServer(defaultConfig(), { port: 0, ...options });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  return { app, base: `http://127.0.0.1:${app.port}` };
}

test("the served page carries the launch token instead of the placeholder", async (t) => {
  const { base } = await serve(t, { sessionToken: "token-under-test" });

  const html = await (await fetch(base + "/")).text();

  assert.ok(html.includes(`const SAZ_TOKEN = "token-under-test"`), "token was not substituted into the page");
  assert.ok(!html.includes("__SAZ_SESSION_TOKEN__"), "placeholder survived into the served page");
});

test("a state-changing call without the launch token is refused", async (t) => {
  const { base } = await serve(t, { sessionToken: "token-under-test" });

  const noHeader = await fetch(base + "/api/settings/reset", { method: "POST", body: "{}" });
  assert.equal(noHeader.status, 403);

  // the old constant is no longer a valid credential
  const staleConstant = await fetch(base + "/api/settings/reset", {
    method: "POST",
    headers: { "x-saz": "1" },
    body: "{}"
  });
  assert.equal(staleConstant.status, 403);

  const wrongToken = await fetch(base + "/api/settings/reset", {
    method: "POST",
    headers: { "x-saz": "token-under-test-but-wrong" },
    body: "{}"
  });
  assert.equal(wrongToken.status, 403);
});

test("the launch token admits a state-changing call", async (t) => {
  const { base } = await serve(t, { sessionToken: "token-under-test" });

  const response = await fetch(base + "/api/settings/reset", {
    method: "POST",
    headers: { "x-saz": "token-under-test" },
    body: "{}"
  });

  assert.notEqual(response.status, 403);
});

test("each launch mints a different token", async (t) => {
  const first = await serve(t);
  const second = await serve(t);

  const readToken = async (base) => {
    const html = await (await fetch(base + "/")).text();
    return html.match(/const SAZ_TOKEN = "([^"]+)"/)?.[1];
  };

  const a = await readToken(first.base);
  const b = await readToken(second.base);

  assert.ok(a && a.length >= 32, `token looks too weak: ${a}`);
  assert.notEqual(a, b, "two launches shared a token");
});
