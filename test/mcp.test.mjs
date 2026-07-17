import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildMcpAuthorizationUrl,
  createPkce,
  McpHttpError,
  mcpTestConnection,
  protectedResourceMetadataUrl
} from "../src/mcp.js";

test("extracts OAuth protected resource metadata from a Bearer challenge", () => {
  const header = 'Bearer realm="mcp", resource_metadata="https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"';
  assert.equal(
    protectedResourceMetadataUrl(header),
    "https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"
  );
});

test("creates an S256 PKCE pair", () => {
  const pair = createPkce();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pair.verifier, pair.challenge);
});

test("builds a resource-bound MCP authorization URL", () => {
  const url = new URL(buildMcpAuthorizationUrl({
    authorizationEndpoint: "https://robinhood.com/oauth",
    scope: "internal",
    resource: "https://agent.robinhood.com/mcp/trading"
  }, { client_id: "boolean-client" }, "http://localhost:8765/mcp/oauth/callback", "state-1", "challenge-1"));
  assert.equal(url.origin + url.pathname, "https://robinhood.com/oauth");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "boolean-client");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8765/mcp/oauth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "internal");
  assert.equal(url.searchParams.get("resource"), "https://agent.robinhood.com/mcp/trading");
});

test("does not mark an MCP server connected when tools/list needs sign-in", async () => {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (body.method === "initialize") {
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1"
      });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "Protected MCP" } }
      }));
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end("");
      return;
    }
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="mcp", resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"'
    });
    res.end(JSON.stringify({ error: "login_required" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => mcpTestConnection({ url: `http://127.0.0.1:${port}/mcp` }),
      (error) => error instanceof McpHttpError && error.status === 401
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
