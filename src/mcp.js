import crypto from "node:crypto";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLIENT_INFO = { name: "Boolean", version: "1.0" };

export class McpHttpError extends Error {
  constructor(message, { status = 0, authHeader = "", body = "" } = {}) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
    this.authHeader = authHeader;
    this.body = body;
  }
}

function safeHttpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return parsed.toString();
}

function parseRpcResponse(contentType, text) {
  let data = null;
  if (String(contentType || "").toLowerCase().includes("text/event-stream")) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.match(/^data:\s*(.*)$/);
      if (!match) continue;
      try {
        const item = JSON.parse(match[1]);
        if (item && (item.result !== undefined || item.error !== undefined || item.id !== undefined)) data = item;
      } catch { /* ignore SSE comments and non-JSON events */ }
    }
  } else if (String(text || "").trim()) {
    try { data = JSON.parse(text); } catch { /* handled by caller */ }
  }
  return data;
}

export async function mcpStreamableRpc(url, token, sessionId, payload, { timeoutMs = 12000 } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal, redirect: "follow"
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("connection timed out");
    const raw = err?.message || "";
    throw new Error(/fetch failed|network|ENOTFOUND|ECONN/i.test(raw)
      ? "could not reach the server (check the URL)"
      : (raw || "could not reach the server"));
  } finally {
    clearTimeout(timer);
  }

  const nextSessionId = response.headers.get("mcp-session-id") || sessionId || "";
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const data = parseRpcResponse(contentType, text);
  if (response.status === 401 || response.status === 403) {
    throw new McpHttpError(response.status === 401 ? "sign-in required" : "access denied", {
      status: response.status,
      authHeader: response.headers.get("www-authenticate") || "",
      body: text
    });
  }
  if (!response.ok && !data) throw new McpHttpError(`server returned HTTP ${response.status}`, { status: response.status, body: text });
  return { data, sessionId: nextSessionId };
}

function connectorAccessToken(connector) {
  return connector?.oauth?.accessToken || connector?.token || "";
}

async function initialize(connector) {
  return await mcpStreamableRpc(connector.url, connectorAccessToken(connector), "", {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }
  });
}

export async function refreshMcpOAuth(connector) {
  const oauth = connector?.oauth;
  if (!oauth?.refreshToken || !oauth?.tokenEndpoint || !oauth?.clientId) return false;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId
  });
  if (oauth.scope) form.set("scope", oauth.scope);
  if (connector.url) form.set("resource", connector.url);
  if (oauth.clientSecret) form.set("client_secret", oauth.clientSecret);
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) return false;
  oauth.accessToken = data.access_token;
  if (data.refresh_token) oauth.refreshToken = data.refresh_token;
  oauth.expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0;
  oauth.scope = data.scope || oauth.scope || "";
  return true;
}

async function withRefresh(connector, operation, onRefresh) {
  try {
    return await operation();
  } catch (err) {
    if (!(err instanceof McpHttpError) || err.status !== 401 || !await refreshMcpOAuth(connector)) throw err;
    await onRefresh?.(connector);
    return await operation();
  }
}

export async function mcpTestConnection(connector, { onRefresh } = {}) {
  if (!/^https?:\/\//i.test(String(connector?.url || ""))) throw new Error("Enter a valid http(s) MCP URL");
  return await withRefresh(connector, async () => {
    const init = await initialize(connector);
    if (init.data?.error) throw new Error(init.data.error.message || "the server rejected initialize");
    if (!init.data?.result) throw new Error("not an MCP server (no initialize result)");
    const info = init.data.result.serverInfo || {};
    const protocol = init.data.result.protocolVersion || "";
    const sessionId = init.sessionId;
    try {
      await mcpStreamableRpc(connector.url, connectorAccessToken(connector), sessionId, {
        jsonrpc: "2.0", method: "notifications/initialized"
      });
    } catch { /* notification is best-effort */ }
    let tools = [];
    try {
      const list = await mcpStreamableRpc(connector.url, connectorAccessToken(connector), sessionId, {
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
      });
      tools = Array.isArray(list.data?.result?.tools) ? list.data.result.tools : [];
    } catch { /* a server can connect without exposing tools */ }
    return {
      serverName: info.name || "",
      serverVersion: info.version || "",
      protocol,
      tools,
      toolCount: tools.length
    };
  }, onRefresh);
}

export async function mcpCallTool(connector, toolName, args = {}, { onRefresh } = {}) {
  return await withRefresh(connector, async () => {
    const init = await initialize(connector);
    if (!init.data?.result) throw new Error(init.data?.error?.message || "MCP initialize failed");
    const sessionId = init.sessionId;
    try {
      await mcpStreamableRpc(connector.url, connectorAccessToken(connector), sessionId, {
        jsonrpc: "2.0", method: "notifications/initialized"
      });
    } catch { /* best-effort */ }
    const called = await mcpStreamableRpc(connector.url, connectorAccessToken(connector), sessionId, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: args || {} }
    }, { timeoutMs: 60000 });
    if (called.data?.error) throw new Error(called.data.error.message || "MCP tool call failed");
    return called.data?.result || {};
  }, onRefresh);
}

export function protectedResourceMetadataUrl(authHeader) {
  const match = String(authHeader || "").match(/resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i);
  return match ? (match[1] || match[2] || "") : "";
}

async function getJson(url, label) {
  const response = await fetch(safeHttpsUrl(url, label), {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000), redirect: "follow"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return data;
}

export async function discoverMcpOAuth(resourceUrl, authHeader) {
  const metadataUrl = protectedResourceMetadataUrl(authHeader);
  if (!metadataUrl) throw new Error("the server requires authorization but did not provide OAuth metadata");
  const resource = await getJson(metadataUrl, "OAuth resource metadata");
  const issuer = Array.isArray(resource.authorization_servers) ? resource.authorization_servers[0] : "";
  if (!issuer) throw new Error("OAuth resource metadata did not name an authorization server");
  const base = new URL(safeHttpsUrl(issuer, "OAuth authorization server"));
  const wellKnown = new URL("/.well-known/oauth-authorization-server", base.origin).toString();
  const authorization = await getJson(wellKnown, "OAuth authorization metadata");
  return {
    resource: resource.resource || resourceUrl,
    scope: (Array.isArray(resource.scopes_supported) && resource.scopes_supported[0]) ||
      (Array.isArray(authorization.scopes_supported) && authorization.scopes_supported[0]) || "",
    authorizationEndpoint: safeHttpsUrl(authorization.authorization_endpoint, "OAuth authorization endpoint"),
    tokenEndpoint: safeHttpsUrl(authorization.token_endpoint, "OAuth token endpoint"),
    registrationEndpoint: safeHttpsUrl(authorization.registration_endpoint, "OAuth registration endpoint")
  };
}

export function createPkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function registerMcpOAuthClient(registrationEndpoint, redirectUri) {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Boolean",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.client_id) throw new Error(data.error_description || data.error || `OAuth client registration failed (HTTP ${response.status})`);
  return data;
}

export function buildMcpAuthorizationUrl(metadata, client, redirectUri, state, challenge) {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (metadata.scope) url.searchParams.set("scope", metadata.scope);
  if (metadata.resource) url.searchParams.set("resource", metadata.resource);
  return url.toString();
}

export async function exchangeMcpAuthorizationCode(transaction, code) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: transaction.clientId,
    redirect_uri: transaction.redirectUri,
    code_verifier: transaction.verifier
  });
  if (transaction.clientSecret) form.set("client_secret", transaction.clientSecret);
  if (transaction.resource) form.set("resource", transaction.resource);
  const response = await fetch(transaction.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `token exchange failed (HTTP ${response.status})`);
  return data;
}
