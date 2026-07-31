import { FIRST_PARTY_CLOUD_PROVIDERS } from "./config.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const text = (value) => typeof value === "string" ? value.trim() : "";

function providerSnapshot(config, id) {
  const source = config?.[id] || {};
  if (!text(source.apiKey)) return null;
  return {
    baseUrl: text(source.baseUrl), model: text(source.model), apiKey: source.apiKey,
    approvedUse: source.approvedUse === true, name: text(source.name), connectionId: text(source.connectionId)
  };
}

function savedRows(rows, secretFields) {
  return (Array.isArray(rows) ? rows : []).filter(row => secretFields.some(field => row?.[field])).map(clone);
}

function hasEmailCredential(row) {
  return !!row && (row.connected === true || !!row.oauth || !!text(row.manualClientSecret) || !!text(row.manualClientId) || !!text(row.clientId));
}

export function cloudVaultSnapshot(config = {}) {
  const providers = {};
  for (const id of [...FIRST_PARTY_CLOUD_PROVIDERS, "customApi"]) {
    const saved = providerSnapshot(config, id);
    if (saved) providers[id] = saved;
  }
  const connectors = config.connectors || {};
  const email = connectors.email || {};
  const snapshot = {
    version: 1,
    providers,
    connectors: {
      apis: savedRows(connectors.apis, ["apiKey"]),
      mcp: savedRows(connectors.mcp, ["token", "oauth"]),
      agents: savedRows(connectors.agents, ["apiKey"]),
      email: {
        draftOnly: email.draftOnly !== false,
        confirmBeforeSend: email.confirmBeforeSend !== false,
        accounts: savedRows(email.accounts, ["oauth", "manualClientSecret", "clientId", "manualClientId"]),
        gmail: hasEmailCredential(email.gmail) ? clone(email.gmail) : null,
        outlook: hasEmailCredential(email.outlook) ? clone(email.outlook) : null
      }
    }
  };
  for (const id of ["cloudflare", "azure", "aws", "googleCloud", "marketData"]) {
    const value = connectors[id];
    if (!value) continue;
    const hasSecret = id === "cloudflare" ? !!(text(value.token) || value.oauth)
      : id === "azure" ? !!text(value.clientSecret)
      : id === "aws" ? !!(text(value.accessKeyId) && text(value.secretAccessKey))
      : id === "googleCloud" ? !!value.serviceAccount
      : !!(text(value.apiKey) || text(value.alpacaKeyId) || text(value.alpacaSecretKey) || text(value.massiveApiKey));
    if (hasSecret) snapshot.connectors[id] = clone(value);
  }
  return snapshot;
}

function mergeObjectMissing(local, remote) {
  const out = local && typeof local === "object" ? local : {};
  for (const [key, value] of Object.entries(remote && typeof remote === "object" ? remote : {})) {
    if (value === undefined || value === null || value === "") continue;
    if (out[key] === undefined || out[key] === null || out[key] === "") out[key] = clone(value);
  }
  return out;
}

function mergeRows(localRows, remoteRows, identityFields) {
  const out = Array.isArray(localRows) ? localRows : [];
  for (const remote of Array.isArray(remoteRows) ? remoteRows : []) {
    const existing = out.find(row => identityFields.some(field => text(row?.[field]) && text(row?.[field]) === text(remote?.[field])));
    if (existing) mergeObjectMissing(existing, remote);
    else out.push(clone(remote));
  }
  return out;
}

export function mergeCloudVault(config = {}, remote = {}) {
  const before = JSON.stringify(cloudVaultSnapshot(config));
  for (const id of [...FIRST_PARTY_CLOUD_PROVIDERS, "customApi"]) {
    const saved = remote?.providers?.[id];
    if (!saved) continue;
    config[id] = mergeObjectMissing(config[id], saved);
  }
  config.connectors ||= {};
  const target = config.connectors;
  const source = remote.connectors || {};
  target.apis = mergeRows(target.apis, source.apis, ["id", "baseUrl"]);
  target.mcp = mergeRows(target.mcp, source.mcp, ["id", "url"]);
  target.agents = mergeRows(target.agents, source.agents, ["id", "url"]);
  target.email ||= {};
  target.email.accounts = mergeRows(target.email.accounts, source.email?.accounts, ["id", "account"]);
  for (const id of ["gmail", "outlook"]) {
    if (source.email?.[id]) target.email[id] = mergeObjectMissing(target.email[id], source.email[id]);
  }
  for (const id of ["cloudflare", "azure", "aws", "googleCloud", "marketData"]) {
    if (source[id]) target[id] = mergeObjectMissing(target[id], source[id]);
  }
  return { config, changed: before !== JSON.stringify(cloudVaultSnapshot(config)) };
}

export function cloudVaultSummary(payload = {}) {
  const providers = Object.keys(payload.providers || {}).length;
  const connectors = payload.connectors || {};
  const email = connectors.email || {};
  const connections = ["cloudflare", "azure", "aws", "googleCloud", "marketData"].filter(id => connectors[id]).length
    + [connectors.apis, connectors.mcp, connectors.agents, email.accounts].reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0)
    + [email.gmail, email.outlook].filter(Boolean).length;
  return { providers, connections };
}
