const API_BASE = "https://api.cloudflare.com/client/v4";

function errorMessage(payload, fallback) {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => item?.message).filter(Boolean)
    : [];
  return messages.join("; ") || fallback;
}

export async function cloudflareRequest(token, path, options = {}) {
  const cleanToken = String(token || "").trim();
  const cleanPath = String(path || "").trim();
  if (!cleanToken) throw new Error("Cloudflare API token is not configured.");
  if (!cleanPath.startsWith("/") || cleanPath.startsWith("//")) throw new Error("Enter a valid Cloudflare API path.");
  const response = await fetch(`${API_BASE}${cleanPath}`, {
    method: String(options.method || "GET").toUpperCase(),
    headers: {
      authorization: `Bearer ${cleanToken}`,
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

export async function verifyCloudflareToken(token) {
  const verified = await cloudflareRequest(token, "/user/tokens/verify");
  if (verified?.result?.status !== "active") {
    throw new Error(`Cloudflare API token is ${verified?.result?.status || "not active"}.`);
  }
  const accountsPayload = await cloudflareRequest(token, "/accounts?per_page=50");
  const accounts = Array.isArray(accountsPayload?.result)
    ? accountsPayload.result.map((account) => ({
      id: String(account?.id || ""),
      name: String(account?.name || "Cloudflare account"),
      type: String(account?.type || "")
    })).filter((account) => account.id)
    : [];
  return {
    tokenId: String(verified?.result?.id || ""),
    status: "active",
    expiresOn: String(verified?.result?.expires_on || ""),
    accounts
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
  return await cloudflareRequest(connection.token, path);
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
  const zone = await cloudflareRequest(connection.token, `/zones/${zoneMatch[1]}`);
  if (String(zone?.result?.account?.id || "") !== accountId) {
    throw new Error("That zone does not belong to the connected Cloudflare account.");
  }
  return cleanPath;
}
