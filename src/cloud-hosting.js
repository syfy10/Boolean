import crypto from "node:crypto";

function message(payload, fallback) {
  return payload?.error?.message || payload?.error_description || payload?.message || fallback;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(message(payload, `Cloud request failed (HTTP ${response.status}).`));
  return payload;
}

export async function verifyAzureConnection({ tenantId, clientId, clientSecret, subscriptionId = "" }) {
  if (!tenantId || !clientId || !clientSecret) throw new Error("Enter the Azure tenant ID, client ID, and client secret.");
  const token = await jsonRequest(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://management.azure.com/.default",
      grant_type: "client_credentials"
    })
  });
  const subscriptions = await jsonRequest("https://management.azure.com/subscriptions?api-version=2022-12-01", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  const accounts = (subscriptions.value || []).map((item) => ({
    id: item.subscriptionId,
    name: item.displayName || item.subscriptionId,
    state: item.state || ""
  }));
  const selected = accounts.find((item) => item.id === subscriptionId) || (accounts.length === 1 ? accounts[0] : null);
  return { accounts, selected, accessToken: token.access_token, expiresIn: Number(token.expires_in || 3600) };
}

export async function azureResourceList(connection, kind = "resources") {
  const verified = await verifyAzureConnection(connection);
  const subscriptionId = connection.subscriptionId || verified.selected?.id;
  if (!subscriptionId) throw new Error("Choose an Azure subscription first.");
  const types = {
    resources: "",
    webapps: "Microsoft.Web/sites",
    storage: "Microsoft.Storage/storageAccounts",
    functions: "Microsoft.Web/sites"
  };
  if (!(kind in types)) throw new Error("Unsupported Azure resource.");
  const filter = types[kind] ? `&$filter=${encodeURIComponent(`resourceType eq '${types[kind]}'`)}` : "";
  const payload = await jsonRequest(`https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resources?api-version=2021-04-01${filter}`, {
    headers: { authorization: `Bearer ${verified.accessToken}` }
  });
  let items = payload.value || [];
  if (kind === "functions") items = items.filter((item) => String(item.kind || "").toLowerCase().includes("functionapp"));
  return items;
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function awsRequest(connection, { service, region, method = "GET", hostname, path = "/", query = "", body = "" }) {
  const accessKeyId = String(connection.accessKeyId || "").trim();
  const secretAccessKey = String(connection.secretAccessKey || "").trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("Enter the AWS access key ID and secret access key.");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalQuery = query;
  const payloadHash = sha256(body);
  const headers = {
    host: hostname,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (connection.sessionToken) headers["x-amz-security-token"] = connection.sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const signingKey = hmac(kService, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${hostname}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const response = await fetch(url, { method, headers, body: body || undefined });
  const text = await response.text();
  if (!response.ok) throw new Error((text.match(/<Message>([^<]+)/)?.[1]) || `AWS request failed (HTTP ${response.status}).`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function verifyAwsConnection(connection) {
  const result = await awsRequest(connection, {
    service: "sts", region: "us-east-1", hostname: "sts.amazonaws.com",
    query: "Action=GetCallerIdentity&Version=2011-06-15"
  });
  const raw = result.raw || "";
  return {
    accountId: raw.match(/<Account>([^<]+)/)?.[1] || "",
    arn: raw.match(/<Arn>([^<]+)/)?.[1] || "",
    userId: raw.match(/<UserId>([^<]+)/)?.[1] || ""
  };
}

export async function awsResourceList(connection, kind = "amplify") {
  const region = connection.region || "us-east-1";
  if (kind === "identity") return [await verifyAwsConnection(connection)];
  if (kind === "buckets") {
    const result = await awsRequest(connection, { service: "s3", region: "us-east-1", hostname: "s3.amazonaws.com" });
    return [...String(result.raw || "").matchAll(/<Bucket><Name>([^<]+)<\/Name><CreationDate>([^<]+)<\/CreationDate><\/Bucket>/g)]
      .map((match) => ({ name: match[1], createdAt: match[2] }));
  }
  const targets = {
    amplify: { service: "amplify", hostname: `amplify.${region}.amazonaws.com`, path: "/apps" },
    lambda: { service: "lambda", hostname: `lambda.${region}.amazonaws.com`, path: "/2015-03-31/functions/" }
  };
  const target = targets[kind];
  if (!target) throw new Error("Unsupported AWS resource.");
  const payload = await awsRequest(connection, { ...target, region });
  return payload.apps || payload.Functions || [];
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export async function googleAccessToken(serviceAccount) {
  const account = typeof serviceAccount === "string" ? JSON.parse(serviceAccount) : serviceAccount;
  if (!account?.client_email || !account?.private_key) throw new Error("Paste a valid Google Cloud service-account JSON key.");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url");
  const token = await jsonRequest(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` })
  });
  return { accessToken: token.access_token, account };
}

export async function verifyGoogleCloudConnection({ serviceAccount, projectId = "" }) {
  const auth = await googleAccessToken(serviceAccount);
  const payload = await jsonRequest("https://cloudresourcemanager.googleapis.com/v1/projects", {
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });
  const accounts = (payload.projects || []).filter((item) => item.lifecycleState !== "DELETE_REQUESTED").map((item) => ({
    id: item.projectId,
    name: item.name || item.projectId,
    number: item.projectNumber || ""
  }));
  const selected = accounts.find((item) => item.id === projectId)
    || accounts.find((item) => item.id === auth.account.project_id)
    || (accounts.length === 1 ? accounts[0] : null);
  return { accounts, selected, clientEmail: auth.account.client_email, accessToken: auth.accessToken };
}

export async function googleCloudResourceList(connection, kind = "projects") {
  const verified = await verifyGoogleCloudConnection(connection);
  if (kind === "projects") return verified.accounts;
  const projectId = connection.projectId || verified.selected?.id;
  if (!projectId) throw new Error("Choose a Google Cloud project first.");
  const urls = {
    run: `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/-/services`,
    storage: `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(projectId)}`,
    appengine: `https://appengine.googleapis.com/v1/apps/${encodeURIComponent(projectId)}`
  };
  if (!urls[kind]) throw new Error("Unsupported Google Cloud resource.");
  const payload = await jsonRequest(urls[kind], { headers: { authorization: `Bearer ${verified.accessToken}` } });
  return payload.services || payload.items || (payload.name ? [payload] : []);
}
