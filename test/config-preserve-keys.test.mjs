import test from "node:test";
import assert from "node:assert/strict";
import { preserveSavedApiKeys, preserveSavedConnections } from "../src/config.js";

test("config saves preserve existing API keys when new payload has blanks", () => {
  const previous = {
    openai: { apiKey: "sk-openai" },
    zaiCoding: { apiKey: "sk-zai" },
    customApi: { apiKey: "sk-custom" },
    connectors: {
      apis: [{ id: "api-1", apiKey: "sk-api-1" }],
      agents: [{ id: "agent-1", apiKey: "sk-agent-1" }]
    }
  };
  const next = {
    openai: { apiKey: "" },
    zaiCoding: { apiKey: "" },
    customApi: { apiKey: "" },
    connectors: {
      apis: [{ id: "api-1", apiKey: "" }],
      agents: [{ id: "agent-1", apiKey: "" }]
    }
  };

  preserveSavedApiKeys(next, previous);

  assert.equal(next.openai.apiKey, "sk-openai");
  assert.equal(next.zaiCoding.apiKey, "sk-zai");
  assert.equal(next.customApi.apiKey, "sk-custom");
  assert.equal(next.connectors.apis[0].apiKey, "sk-api-1");
  assert.equal(next.connectors.agents[0].apiKey, "sk-agent-1");
});

test("config key preservation does not restore deleted connector rows", () => {
  const previous = {
    connectors: {
      apis: [{ id: "api-1", apiKey: "sk-api-1" }],
      agents: [{ id: "agent-1", apiKey: "sk-agent-1" }]
    }
  };
  const next = { connectors: { apis: [], agents: [] } };

  preserveSavedApiKeys(next, previous);

  assert.deepEqual(next.connectors.apis, []);
  assert.deepEqual(next.connectors.agents, []);
});

test("config saves preserve MCP tokens, OAuth, and connection health", () => {
  const previous = {
    connectors: {
      mcp: [{
        id: "mcp-1",
        url: "https://example.test/mcp",
        token: "mcp-secret",
        oauth: { accessToken: "access", refreshToken: "refresh" },
        toolCount: 4,
        tools: ["search", "read"],
        lastTestStatus: "ok",
        needsReconnect: false
      }]
    }
  };
  const next = {
    connectors: {
      mcp: [{ id: "mcp-1", url: "https://example.test/mcp", token: "", oauth: null }]
    }
  };

  preserveSavedApiKeys(next, previous);

  assert.equal(next.connectors.mcp[0].token, "mcp-secret");
  assert.deepEqual(next.connectors.mcp[0].oauth, previous.connectors.mcp[0].oauth);
  assert.equal(next.connectors.mcp[0].toolCount, 4);
  assert.deepEqual(next.connectors.mcp[0].tools, ["search", "read"]);
  assert.equal(next.connectors.mcp[0].lastTestStatus, "ok");
  assert.equal(next.connectors.mcp[0].needsReconnect, false);
});

test("config MCP preservation does not restore deleted connector rows", () => {
  const previous = {
    connectors: { mcp: [{ id: "mcp-1", token: "secret", oauth: { refreshToken: "refresh" } }] }
  };
  const next = { connectors: { mcp: [] } };

  preserveSavedApiKeys(next, previous);

  assert.deepEqual(next.connectors.mcp, []);
});

test("config saves preserve email OAuth and local client secrets", () => {
  const previous = {
    connectors: {
      email: {
        gmail: {
          connected: true,
          account: "person@gmail.com",
          clientId: "google-client",
          manualClientId: "google-client",
          manualClientSecret: "google-secret",
          clientSource: "manual",
          oauth: { accessToken: "old-access", refreshToken: "old-refresh" }
        }
      }
    }
  };
  const next = {
    connectors: {
      email: {
        gmail: { connected: true, account: "person@gmail.com", manualClientSecret: "", oauth: null }
      }
    }
  };

  preserveSavedApiKeys(next, previous);

  assert.equal(next.connectors.email.gmail.clientId, "google-client");
  assert.equal(next.connectors.email.gmail.manualClientId, "google-client");
  assert.equal(next.connectors.email.gmail.manualClientSecret, "google-secret");
  assert.equal(next.connectors.email.gmail.clientSource, "manual");
  assert.deepEqual(next.connectors.email.gmail.oauth, previous.connectors.email.gmail.oauth);
  assert.equal(next.connectors.email.gmail.connected, true);
});

test("config saves restore email records overwritten by blank defaults", () => {
  const previous = {
    connectors: {
      email: {
        gmail: {
          connected: true,
          account: "person@gmail.com",
          clientId: "google-client",
          manualClientId: "google-client",
          manualClientSecret: "google-secret",
          clientSource: "manual",
          oauth: { accessToken: "old-access", refreshToken: "old-refresh" }
        }
      }
    }
  };
  const next = {
    connectors: {
      email: {
        gmail: {
          clientId: "",
          manualClientId: "",
          manualClientSecret: "",
          clientSource: "",
          connected: false,
          account: "",
          oauth: null
        }
      }
    }
  };

  preserveSavedApiKeys(next, previous);

  assert.deepEqual(next.connectors.email.gmail, previous.connectors.email.gmail);
});

test("config email preservation restores blank disconnected defaults", () => {
  const previous = {
    connectors: {
      email: {
        gmail: {
          connected: true,
          manualClientSecret: "google-secret",
          oauth: { accessToken: "old-access", refreshToken: "old-refresh" }
        }
      }
    }
  };
  const next = {
    connectors: {
      email: {
        gmail: { connected: false, manualClientSecret: "", oauth: null }
      }
    }
  };

  preserveSavedApiKeys(next, previous);

  assert.equal(next.connectors.email.gmail.manualClientSecret, "google-secret");
  assert.deepEqual(next.connectors.email.gmail.oauth, previous.connectors.email.gmail.oauth);
  assert.equal(next.connectors.email.gmail.connected, true);
});

test("ordinary config saves retain connector and email rows omitted by partial updates", () => {
  const previous = {
    connectors: {
      apis: [{ id: "api-1", name: "Saved API", apiKey: "secret" }],
      mcp: [{ id: "mcp-1", name: "Saved MCP", token: "token" }],
      agents: [{ id: "agent-1", name: "Saved agent", apiKey: "agent-secret" }],
      email: {
        gmail: { connected: true, account: "person@gmail.com", oauth: { refreshToken: "refresh" } }
      }
    }
  };
  const next = {
    ui: { theme: "dark" },
    connectors: { apis: [], mcp: [], agents: [], email: {} }
  };

  preserveSavedConnections(next, previous);

  assert.deepEqual(next.connectors.apis, previous.connectors.apis);
  assert.deepEqual(next.connectors.mcp, previous.connectors.mcp);
  assert.deepEqual(next.connectors.agents, previous.connectors.agents);
  assert.deepEqual(next.connectors.email.gmail, previous.connectors.email.gmail);
});

test("explicit connector replacement can still remove rows", () => {
  const previous = {
    connectors: {
      apis: [{ id: "api-1", apiKey: "secret" }],
      mcp: [{ id: "mcp-1", token: "token" }],
      agents: [{ id: "agent-1", apiKey: "agent-secret" }]
    }
  };
  const next = { connectors: { apis: [], mcp: [], agents: [] } };

  preserveSavedApiKeys(next, previous);

  assert.deepEqual(next.connectors.apis, []);
  assert.deepEqual(next.connectors.mcp, []);
  assert.deepEqual(next.connectors.agents, []);
});
