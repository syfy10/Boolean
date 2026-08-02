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

test("Claude Code setup endpoints report status, install once, and launch sign-in", async (t) => {
  let installed = false;
  let installCalls = 0;
  let loginCalls = 0;
  const config = defaultConfig();
  const app = await startServer(config, {
    port: 0,
    claudeStatusReader(command) {
      return installed
        ? { ready: true, installed: true, signedIn: true, command, version: "2.1.0", account: { email: "person@example.com" }, error: "" }
        : { ready: false, installed: false, signedIn: false, command, version: "", account: null, error: "not installed" };
    },
    async claudeInstaller() {
      installCalls++;
      installed = true;
      return { ok: true, installed: true, command: "claude", version: "2.1.0" };
    },
    claudeLoginStarter(command) {
      loginCalls++;
      return { ok: true, command, message: "sign-in opened" };
    }
  });
  t.after(async () => {
    await closeServer(app.server);
    await closeServer(app.proxyServer);
  });
  const base = `http://127.0.0.1:${app.port}`;

  const initial = await (await fetch(`${base}/api/claude-code/status?refresh=1`)).json();
  assert.equal(initial.installed, false);
  assert.equal(initial.ready, false);

  const install = await post(base, "/api/claude-code/install");
  assert.equal(install.status, 200);
  assert.equal((await install.json()).installed, true);
  assert.equal(installCalls, 1);

  const status = await (await fetch(`${base}/api/claude-code/status?refresh=1`)).json();
  assert.equal(status.ready, true);
  assert.equal(status.signedIn, true);
  assert.equal(status.account.email, "person@example.com");

  const login = await post(base, "/api/claude-code/auth/start");
  assert.equal(login.status, 200);
  assert.equal((await login.json()).message, "sign-in opened");
  assert.equal(loginCalls, 1);
});
