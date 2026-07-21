import fs from "node:fs";
import { appPath } from "./paths.js";

const ENV_KEYS = {
  gmail: "BOOLEAN_GOOGLE_OAUTH_CLIENT_ID",
  outlook: "BOOLEAN_MICROSOFT_OAUTH_CLIENT_ID"
};

const cleanClientId = (value) => String(value || "").trim();

export function loadManagedEmailOAuthClients({ env = process.env, filePaths } = {}) {
  const clients = { gmail: "", outlook: "" };
  const candidates = Array.isArray(filePaths)
    ? filePaths
    : [appPath("oauth-clients.json"), appPath("assets", "oauth-clients.json")];

  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      clients.gmail ||= cleanClientId(parsed.gmail || parsed.google);
      clients.outlook ||= cleanClientId(parsed.outlook || parsed.microsoft);
    } catch {
      // A missing or malformed optional file should not prevent Boolean starting.
    }
  }

  for (const [provider, key] of Object.entries(ENV_KEYS)) {
    const value = cleanClientId(env?.[key]);
    if (value) clients[provider] = value;
  }
  return clients;
}

export function emailOAuthRedirectUri(provider, requestHost) {
  if (!Object.hasOwn(ENV_KEYS, provider)) throw new Error("unsupported email provider");
  let port = "";
  try { port = new URL(`http://${requestHost || "127.0.0.1"}`).port; } catch { /* use default port */ }
  const callbackHost = provider === "gmail" ? "127.0.0.1" : "localhost";
  return `http://${callbackHost}${port ? `:${port}` : ""}/`;
}
