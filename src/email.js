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
const clamp = (value, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : min;
};
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
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("prompt", "select_account");
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

async function mapLimit(items, concurrency, worker) {
  const rows = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      rows[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return rows;
}

function headerMap(row) {
  return Object.fromEntries((row?.payload?.headers || []).map((header) => [String(header.name || "").toLowerCase(), header.value]));
}

function partHasAttachment(part) {
  if (!part) return false;
  if (String(part.filename || "").trim()) return true;
  return (part.parts || []).some(partHasAttachment);
}

function gmailMetadataUrl(id) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "metadata");
  for (const name of ["From", "To", "Subject", "Date", "List-Unsubscribe"]) url.searchParams.append("metadataHeaders", name);
  return url.toString();
}

function normalizeGmailMetadata(row) {
  const headers = headerMap(row);
  return {
    id: row.id,
    threadId: row.threadId,
    from: headers.from || "",
    to: headers.to || "",
    subject: headers.subject || "(no subject)",
    date: headers.date || "",
    preview: row.snippet || "",
    labelIds: Array.isArray(row.labelIds) ? row.labelIds : [],
    internalDate: Number(row.internalDate || 0),
    sizeEstimate: Number(row.sizeEstimate || 0),
    hasAttachment: partHasAttachment(row.payload),
    listUnsubscribe: headers["list-unsubscribe"] || ""
  };
}

function normalizeOutlookMetadata(row) {
  return {
    id: row.id,
    threadId: row.conversationId,
    from: row.from?.emailAddress?.address || "",
    to: (row.toRecipients || []).map((item) => item.emailAddress?.address).filter(Boolean).join(", "),
    subject: row.subject || "(no subject)",
    date: row.receivedDateTime || "",
    preview: row.bodyPreview || "",
    labelIds: Array.isArray(row.categories) ? row.categories : [],
    importance: row.importance || "normal",
    hasAttachment: !!row.hasAttachments,
    isDraft: !!row.isDraft,
    parentFolderId: row.parentFolderId || "",
    flagStatus: row.flag?.flagStatus || "notFlagged"
  };
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

export async function scanEmailMetadata(providerName, connection, save, query = "", options = {}) {
  const limit = clamp(options.limit || 250, 1, 5000);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  if (providerName === "gmail") {
    const ids = [];
    let pageToken = "";
    do {
      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("maxResults", String(Math.min(500, limit - ids.length)));
      if (query) listUrl.searchParams.set("q", query);
      if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
      const page = await api(providerName, connection, save, listUrl.toString());
      ids.push(...(page.messages || []).map((item) => item.id).filter(Boolean));
      pageToken = page.nextPageToken || "";
      onProgress({ phase: "listing", found: ids.length, limit });
    } while (pageToken && ids.length < limit);
    const selected = ids.slice(0, limit);
    let read = 0;
    const rows = await mapLimit(selected, clamp(options.concurrency || 8, 1, 16), async (id) => {
      const row = await api(providerName, connection, save, gmailMetadataUrl(id));
      read += 1;
      if (read === selected.length || read % 25 === 0) onProgress({ phase: "metadata", found: selected.length, read, limit });
      return normalizeGmailMetadata(row);
    });
    return rows;
  }

  const rows = [];
  let nextUrl = new URL("https://graph.microsoft.com/v1.0/me/messages");
  nextUrl.searchParams.set("$top", String(Math.min(250, limit)));
  nextUrl.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,conversationId,internetMessageId,importance,hasAttachments,categories,parentFolderId,isDraft,flag");
  nextUrl.searchParams.set("$orderby", "receivedDateTime desc");
  if (!query && options.receivedBefore) nextUrl.searchParams.set("$filter", `receivedDateTime lt ${new Date(options.receivedBefore).toISOString()}`);
  if (query) nextUrl.searchParams.set("$search", `\"${query.replace(/\"/g, "")}\"`);
  while (nextUrl && rows.length < limit) {
    const page = await api(providerName, connection, save, nextUrl.toString(), query ? { headers: { ConsistencyLevel: "eventual" } } : {});
    rows.push(...(page.value || []).map(normalizeOutlookMetadata));
    onProgress({ phase: "metadata", found: rows.length, read: rows.length, limit });
    nextUrl = page["@odata.nextLink"] ? new URL(page["@odata.nextLink"]) : null;
  }
  return rows.slice(0, limit);
}

export async function getEmailMetadata(providerName, connection, save, id) {
  if (providerName === "gmail") {
    return normalizeGmailMetadata(await api(providerName, connection, save, gmailMetadataUrl(id)));
  }
  const row = await api(providerName, connection, save,
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId,importance,hasAttachments,categories,parentFolderId,isDraft,flag`);
  return normalizeOutlookMetadata(row);
}

export async function listEmailLabels(providerName, connection, save) {
  if (providerName !== "gmail") return [];
  const data = await api(providerName, connection, save, "https://gmail.googleapis.com/gmail/v1/users/me/labels");
  return (data.labels || []).map((label) => ({ id: label.id, name: label.name, type: label.type || "user" }));
}

export async function getEmailThreadSafety(providerName, connection, save, threadId, userLabelIds = []) {
  if (providerName !== "gmail" || !threadId) return { protected: false, reasons: [] };
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  const thread = await api(providerName, connection, save, url.toString());
  const labels = new Set((thread.messages || []).flatMap((message) => message.labelIds || []));
  const userLabels = new Set(userLabelIds.map(String));
  const reasons = [];
  if (labels.has("SENT")) reasons.push("you replied in this conversation");
  if (labels.has("STARRED")) reasons.push("this conversation contains a starred message");
  if (labels.has("IMPORTANT")) reasons.push("this conversation contains an important message");
  if ([...labels].some((label) => userLabels.has(String(label)))) reasons.push("this conversation uses a personal label");
  return { protected: reasons.length > 0, reasons };
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

export async function trashEmail(providerName, connection, save, id) {
  if (providerName === "gmail") {
    const row = await api(providerName, connection, save, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
    return { id: row?.id || id, originalId: id, provider: providerName };
  }
  const original = await getEmailMetadata(providerName, connection, save, id);
  const row = await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationId: "deleteditems" })
  });
  return { id: row?.id || id, originalId: id, originalFolderId: original.parentFolderId || "inbox", provider: providerName };
}

export async function untrashEmail(providerName, connection, save, operation) {
  const id = typeof operation === "string" ? operation : operation?.id;
  if (!id) throw new Error("missing trashed message id");
  if (providerName === "gmail") {
    const row = await api(providerName, connection, save, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/untrash`, { method: "POST" });
    return { id: row?.id || id, provider: providerName };
  }
  const destinationId = operation?.originalFolderId || "inbox";
  const row = await api(providerName, connection, save, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationId })
  });
  return { id: row?.id || id, provider: providerName };
}

export function publicEmailConnections(config, managedClients = {}) {
  const email = config.connectors?.email || {};
  const one = (name) => {
    const connection = email[name] || {};
    const oauth = connection.oauth || {};
    const accessReady = !!oauth.accessToken && (!oauth.expiresAt || Number(oauth.expiresAt) > Date.now());
    const credentialReady = !!oauth.refreshToken || accessReady;
    const savedManagedId = connection.clientSource === "managed" ? connection.clientId : "";
    const managedAvailable = !!String(managedClients[name] || savedManagedId || "").trim();
    const legacyManualId = connection.clientSource === "managed" ? "" : connection.clientId;
    const manualAvailable = !!String(connection.manualClientId || legacyManualId || "").trim();
    const connectionMode = connection.clientSource === "managed"
      ? "managed"
      : (connection.clientSource === "manual" || legacyManualId ? "manual" : (managedAvailable ? "managed" : "none"));
    const ready = !!connection.connected && credentialReady && !connection.needsReconnect;
    return {
      provider: name,
      connected: !!connection.connected,
      ready,
      account: connection.account || "",
      hasClientId: managedAvailable || manualAvailable || !!connection.clientId,
      managedAvailable,
      manualAvailable,
      connectionMode,
      health: ready ? "ready" : (connection.connected ? "attention" : "disconnected"),
      lastCheck: connection.lastCheckStatus || "",
      lastCheckedAt: Number(connection.lastCheckedAt || 0),
      supportsCleanup: name === "gmail" || name === "outlook"
    };
  };
  return { draftOnly: email.draftOnly !== false, confirmBeforeSend: true, gmail: one("gmail"), outlook: one("outlook") };
}
