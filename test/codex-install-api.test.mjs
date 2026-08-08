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

function post(base, route) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-saz": "1" },
    body: "{}"
  });
}

test("Codex install endpoint is Windows-only and never invokes the installer elsewhere", async (t) => {
  let calls = 0;
  const app = await startServer(defaultConfig(), {
    port: 0,
    sessionToken: "1",
    codexPlatform: "linux",
    codexInstaller() { calls++; throw new Error("must not run"); }
  });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const response = await post(`http://127.0.0.1:${app.port}`, "/api/codex/install");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unsupported_platform",
    message: "Automatic Codex CLI setup is available on Windows only."
  });
  assert.equal(calls, 0);
});

test("Codex install endpoint rejects concurrent setup and returns bounded helper errors", async (t) => {
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const app = await startServer(defaultConfig(), {
    port: 0,
    sessionToken: "1",
    codexPlatform: "win32",
    codexInstaller() {
      calls++;
      begin();
      return pending;
    }
  });
  t.after(async () => {
    release?.({ ok: false, error: "install_failed", message: "mock setup stopped", output: "safe output" });
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;
  const first = post(base, "/api/codex/install");
  await started;
  const status = await fetch(`${base}/api/codex/status?start=1&refresh=1`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).installing, true);
  const recheck = await post(base, "/api/codex/recheck");
  assert.equal(recheck.status, 409);
  assert.equal((await recheck.json()).error, "install_in_progress");
  const auth = await post(base, "/api/codex/auth/start");
  assert.equal(auth.status, 409);
  assert.equal((await auth.json()).error, "install_in_progress");
  const duplicate = await post(base, "/api/codex/install");
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    ok: false,
    error: "install_in_progress",
    message: "Codex setup is already running."
  });
  release({ ok: false, error: "install_failed", message: "mock setup stopped", output: "safe output" });
  const response = await first;
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "install_failed",
    message: "mock setup stopped",
    output: "safe output",
    outputTruncated: false
  });
  assert.equal(calls, 1);
});

test("Codex sign-in locks before app-server startup and blocks a racing setup", async (t) => {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const client = {
    async start() { signalStarted(); await startGate; },
    async stop() {},
    async accountRead() { return { account: null }; },
    async modelList() { return { data: [] }; },
    getStatus() { return { state: "starting", running: true, ready: false, lastError: "" }; },
    async request(method) {
      if (method === "account/login/start") {
        return { loginId: "race-login", authUrl: "https://chatgpt.com/codex/auth?state=race" };
      }
      return {};
    }
  };
  const app = await startServer(defaultConfig(), {
    port: 0,
    sessionToken: "1",
    codexPlatform: "win32",
    codexClientFactory() { return client; },
    codexInstaller() { throw new Error("installer must not run during sign-in"); }
  });
  t.after(async () => {
    releaseStart?.();
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;
  const first = post(base, "/api/codex/auth/start");
  await started;

  const status = await (await fetch(`${base}/api/codex/status`)).json();
  assert.equal(status.loginPending, true);
  const second = await post(base, "/api/codex/auth/start");
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "login_in_progress");
  const install = await post(base, "/api/codex/install");
  assert.equal(install.status, 409);
  assert.equal((await install.json()).error, "login_in_progress");

  releaseStart();
  assert.equal((await first).status, 200);
});

test("Codex refresh clears stale account and model state after app-server rejection", async (t) => {
  let rejectRefresh = false;
  const client = {
    async start() {},
    async stop() {},
    async accountRead() {
      if (rejectRefresh) throw new Error("session expired");
      return { account: { email: "person@example.com", type: "chatgpt" } };
    },
    async modelList() {
      if (rejectRefresh) throw new Error("models unavailable");
      return { data: [{ id: "gpt-codex", displayName: "Codex" }] };
    },
    getStatus() { return { state: "ready", running: true, ready: true, lastError: "" }; }
  };
  const app = await startServer(defaultConfig(), {
    port: 0,
    sessionToken: "1",
    codexClientFactory() { return client; }
  });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;
  const initial = await (await fetch(`${base}/api/codex/status?start=1&refresh=1`)).json();
  assert.equal(initial.account?.signedIn, true);
  assert.equal(initial.models.length, 1);

  rejectRefresh = true;
  const refreshed = await post(base, "/api/codex/recheck");
  assert.equal(refreshed.status, 200);
  const body = await refreshed.json();
  assert.equal(body.account, null);
  assert.deepEqual(body.models, []);
});

test("Codex sign-in accepts only trusted ChatGPT URLs and permits one pending login", async (t) => {
  const starts = [
    { loginId: "bad-script", authUrl: "javascript:alert(1)" },
    { loginId: "bad-host", authUrl: "https://chatgpt.com.evil.example/login" },
    { loginId: "login-1", authUrl: "https://chatgpt.com/codex/auth?state=one" },
    { loginId: "login-2", authUrl: "https://auth.chatgpt.com/codex/auth?state=two" },
    { loginId: "login-3", authUrl: "https://chatgpt.com/codex/auth?state=three" }
  ];
  const requests = [];
  let clientOptions = null;
  let now = 1_000_000;
  const client = {
    async start() {},
    async stop() {},
    async accountRead() { return { account: null }; },
    async modelList() { return { data: [] }; },
    getStatus() { return { state: "ready", running: true, ready: true, lastError: "" }; },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "account/login/start") return starts.shift();
      return {};
    }
  };
  const app = await startServer(defaultConfig(), {
    port: 0,
    sessionToken: "1",
    codexNow: () => now,
    codexLoginTtlMs: 5 * 60 * 1000,
    codexClientFactory(options) { clientOptions = options; return client; }
  });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;

  const scriptUrl = await post(base, "/api/codex/auth/start");
  assert.equal(scriptUrl.status, 502);
  assert.equal((await scriptUrl.json()).error, "invalid_auth_url");
  assert.ok(requests.some((entry) => entry.method === "account/login/cancel" && entry.params.loginId === "bad-script"));

  const spoofedHost = await post(base, "/api/codex/auth/start");
  assert.equal(spoofedHost.status, 502);
  assert.equal((await spoofedHost.json()).error, "invalid_auth_url");

  const valid = await post(base, "/api/codex/auth/start");
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    ok: true,
    loginId: "login-1",
    authUrl: "https://chatgpt.com/codex/auth?state=one"
  });
  const repeated = await post(base, "/api/codex/auth/start");
  assert.equal(repeated.status, 409);
  assert.equal((await repeated.json()).error, "login_in_progress");
  assert.equal((await (await fetch(`${base}/api/codex/status`)).json()).loginPending, true);

  now += 5 * 60 * 1000 + 1;
  assert.equal((await (await fetch(`${base}/api/codex/status`)).json()).loginPending, false);
  const subdomain = await post(base, "/api/codex/auth/start");
  assert.equal(subdomain.status, 200);
  assert.equal((await subdomain.json()).authUrl, "https://auth.chatgpt.com/codex/auth?state=two");

  clientOptions.onEvent({ method: "account/login/completed", params: { loginId: "login-2", success: true } });
  assert.equal((await (await fetch(`${base}/api/codex/status`)).json()).loginPending, false);
  const cancellable = await post(base, "/api/codex/auth/start");
  assert.equal(cancellable.status, 200);
  assert.equal((await cancellable.json()).loginId, "login-3");
  const cancelled = await fetch(`${base}/api/codex/auth/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-saz": "1" },
    body: JSON.stringify({ loginId: "login-3" })
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await (await fetch(`${base}/api/codex/status`)).json()).loginPending, false);
});
