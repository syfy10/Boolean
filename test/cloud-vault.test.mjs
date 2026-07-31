import test from "node:test";
import assert from "node:assert/strict";
import { cloudVaultSnapshot, cloudVaultSummary, mergeCloudVault } from "../src/cloud-vault.js";

test("admin cloud vault captures every supported API key and connection credential", () => {
  const config = {
    openai: { baseUrl: "https://api.openai.com/v1", model: "gpt", apiKey: "openai-secret" },
    google: { baseUrl: "https://google.test", model: "gemini", apiKey: "google-secret" },
    connectors: {
      apis: [{ id: "api-1", baseUrl: "https://api.test", apiKey: "api-secret" }],
      mcp: [{ id: "mcp-1", url: "https://mcp.test", token: "mcp-secret", oauth: { refreshToken: "refresh" } }],
      agents: [{ id: "agent-1", url: "https://agent.test", apiKey: "agent-secret" }],
      cloudflare: { connected: true, token: "cf-secret", accountId: "account" },
      azure: { connected: true, tenantId: "tenant", clientId: "client", clientSecret: "azure-secret" },
      aws: { connected: true, accessKeyId: "access", secretAccessKey: "aws-secret" },
      googleCloud: { connected: true, serviceAccount: { private_key: "gcp-secret" } },
      marketData: { provider: "alphaVantage", apiKey: "market-secret" },
      email: {
        accounts: [{ id: "gmail:user@test", account: "user@test", oauth: { refreshToken: "mail-secret" } }],
        gmail: { connected: true, account: "user@test", oauth: { refreshToken: "gmail-secret" } },
        outlook: { connected: false, oauth: null }
      }
    }
  };
  const vault = cloudVaultSnapshot(config);
  assert.equal(vault.providers.openai.apiKey, "openai-secret");
  assert.equal(vault.providers.google.apiKey, "google-secret");
  assert.equal(vault.connectors.mcp[0].oauth.refreshToken, "refresh");
  assert.equal(vault.connectors.cloudflare.token, "cf-secret");
  assert.equal(vault.connectors.email.gmail.oauth.refreshToken, "gmail-secret");
  assert.deepEqual(cloudVaultSummary(vault), { providers: 2, connections: 10 });
});

test("admin cloud vault restores missing credentials without replacing local choices", () => {
  const local = {
    openai: { baseUrl: "https://local.test", model: "local-model", apiKey: "" },
    connectors: { apis: [], mcp: [], agents: [], email: { accounts: [], gmail: {}, outlook: {} } }
  };
  const remote = {
    providers: { openai: { baseUrl: "https://remote.test", model: "remote-model", apiKey: "restored-secret" } },
    connectors: {
      apis: [{ id: "api-1", baseUrl: "https://api.test", apiKey: "api-secret" }],
      mcp: [], agents: [], email: { accounts: [] }
    }
  };
  const result = mergeCloudVault(local, remote);
  assert.equal(result.changed, true);
  assert.equal(local.openai.apiKey, "restored-secret");
  assert.equal(local.openai.baseUrl, "https://local.test");
  assert.equal(local.openai.model, "local-model");
  assert.equal(local.connectors.apis[0].apiKey, "api-secret");
});
