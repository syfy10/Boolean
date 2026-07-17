import crypto from "node:crypto";

const PROVIDERS = {
  gmail: {
    label: "Gmail",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid", "email", "profile",
      "https://www.googleapis.com/auth/gmail.modify"
    ]
  },
  outlook: {
    label: "Outlook",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["openid", "profile", "email", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"]
  }
};

const b64url = (value) => Buffer.from(value).toString("base64url");
const cleanHeader = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();
const requireProvider = (name) => {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error("unsupported email provider");
  return provider;
};

export function createEmailOAuth(providerName, clientId, redirectUri) {
  const provider = requireProvider(providerName);
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const url = new URL(provider.authorize);
  url.searchParams.set("client_id", String(clientId || "").trim());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (providerName === "gmail") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return { state, verifier, authorizationUrl: url.toString(), provider: providerName, redirectUri, createdAt: Date.now() };
}

export async function exchangeEmailCode(transaction, code, clientId) {
  const provider = requireProvider(transaction.provider);
  const form = new URLSearchParams({
    client_id: String(clientId || "").trim(),
    code,
    code_verifier: transaction.verifier,
    grant_type: "authorization_code",
    redirect_uri: transaction.redirectUri
  });
  const response = await fetch(provider.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `authorization failed (HTTP ${response.status})`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000,
    scope: data.scope || provider.scopes.join(" "),
    tokenType: data.token_type || "Bearer"
  };
}

async function refreshOAuth(providerName, connection) {
  const provider = requireProvider(providerName);
  const oauth = connection.oauth || {};
  if (!oauth.refreshToken) throw new Error(`${provider.label} needs to be reconnected`);
  const form = new URLSearchParams({
    client_id: connection.clientId,
    refresh_token: oauth.refreshToken,
    grant_type: "refresh_token"
  });
  if (providerName === "outlook") form.set("scope", provider.scopes.join(" "));
  const response = await fetch(provider.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `${provider.label} reconnect required`);
  connection.oauth = {
    ...oauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000,
    scope: data.scope || oauth.scope || ""
  };
  return connection.oauth.accessToken;
}

async function accessToken(providerName, connection, save) {
  if (!connection?.connected || !connection?.oauth) throw new Error(`${requireProvider(providerName).label} is not connected`);
  if (connection.oauth.accessToken && Number(connection.oauth.expiresAt || 0) > Date.now() + 60000) return connection.oauth.accessToken;
  const token = await refreshOAuth(providerName, connection);
  save?.();
  return token;
}

async function api(providerName, connection, save, url, options = {}) {
  let token = await accessToken(providerName, connection, save);
  const request = async () => fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  let response = await request();
  if (response.status === 401 && connection.oauth?.refreshToken) {
    connection.oauth.expiresAt = 0;
    token = await accessToken(providerName, connection, save);
    response = await request();
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error_description || data.error || `email request failed (HTTP ${response.status})`);
  return data;
}

export async function getEmailAccount(providerName, connection, save) {
  if (providerName === "gmail") {
    const data = await api(providerName, connection, save, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
    return data.emailAddress || "Gmail account";
  }
  const data = await api(providerName, connection, save, "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName");
  return data.mail || data.userPrincipalName || data.displayName || "Microsoft account";
}

export async function listEmail(providerName, connection, save, query = "", limit = 10) {
  limit = Math.max(1, Math.min(25, Number(limit || 10)));
  if (providerName === "gmail") {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(limit));
    if (query) listUrl.searchParams.set("q", query);
    const list = await api(providerName, connection, save, listUrl.toString());
    const rows = await Promise.all((list.messages || []).map((item) => api(providerName, connection, save,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    return rows.map((row) => {
      const headers = Object.fromEntries((row.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
      return { id: row.id, threadId: row.threadId, from: headers.from || "", subject: headers.subject || "(no subject)", date: headers.date || "", preview: row.snippet || "" };
    });
  }
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", String(limit));
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview,isRead,conversationId,internetMessageId");
  url.searchParams.set("$orderby", "receivedDateTime desc");
  if (query) url.searchParams.set("$search", `\"${query.replace(/\"/g, "")}\"`);
  const data = await api(providerName, connection, save, url.toString(), query ? { headers: { ConsistencyLevel: "eventual" } } : {});
  return (data.value || []).map((row) => ({ id: row.id, threadId: row.conversationId, from: row.from?.emailAddress?.address || "", subject: row.subject || "(no subject)", date: row.receivedDateTime || "", preview: row.bodyPreview || "" }));
}

export async function readEmail(providerName, connection, save, id) {
  if (providerName === "gmail") {
    const row = await api(providerName, connection, save, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    const headers = Object.fromEntries((row.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    const findText = (part) => {
      if (part?.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
      for (const child of part?.parts || []) { const text = findText(child); if (text) return text; }
      return "";
    };
    return { id: row.id, threadId: row.threadId, from: headers.from || "", to: headers.to || "", subject: headers.subject || "", messageId: headers["message-id"] || "", references: headers.references || "", body: findText(row.payload) || row.snippet || "" };
  }
  const row = await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,body,conversationId,internetMessageId`, {
    headers: { Prefer: 'outlook.body-content-type="text"' }
  });
  return { id: row.id, threadId: row.conversationId, from: row.from?.emailAddress?.address || "", to: (row.toRecipients || []).map((x) => x.emailAddress?.address).filter(Boolean).join(", "), subject: row.subject || "", messageId: row.internetMessageId || "", body: row.body?.content || "" };
}

function gmailMime({ to, subject, text, inReplyTo = "", references = "" }) {
  const headers = [
    `To: ${cleanHeader(to)}`,
    `Subject: ${cleanHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${cleanHeader(inReplyTo)}`);
  if (references) headers.push(`References: ${cleanHeader(references)}`);
  return b64url(`${headers.join("\r\n")}\r\n\r\n${String(text || "")}`);
}

export async function createEmailDraft(providerName, connection, save, draft) {
  if (providerName === "gmail") {
    const data = await api(providerName, connection, save, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { raw: gmailMime(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) } })
    });
    return { id: data.id, messageId: data.message?.id || "", provider: providerName };
  }
  const data = await api(providerName, connection, save, "https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: cleanHeader(draft.subject), body: { contentType: "Text", content: String(draft.text || "") }, toRecipients: String(draft.to || "").split(/[;,]/).map((address) => address.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } })) })
  });
  return { id: data.id, provider: providerName };
}

export async function createReplyDraft(providerName, connection, save, messageId, text) {
  const original = await readEmail(providerName, connection, save, messageId);
  if (providerName === "gmail") return createEmailDraft(providerName, connection, save, {
    to: original.from,
    subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
    text,
    threadId: original.threadId,
    inReplyTo: original.messageId,
    references: [original.references, original.messageId].filter(Boolean).join(" ")
  });
  const draft = await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/createReply`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: { contentType: "Text", content: String(text || "") } }) });
  return { id: draft.id, provider: providerName };
}

export async function sendEmailDraft(providerName, connection, save, draftId) {
  if (providerName === "gmail") {
    await api(providerName, connection, save, "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: draftId }) });
  } else {
    await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  }
  return { sent: true, id: draftId, provider: providerName };
}

export function publicEmailConnections(config) {
  const email = config.connectors?.email || {};
  const one = (name) => ({
    provider: name,
    connected: !!email[name]?.connected,
    account: email[name]?.account || "",
    hasClientId: !!email[name]?.clientId
  });
  return { draftOnly: email.draftOnly !== false, confirmBeforeSend: true, gmail: one("gmail"), outlook: one("outlook") };
}
