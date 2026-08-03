import crypto from "node:crypto";

const API_BASE = "https://api.cloudflare.com/client/v4";
const OAUTH_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const OAUTH_TOKEN = "https://dash.cloudflare.com/oauth2/token";

function errorMessage(payload, fallback) {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => item?.message).filter(Boolean)
    : [];
  return messages.join("; ") || fallback;
}

// Cloudflare has two credential shapes and they authenticate differently:
//   - API token (recommended, scopable) → Authorization: Bearer <token>
//   - Global API Key (legacy, account-wide) → X-Auth-Email + X-Auth-Key
// A Global API Key sent as a bearer token is rejected by every endpoint, so the
// credential decides the headers. Accepts a plain token string (the long-standing
// call shape) or a credential object { token, email, authType }.
export function cloudflareAuthHeaders(credential) {
  if (credential && typeof credential === "object") {
    const key = String(credential.token || credential.key || "").trim();
    const email = String(credential.email || "").trim();
    if (!key) throw new Error("Cloudflare API token is not configured.");
    if (String(credential.authType || "") === "global" || email) {
      if (!email) throw new Error("A Cloudflare Global API Key also needs the account email.");
      return { "x-auth-email": email, "x-auth-key": key };
    }
    return { authorization: `Bearer ${key}` };
  }
  const token = String(credential || "").trim();
  if (!token) throw new Error("Cloudflare API token is not configured.");
  return { authorization: `Bearer ${token}` };
}

export function isGlobalKeyCredential(credential) {
  return !!credential && typeof credential === "object"
    && (String(credential.authType || "") === "global" || !!String(credential.email || "").trim());
}

export async function cloudflareRequest(token, path, options = {}) {
  const authHeaders = cloudflareAuthHeaders(token);
  const cleanPath = String(path || "").trim();
  if (!cleanPath.startsWith("/") || cleanPath.startsWith("//")) throw new Error("Enter a valid Cloudflare API path.");
  const response = await fetch(`${API_BASE}${cleanPath}`, {
    method: String(options.method || "GET").toUpperCase(),
    headers: {
      ...authHeaders,
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(errorMessage(payload, `Cloudflare API request failed (HTTP ${response.status}).`));
  }
  return payload;
}

async function accessibleCloudflareAccounts(token) {
  const accountsPayload = await cloudflareRequest(token, "/accounts?per_page=50");
  return Array.isArray(accountsPayload?.result)
    ? accountsPayload.result.map((account) => ({
      id: String(account?.id || ""),
      name: String(account?.name || "Cloudflare account"),
      type: String(account?.type || "")
    })).filter((account) => account.id)
    : [];
}

// A Global API Key has no /user/tokens/verify equivalent — it is not a token and
// has no id, status, or expiry. Proving it works means using it.
export async function verifyCloudflareGlobalKey(email, key) {
  const credential = { authType: "global", email: String(email || "").trim(), token: String(key || "").trim() };
  if (!credential.email) throw new Error("Enter the Cloudflare account email that owns this Global API Key.");
  if (!credential.token) throw new Error("Paste your Cloudflare Global API Key.");
  const accounts = await accessibleCloudflareAccounts(credential);
  return { tokenId: "", status: "active", expiresOn: "", accounts };
}

export async function verifyCloudflareToken(token) {
  // Classic API tokens verify via /user/tokens/verify. Newer prefixed tokens
  // (cfat_…) and account-scoped tokens frequently do NOT support that endpoint
  // even though they can call the rest of the API — so a token that works fine
  // elsewhere would otherwise be rejected here. When the verify endpoint is
  // unavailable, fall back to proving the token works by listing accounts, the
  // same way the OAuth path does. A genuinely invalid token still fails there.
  let verified = null;
  try {
    verified = await cloudflareRequest(token, "/user/tokens/verify");
  } catch {
    const accounts = await accessibleCloudflareAccounts(token);
    return { tokenId: "", status: "active", expiresOn: "", accounts };
  }
  if (verified?.result?.status !== "active") {
    throw new Error(`Cloudflare API token is ${verified?.result?.status || "not active"}.`);
  }
  const accounts = await accessibleCloudflareAccounts(token);
  return {
    tokenId: String(verified?.result?.id || ""),
    status: "active",
    expiresOn: String(verified?.result?.expires_on || ""),
    accounts
  };
}

export async function verifyCloudflareOAuthToken(token) {
  const accounts = await accessibleCloudflareAccounts(token);
  return {
    tokenId: "",
    status: "active",
    expiresOn: "",
    accounts
  };
}

export function createCloudflareOAuth(clientId, redirectUri, scopes = []) {
  const cleanClientId = String(clientId || "").trim();
  const cleanRedirectUri = String(redirectUri || "").trim();
  const cleanScopes = Array.isArray(scopes)
    ? scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
    : String(scopes || "").split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
  if (!cleanClientId) throw new Error("Enter the Cloudflare OAuth client ID.");
  if (!/^https?:\/\//i.test(cleanRedirectUri)) throw new Error("Enter a valid Cloudflare OAuth redirect URL.");
  if (!cleanScopes.length) throw new Error("Choose at least one Cloudflare OAuth scope.");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", cleanClientId);
  url.searchParams.set("redirect_uri", cleanRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cleanScopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    state,
    verifier,
    clientId: cleanClientId,
    redirectUri: cleanRedirectUri,
    scopes: cleanScopes,
    authorizationUrl: url.toString(),
    createdAt: Date.now()
  };
}

export async function exchangeCloudflareOAuthCode(transaction, code) {
  const form = new URLSearchParams({
    client_id: transaction.clientId,
    code: String(code || "").trim(),
    code_verifier: transaction.verifier,
    grant_type: "authorization_code",
    redirect_uri: transaction.redirectUri
  });
  const response = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Cloudflare authorization failed (HTTP ${response.status}).`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: data.expires_in ? Date.now() + Math.max(60, Number(data.expires_in)) * 1000 : 0,
    scope: data.scope || transaction.scopes.join(" "),
    tokenType: data.token_type || "Bearer"
  };
}

export async function cloudflareResourceList(connection, resource) {
  const accountId = String(connection?.accountId || "").trim();
  if (!accountId) throw new Error("Choose a Cloudflare account first.");
  const paths = {
    zones: `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`,
    workers: `/accounts/${accountId}/workers/scripts`,
    pages: `/accounts/${accountId}/pages/projects?per_page=50`,
    d1: `/accounts/${accountId}/d1/database?per_page=50`,
    r2: `/accounts/${accountId}/r2/buckets?per_page=50`
  };
  const path = paths[resource];
  if (!path) throw new Error("Unsupported Cloudflare resource.");
  return await cloudflareRequest(connection, path);
}

export async function assertCloudflarePath(connection, path, method = "GET") {
  const accountId = String(connection?.accountId || "").trim();
  const cleanPath = String(path || "").trim();
  const cleanMethod = String(method || "GET").toUpperCase();
  if (!accountId) throw new Error("Choose a Cloudflare account first.");
  if (cleanPath === `/accounts/${accountId}` || cleanPath.startsWith(`/accounts/${accountId}/`)) return cleanPath;
  if (cleanPath === "/zones" || cleanPath.startsWith("/zones?")) {
    if (cleanMethod !== "GET") throw new Error("Zone collection changes are not supported.");
    return cleanPath;
  }
  const zoneMatch = cleanPath.match(/^\/zones\/([a-f0-9]{32})(?:\/|$)/i);
  if (!zoneMatch) throw new Error("The request must target the connected Cloudflare account.");
  const zone = await cloudflareRequest(connection, `/zones/${zoneMatch[1]}`);
  if (String(zone?.result?.account?.id || "") !== accountId) {
    throw new Error("That zone does not belong to the connected Cloudflare account.");
  }
  return cleanPath;
}
