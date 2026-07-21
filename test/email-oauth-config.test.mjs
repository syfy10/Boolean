import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emailOAuthRedirectUri, loadManagedEmailOAuthClients } from "../src/email-oauth-config.js";

test("managed email OAuth clients load from a public config with environment overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-email-oauth-"));
  const file = path.join(dir, "oauth-clients.json");
  fs.writeFileSync(file, JSON.stringify({ gmail: "file-google", outlook: "file-microsoft" }));
  try {
    const clients = loadManagedEmailOAuthClients({
      filePaths: [file],
      env: { BOOLEAN_GOOGLE_OAUTH_CLIENT_ID: "env-google" }
    });
    assert.deepEqual(clients, { gmail: "env-google", outlook: "file-microsoft" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("email OAuth loopback redirects match desktop provider requirements", () => {
  assert.equal(emailOAuthRedirectUri("gmail", "127.0.0.1:8765"), "http://127.0.0.1:8765/email/oauth/callback");
  assert.equal(emailOAuthRedirectUri("outlook", "127.0.0.1:8765"), "http://localhost:8765/");
  assert.throws(() => emailOAuthRedirectUri("other", "127.0.0.1:8765"), /unsupported/);
});
