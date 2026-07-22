import fs from "node:fs";
import { appPath } from "./paths.js";

const ENV_KEYS = {
  gmail: {
    clientId: "BOOLEAN_GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "BOOLEAN_GOOGLE_OAUTH_CLIENT_SECRET"
  },
  outlook: {
    clientId: "BOOLEAN_MICROSOFT_OAUTH_CLIENT_ID",
    clientSecret: "BOOLEAN_MICROSOFT_OAUTH_CLIENT_SECRET"
  }
};

const clean = (value) => String(value || "").trim();

const parsedCredential = (value, fallbackSecret = "") => {
  if (value && typeof value === "object") {
    return {
      clientId: clean(value.clientId || value.client_id || value.id),
      clientSecret: clean(value.clientSecret || value.client_secret || value.secret)
    };
  }
  return { clientId: clean(value), clientSecret: clean(fallbackSecret) };
};

export function managedEmailOAuthCredential(clients, provider) {
  const value = clients?.[provider];
  const suffix = provider === "gmail" ? "Gmail" : "Outlook";
  return parsedCredential(value, clients?.[`${provider}ClientSecret`] || clients?.[`${suffix}ClientSecret`]);
}

export function loadManagedEmailOAuthClients({ env = process.env, filePaths } = {}) {
  const clients = {
    gmail: { clientId: "", clientSecret: "" },
    outlook: { clientId: "", clientSecret: "" }
  };
  const candidates = Array.isArray(filePaths)
    ? filePaths
    : [appPath("oauth-clients.json"), appPath("assets", "oauth-clients.json")];

  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const gmail = parsedCredential(parsed.gmail || parsed.google, parsed.gmailClientSecret || parsed.googleClientSecret);
      const outlook = parsedCredential(parsed.outlook || parsed.microsoft, parsed.outlookClientSecret || parsed.microsoftClientSecret);
      clients.gmail.clientId ||= gmail.clientId;
      clients.gmail.clientSecret ||= gmail.clientSecret;
      clients.outlook.clientId ||= outlook.clientId;
      clients.outlook.clientSecret ||= outlook.clientSecret;
    } catch {
      // A missing or malformed optional file should not prevent Boolean starting.
    }
  }

  for (const [provider, keys] of Object.entries(ENV_KEYS)) {
    const clientId = clean(env?.[keys.clientId]);
    const clientSecret = clean(env?.[keys.clientSecret]);
    if (clientId) clients[provider].clientId = clientId;
    if (clientSecret) clients[provider].clientSecret = clientSecret;
  }
  return clients;
}

export function emailOAuthRedirectUri(provider, requestHost) {
  if (!Object.hasOwn(ENV_KEYS, provider)) throw new Error("unsupported email provider");
  let port = "";
  try { port = new URL(`http://${requestHost || "127.0.0.1"}`).port; } catch { /* use default port */ }
  if (provider === "gmail") return `http://127.0.0.1${port ? `:${port}` : ""}/email/oauth/callback`;
  return `http://localhost${port ? `:${port}` : ""}/`;
}
