import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyAzureConnection,
  azureResourceList,
  verifyAwsConnection,
  verifyGoogleCloudConnection
} from "../src/cloud-hosting.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("Azure verifies a service principal and scopes resources to its subscription", async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/oauth2/v2.0/token")) return jsonResponse({ access_token: "azure-token", expires_in: 3600 });
    if (String(url).includes("/subscriptions?")) return jsonResponse({ value: [{ subscriptionId: "sub-1", displayName: "Production", state: "Enabled" }] });
    return jsonResponse({ value: [{ id: "/subscriptions/sub-1/resourceGroups/site", name: "site", type: "Microsoft.Web/sites", location: "eastus" }] });
  };
  try {
    const verified = await verifyAzureConnection({ tenantId: "tenant", clientId: "client", clientSecret: "secret" });
    assert.equal(verified.selected.id, "sub-1");
    const resources = await azureResourceList({ tenantId: "tenant", clientId: "client", clientSecret: "secret", subscriptionId: "sub-1" }, "webapps");
    assert.equal(resources[0].name, "site");
    assert.match(calls.at(-1).url, /subscriptions\/sub-1\/resources/);
    assert.equal(calls.at(-1).options.headers.authorization, "Bearer azure-token");
  } finally {
    global.fetch = original;
  }
});

test("AWS signs STS GetCallerIdentity and returns the verified account", async () => {
  const original = global.fetch;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: String(url), options };
    return new Response("<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/boollm</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>");
  };
  try {
    const identity = await verifyAwsConnection({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" });
    assert.equal(identity.accountId, "123456789012");
    assert.match(request.url, /Action=GetCallerIdentity/);
    assert.match(request.options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  } finally {
    global.fetch = original;
  }
});

test("Google Cloud exchanges a service-account JWT and selects its project", async () => {
  const original = global.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = {
    client_email: "boollm@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    project_id: "project-1",
    token_uri: "https://oauth2.googleapis.com/token"
  };
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "google-token" });
    return jsonResponse({ projects: [{ projectId: "project-1", name: "Boollm Hosting", lifecycleState: "ACTIVE" }] });
  };
  try {
    const verified = await verifyGoogleCloudConnection({ serviceAccount });
    assert.equal(verified.selected.id, "project-1");
    assert.equal(verified.clientEmail, serviceAccount.client_email);
    assert.equal(calls[1].options.headers.authorization, "Bearer google-token");
  } finally {
    global.fetch = original;
  }
});
