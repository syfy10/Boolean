import { ADMIN_PAGE_HTML } from "./admin-page.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DAY = 24 * 60 * 60;
const FREE_SIGNUP_TOKENS = 0;
const FREE_SIGNUP_LIMIT = 0;
const FREE_DAILY_LIMIT_TOKENS = 0;
const FREE_SIGNUP_DAYS = 30;
const DEFAULT_FREE_TIER_PROVIDER = "workers-ai";
const DEFAULT_FREE_TIER_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      const status = Number(err?.status || 500);
      return json({ error: status >= 500 ? "server_error" : "request_error", message: err?.message || String(err) }, status, request, env);
    }
  }
};

async function route(request, env) {
  if (request.method === "OPTIONS") return corsPreflight(request, env);

  const url = new URL(request.url);
  const rawPath = url.pathname.replace(/\/+$/, "") || "/";
  const path = rawPath === "/boolean" || rawPath.startsWith("/boolean/")
    ? rawPath.slice("/boolean".length) || "/"
    : rawPath;

  if (path === "/health") {
    return json({ ok: true, app: env.APP_NAME || "Boolean", transactional_email: !!env.EMAIL }, 200, request, env);
  }

  if (path === "/auth/device/start" && request.method === "POST") {
    return startDeviceLogin(request, env);
  }

  if (path === "/auth/device/status" && request.method === "GET") {
    return deviceLoginStatus(request, env);
  }

  if (path === "/auth/google/callback" && request.method === "GET") {
    return googleCallback(request, env);
  }

  if (path === "/me" && request.method === "GET") {
    const session = await requireSession(request, env);
    return json({
      user: publicUser(session.user),
      tokens: session.tokens || defaultTokenStatus()
    }, 200, request, env);
  }

  if (path === "/tokens/debit" && request.method === "POST") {
    const session = await requireSession(request, env);
    const body = await request.json().catch(() => ({}));
    const tokens = Math.max(0, Math.min(200000, Math.ceil(Number(body.tokens || 0))));
    if (!tokens) return json({ error: "missing_tokens" }, 400, request, env);
    const result = await debitTokens(session.user.id, tokens, body.reason || "cloud_usage", env);
    return json(result, 200, request, env);
  }

  if (path === "/chat/completions" && request.method === "POST") {
    return chatCompletions(request, env);
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const token = bearerToken(request);
    if (token) {
      const tokenHash = await sha256Hex(token);
      await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
        .bind(now(), tokenHash)
        .run();
    }
    return json({ ok: true }, 200, request, env);
  }

  if (path === "/admin" && request.method === "GET") {
    return new Response(ADMIN_PAGE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (path === "/admin/api/me" && request.method === "GET") {
    const session = await requireSession(request, env);
    const admin = (session.user.role || "user") === "admin" || isAdminEmail(session.user.email, env);
    return json({ user: { ...publicUser(session.user), is_admin: admin } }, 200, request, env);
  }

  if (path === "/admin/api/stats" && request.method === "GET") {
    await requireAdmin(request, env);
    return adminStats(request, env);
  }

  if (path === "/admin/api/users" && request.method === "GET") {
    await requireAdmin(request, env);
    return adminListUsers(request, env, url);
  }

  if (path === "/admin/api/user/tokens" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    return adminAdjustTokens(request, env, session);
  }

  if (path === "/admin/api/user/unlimited" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    return adminSetUnlimited(request, env, session);
  }

  if (path === "/admin/api/user/ban" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    return adminSetBan(request, env, session);
  }

  if (path === "/admin/api/user/role" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    return adminSetRole(request, env, session);
  }

  if (path === "/admin/api/user/delete" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    return adminDeleteUser(request, env, session);
  }

  if (path === "/admin/api/email/test" && request.method === "POST") {
    const session = await requireAdmin(request, env);
    const body = await request.json().catch(() => ({}));
    const to = String(body.to || session.user.email || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) return json({ error: "invalid_email" }, 400, request, env);
    await sendTransactionalEmail(env, {
      to,
      subject: "Boolean email connection test",
      text: "Boolean's Cloudflare transactional email connection is working.",
      html: "<p>Boolean's Cloudflare transactional email connection is working.</p>"
    });
    return json({ ok: true, to }, 200, request, env);
  }

  return json({ error: "not_found" }, 404, request, env);
}

async function sendTransactionalEmail(env, { to, subject, text, html }) {
  if (!env.EMAIL) throw httpError("email_service_not_configured", 503);
  const fromAddress = String(env.EMAIL_FROM_ADDRESS || "notifications@saz3.com").trim();
  const fromName = String(env.EMAIL_FROM_NAME || env.APP_NAME || "Boolean").trim();
  return env.EMAIL.send({
    to,
    from: { email: fromAddress, name: fromName },
    subject: String(subject || "Boolean notification"),
    text: String(text || ""),
    html: String(html || "")
  });
}

// ── admin console ─────────────────────────────────────────────────

async function adminStats(request, env) {
  const [users, banned, admins, balances, grants, usage7d] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(balance_tokens),0) AS n FROM token_accounts WHERE unlimited_tokens = 0").first(),
    env.DB.prepare("SELECT value FROM app_counters WHERE key = 'free_signup_grants_used'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(-delta_tokens),0) AS n FROM token_ledger WHERE delta_tokens < 0 AND created_at > ?")
      .bind(now() - 7 * 86400).first()
  ]);
  return json({
    users: Number(users?.n || 0),
    banned: Number(banned?.n || 0),
    admins: Number(admins?.n || 0),
    outstanding_tokens: Number(balances?.n || 0),
    free_signup_grants_used: Number(grants?.value || 0),
    tokens_used_7d: Number(usage7d?.n || 0)
  }, 200, request, env);
}

async function adminListUsers(request, env, url) {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const where = q ? "WHERE lower(u.email) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ?" : "";
  const args = q ? [`%${q}%`, `%${q}%`, limit, offset] : [limit, offset];
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.created_at, u.banned_at, u.banned_reason,
            t.balance_tokens, t.plan, t.unlimited_tokens, t.daily_used_tokens, t.daily_reset_at
     FROM users u LEFT JOIN token_accounts t ON t.user_id = u.id
     ${where}
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(...args).all();
  const users = (rows.results || []).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name || "",
    role: r.role || "user",
    created_at: r.created_at,
    banned: !!r.banned_at,
    banned_reason: r.banned_reason || "",
    plan: r.plan || "free",
    balance_tokens: Number(r.balance_tokens || 0),
    unlimited: Number(r.unlimited_tokens || 0) === 1,
    daily_used_tokens: Number(r.daily_reset_at || 0) > now() ? Number(r.daily_used_tokens || 0) : 0
  }));
  return json({ users, limit, offset }, 200, request, env);
}

async function adminTargetUser(body, env) {
  const userId = String(body.user_id || "").trim();
  if (!userId) throw httpError("missing_user_id", 400);
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) throw httpError("user_not_found", 404);
  return user;
}

async function adminAdjustTokens(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const user = await adminTargetUser(body, env);
  const delta = Math.trunc(Number(body.delta || 0));
  if (!delta || Math.abs(delta) > 100000000) throw httpError("bad_delta", 400);
  const ts = now();
  const account = await env.DB.prepare("SELECT * FROM token_accounts WHERE user_id = ?").bind(user.id).first();
  if (!account) throw httpError("token account not found", 404);
  const balance = Math.max(0, Number(account.balance_tokens || 0) + delta);
  await env.DB.prepare("UPDATE token_accounts SET balance_tokens = ?, updated_at = ? WHERE user_id = ?")
    .bind(balance, ts, user.id).run();
  await env.DB.prepare("INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(randomId("led"), user.id, delta, `admin_adjust:${session.user.email}`, ts).run();
  return json({ ok: true, user_id: user.id, balance_tokens: balance }, 200, request, env);
}

async function adminSetUnlimited(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const user = await adminTargetUser(body, env);
  const unlimited = body.unlimited ? 1 : 0;
  await env.DB.prepare("UPDATE token_accounts SET unlimited_tokens = ?, updated_at = ? WHERE user_id = ?")
    .bind(unlimited, now(), user.id).run();
  await env.DB.prepare("INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, 0, ?, ?)")
    .bind(randomId("led"), user.id, `admin_unlimited_${unlimited ? "on" : "off"}:${session.user.email}`, now()).run();
  return json({ ok: true, user_id: user.id, unlimited: !!unlimited }, 200, request, env);
}

async function adminSetBan(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const user = await adminTargetUser(body, env);
  if (user.id === session.user.id) throw httpError("cannot_ban_yourself", 400);
  const ts = now();
  if (body.banned) {
    const reason = String(body.reason || "").slice(0, 300);
    await env.DB.prepare("UPDATE users SET banned_at = ?, banned_reason = ?, updated_at = ? WHERE id = ?")
      .bind(ts, reason, ts, user.id).run();
    // banned users lose all active sessions immediately
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(ts, user.id).run();
  } else {
    await env.DB.prepare("UPDATE users SET banned_at = NULL, banned_reason = NULL, updated_at = ? WHERE id = ?")
      .bind(ts, user.id).run();
  }
  return json({ ok: true, user_id: user.id, banned: !!body.banned }, 200, request, env);
}

async function adminSetRole(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const user = await adminTargetUser(body, env);
  const role = body.role === "admin" ? "admin" : "user";
  if (user.id === session.user.id && role !== "admin") throw httpError("cannot_demote_yourself", 400);
  await env.DB.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
    .bind(role, now(), user.id).run();
  return json({ ok: true, user_id: user.id, role }, 200, request, env);
}

async function adminDeleteUser(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const user = await adminTargetUser(body, env);
  if (user.id === session.user.id) throw httpError("cannot_delete_yourself", 400);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_devices WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM token_ledger WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM token_accounts WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id)
  ]);
  return json({ ok: true, deleted: user.id }, 200, request, env);
}

async function chatCompletions(request, env) {
  if (!bearerToken(request)) return json({ error: "unauthorized", message: "unauthorized" }, 401, request, env);
  const session = await requireSession(request, env);
  if (!env.AI) throw httpError("Workers AI binding is not configured", 500);

  const body = await request.json().catch(() => ({}));
  const model = String(body.model || session.tokens?.default_model || freeTierModel(env)).trim() || freeTierModel(env);
  const messages = normalizeChatMessages(body.messages || []);
  if (!messages.length) return json({ error: "missing_messages" }, 400, request, env);

  const maxTokens = Math.max(64, Math.min(2000, Math.round(Number(body.max_tokens || body.max_completion_tokens || 800))));
  const temperature = Number.isFinite(Number(body.temperature)) ? Math.max(0, Math.min(2, Number(body.temperature))) : 0.7;
  const inputTokens = estimateTokens(messages);
  const reservedTokens = Math.max(1, inputTokens + maxTokens);
  const reserve = await debitTokens(session.user.id, reservedTokens, "cloud_chat_reserved", env);
  if (!reserve.ok) return json({ error: reserve.error || "token_limit", tokens: reserve.tokens }, 402, request, env);

  try {
    const aiInput = {
      messages,
      max_tokens: maxTokens,
      temperature
    };
    if (Array.isArray(body.tools) && body.tools.length) aiInput.tools = body.tools;
    if (body.tool_choice) aiInput.tool_choice = body.tool_choice;

    const result = await env.AI.run(model, aiInput);
    const message = extractAiMessage(result);
    const outputTokens = estimateTokens(message);
    const actualTokens = Math.max(1, inputTokens + outputTokens);
    let tokenState = reserve.tokens;
    if (reservedTokens > actualTokens) {
      const refund = await creditTokens(session.user.id, reservedTokens - actualTokens, "cloud_chat_refund", env);
      tokenState = refund.tokens;
    }
    return json({
      id: randomId("chat"),
      object: "chat.completion",
      created: now(),
      model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: actualTokens },
      tokens: tokenState
    }, 200, request, env);
  } catch (err) {
    await creditTokens(session.user.id, reservedTokens, "cloud_chat_failed_refund", env);
    throw err;
  }
}

async function startDeviceLogin(request, env) {
  requireGoogleConfig(env);

  const createdAt = now();
  const deviceId = randomId("dev");
  const state = randomId("state");
  const expiresAt = createdAt + 10 * 60;
  const redirectUri = callbackUrl(request, env);

  await env.DB.prepare(
    "INSERT INTO login_devices (id, state, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)"
  ).bind(deviceId, state, createdAt, expiresAt).run();

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account");

  return json({
    device_id: deviceId,
    auth_url: authUrl.toString(),
    expires_at: expiresAt
  }, 200, request, env);
}

async function deviceLoginStatus(request, env) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id") || "";
  if (!deviceId) return json({ error: "missing_device_id" }, 400, request, env);

  const row = await env.DB.prepare(
    "SELECT id, status, session_id, session_token, expires_at FROM login_devices WHERE id = ?"
  ).bind(deviceId).first();

  if (!row) return json({ error: "not_found" }, 404, request, env);
  if (row.expires_at < now()) return json({ status: "expired" }, 200, request, env);
  if (row.status !== "complete" || !row.session_id) return json({ status: row.status }, 200, request, env);

  const session = await sessionById(row.session_id, env);
  if (!session) return json({ status: "expired" }, 200, request, env);

  return json({
    status: "complete",
    session_token: row.session_token,
    user: publicUser(session.user),
    tokens: session.tokens || defaultTokenStatus()
  }, 200, request, env);
}

async function googleCallback(request, env) {
  requireGoogleConfig(env);

  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error");

  if (error) return htmlPage("Sign in canceled", "Google sign-in was canceled. You can close this window.");
  if (!state || !code) return htmlPage("Sign in failed", "Missing Google sign-in information. Please try again.");

  const login = await env.DB.prepare(
    "SELECT id, expires_at, status FROM login_devices WHERE state = ?"
  ).bind(state).first();

  if (!login || login.expires_at < now()) {
    return htmlPage("Sign in expired", "This sign-in link expired. Please start sign-in again from Boolean.");
  }
  if (login.status !== "pending") {
    return htmlPage("Already signed in", "This sign-in request was already completed. You can return to Boolean.");
  }

  const tokenSet = await exchangeGoogleCode(code, callbackUrl(request, env), env);
  const profile = await verifyGoogleIdToken(tokenSet.id_token, env);
  const user = await upsertUser(profile, env);
  const session = await createSession(user.id, env);

  await env.DB.prepare(
    "UPDATE login_devices SET status = 'complete', session_id = ?, session_token = ?, completed_at = ? WHERE id = ?"
  ).bind(session.id, session.token, now(), login.id).run();

  return htmlPage(
    "Signed in",
    "You are signed in to Boolean. This window will close automatically.",
    true
  );
}

async function exchangeGoogleCode(code, redirectUri, env) {
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("redirect_uri", redirectUri);
  body.set("grant_type", "authorization_code");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw new Error(data.error_description || data.error || "Google token exchange failed");
  }
  return data;
}

async function verifyGoogleIdToken(idToken, env) {
  const res = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  const profile = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(profile.error_description || "Google token verification failed");
  if (profile.aud !== env.GOOGLE_CLIENT_ID) throw new Error("Google token audience mismatch");
  if (!profile.sub || !profile.email) throw new Error("Google profile missing required fields");
  return profile;
}

async function upsertUser(profile, env) {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?")
    .bind(profile.sub)
    .first();

  const ts = now();
  const admin = isAdminEmail(profile.email, env);
  const role = admin ? "admin" : (existing?.role || "user");
  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET email = ?, name = ?, picture = ?, role = ?, updated_at = ? WHERE id = ?"
    ).bind(profile.email, profile.name || "", profile.picture || "", role, ts, existing.id).run();
    if (admin) {
      await env.DB.prepare(
        "UPDATE token_accounts SET plan = 'admin', unlimited_tokens = 1, free_grant_expires_at = NULL, daily_limit_tokens = 0, updated_at = ? WHERE user_id = ?"
      ).bind(ts, existing.id).run();
    }
    return { ...existing, email: profile.email, name: profile.name || "", picture: profile.picture || "", role };
  }

  const id = randomId("usr");
  const freeGrant = admin ? { tokens: 0, granted: false } : await reserveFreeSignupGrant(env);
  const startingTokens = freeGrant.tokens;
  const expiresAt = startingTokens ? ts + FREE_SIGNUP_DAYS * DAY : null;
  const resetAt = nextDailyReset(ts);
  await env.DB.prepare(
    "INSERT INTO users (id, google_sub, email, name, picture, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, profile.sub, profile.email, profile.name || "", profile.picture || "", role, ts, ts).run();
  await env.DB.prepare(
    `INSERT INTO token_accounts
      (user_id, balance_tokens, plan, default_provider, default_model, free_grant_tokens, free_grant_expires_at, daily_limit_tokens, daily_used_tokens, daily_reset_at, unlimited_tokens, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(
    id,
    startingTokens,
    admin ? "admin" : "free",
    freeTierProvider(env),
    freeTierModel(env),
    startingTokens,
    expiresAt,
    startingTokens ? FREE_DAILY_LIMIT_TOKENS : 0,
    resetAt,
    admin ? 1 : 0,
    ts
  ).run();
  if (startingTokens) {
    await env.DB.prepare(
      "INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(randomId("led"), id, startingTokens, "free_google_signup", ts).run();
  }

  return { id, google_sub: profile.sub, email: profile.email, name: profile.name || "", picture: profile.picture || "", role };
}

async function reserveFreeSignupGrant(env) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO app_counters (key, value, updated_at) VALUES ('free_signup_grants_used', 0, ?)"
  ).bind(now()).run();

  const result = await env.DB.prepare(
    "UPDATE app_counters SET value = value + 1, updated_at = ? WHERE key = 'free_signup_grants_used' AND value < ?"
  ).bind(now(), FREE_SIGNUP_LIMIT).run();
  const changed = Number(result?.meta?.changes || result?.changes || 0);
  if (!changed) return { tokens: 0, granted: false };
  return { tokens: FREE_SIGNUP_TOKENS, granted: true };
}

async function createSession(userId, env) {
  const token = randomId("sess");
  const tokenHash = await sha256Hex(token);
  const id = randomId("sid");
  const createdAt = now();
  const expiresAt = createdAt + 90 * DAY;

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, userId, tokenHash, createdAt, expiresAt).run();

  return { id, token, expires_at: expiresAt };
}

async function debitTokens(userId, tokens, reason, env) {
  const ts = now();
  const row = await env.DB.prepare("SELECT * FROM token_accounts WHERE user_id = ?").bind(userId).first();
  if (!row) throw httpError("token account not found", 404);

  let balance = Number(row.balance_tokens || 0);
  let dailyUsed = Number(row.daily_used_tokens || 0);
  let dailyResetAt = Number(row.daily_reset_at || 0);
  const dailyLimit = Number(row.daily_limit_tokens || 0);
  const expiresAt = Number(row.free_grant_expires_at || 0);
  const unlimited = isUnlimitedAccount(row);

  if (!dailyResetAt || dailyResetAt <= ts) {
    dailyUsed = 0;
    dailyResetAt = nextDailyReset(ts);
  }

  if (unlimited) {
    const newDailyUsed = dailyUsed + tokens;
    await env.DB.prepare(
      "UPDATE token_accounts SET daily_used_tokens = ?, daily_reset_at = ?, updated_at = ? WHERE user_id = ?"
    ).bind(newDailyUsed, dailyResetAt, ts, userId).run();
    await env.DB.prepare(
      "INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(randomId("led"), userId, -tokens, String(reason || "cloud_usage").slice(0, 80), ts).run();
    return { ok: true, tokens: tokenStatus({ ...row, daily_used_tokens: newDailyUsed, daily_reset_at: dailyResetAt }) };
  }

  if ((row.plan || "free") === "free" && expiresAt && expiresAt < ts) {
    balance = 0;
    await env.DB.prepare(
      "UPDATE token_accounts SET balance_tokens = 0, daily_used_tokens = 0, daily_reset_at = ?, updated_at = ? WHERE user_id = ?"
    ).bind(nextDailyReset(ts), ts, userId).run();
    return { ok: false, error: "free_tokens_expired", tokens: tokenStatus({ ...row, balance_tokens: 0, daily_used_tokens: 0, daily_reset_at: nextDailyReset(ts) }) };
  }

  const dailyRemaining = dailyLimit ? Math.max(0, dailyLimit - dailyUsed) : balance;
  if (tokens > balance) return { ok: false, error: "not_enough_tokens", tokens: tokenStatus({ ...row, balance_tokens: balance, daily_used_tokens: dailyUsed, daily_reset_at: dailyResetAt }) };
  if (dailyLimit && tokens > dailyRemaining) return { ok: false, error: "daily_limit_reached", tokens: tokenStatus({ ...row, balance_tokens: balance, daily_used_tokens: dailyUsed, daily_reset_at: dailyResetAt }) };

  const newBalance = balance - tokens;
  const newDailyUsed = dailyUsed + tokens;
  await env.DB.prepare(
    "UPDATE token_accounts SET balance_tokens = ?, daily_used_tokens = ?, daily_reset_at = ?, updated_at = ? WHERE user_id = ?"
  ).bind(newBalance, newDailyUsed, dailyResetAt, ts, userId).run();
  await env.DB.prepare(
    "INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(randomId("led"), userId, -tokens, String(reason || "cloud_usage").slice(0, 80), ts).run();

  return { ok: true, tokens: tokenStatus({ ...row, balance_tokens: newBalance, daily_used_tokens: newDailyUsed, daily_reset_at: dailyResetAt }) };
}

async function creditTokens(userId, tokens, reason, env) {
  const amount = Math.max(0, Math.ceil(Number(tokens || 0)));
  if (!amount) {
    const row = await env.DB.prepare("SELECT * FROM token_accounts WHERE user_id = ?").bind(userId).first();
    return { ok: true, tokens: tokenStatus(row || {}) };
  }

  const ts = now();
  const row = await env.DB.prepare("SELECT * FROM token_accounts WHERE user_id = ?").bind(userId).first();
  if (!row) throw httpError("token account not found", 404);

  const resetAt = Number(row.daily_reset_at || 0);
  const dailyUsed = resetAt && resetAt > ts ? Math.max(0, Number(row.daily_used_tokens || 0) - amount) : 0;
  if (isUnlimitedAccount(row)) {
    await env.DB.prepare(
      "UPDATE token_accounts SET daily_used_tokens = ?, updated_at = ? WHERE user_id = ?"
    ).bind(dailyUsed, ts, userId).run();
    await env.DB.prepare(
      "INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(randomId("led"), userId, amount, String(reason || "cloud_refund").slice(0, 80), ts).run();
    return { ok: true, tokens: tokenStatus({ ...row, daily_used_tokens: dailyUsed }) };
  }
  const balance = Math.max(0, Number(row.balance_tokens || 0)) + amount;
  await env.DB.prepare(
    "UPDATE token_accounts SET balance_tokens = ?, daily_used_tokens = ?, updated_at = ? WHERE user_id = ?"
  ).bind(balance, dailyUsed, ts, userId).run();
  await env.DB.prepare(
    "INSERT INTO token_ledger (id, user_id, delta_tokens, reason, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(randomId("led"), userId, amount, String(reason || "cloud_refund").slice(0, 80), ts).run();

  return { ok: true, tokens: tokenStatus({ ...row, balance_tokens: balance, daily_used_tokens: dailyUsed }) };
}

function normalizeChatMessages(messages) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = ["system", "user", "assistant", "tool"].includes(msg?.role) ? msg.role : "user";
    let content = "";
    if (typeof msg?.content === "string") content = msg.content;
    else if (Array.isArray(msg?.content)) {
      content = msg.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    }
    content = String(content || "").trim();
    if (content) out.push({ role, content: content.slice(0, 120000) });
    if (out.length >= 80) break;
  }
  return out;
}

function extractAiMessage(result) {
  if (result?.choices?.[0]?.message) {
    const msg = result.choices[0].message;
    return {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : "",
      ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length ? { tool_calls: msg.tool_calls } : {})
    };
  }
  if (typeof result === "string") return { role: "assistant", content: result };
  if (typeof result?.response === "string") return { role: "assistant", content: result.response };
  if (typeof result?.result?.response === "string") return { role: "assistant", content: result.result.response };
  if (typeof result?.choices?.[0]?.text === "string") return { role: "assistant", content: result.choices[0].text };
  return { role: "assistant", content: "" };
}

function estimateTokens(value) {
  const text = extractMeteredText(value);
  const words = text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu);
  return Math.max(1, words ? words.length : 1);
}

function extractMeteredText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractMeteredText).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return value.content.map(extractMeteredText).join(" ");
    if (typeof value.text === "string") return value.text;
    return Object.values(value).map(extractMeteredText).filter(Boolean).join(" ");
  }
  return "";
}

async function requireSession(request, env) {
  const token = bearerToken(request);
  if (!token) throw httpError("unauthorized", 401);
  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT
      s.id AS session_id, s.expires_at, s.revoked_at,
      u.id AS user_id, u.email, u.name, u.picture, u.role, u.banned_at,
      t.balance_tokens, t.plan, t.default_provider, t.default_model, t.free_grant_tokens, t.free_grant_expires_at,
      t.daily_limit_tokens, t.daily_used_tokens, t.daily_reset_at, t.unlimited_tokens
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN token_accounts t ON t.user_id = u.id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first();

  if (!row || row.revoked_at || row.expires_at < now()) throw httpError("unauthorized", 401);
  if (row.banned_at) throw httpError("account_banned", 403);
  return {
    id: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture, role: row.role || "user" },
    tokens: tokenStatus(row)
  };
}

// Admin gate: a valid session whose user has the admin role or is on the
// ADMIN_EMAILS allowlist. Everything under /admin/api/* goes through this.
async function requireAdmin(request, env) {
  const session = await requireSession(request, env);
  const admin = (session.user.role || "user") === "admin" || isAdminEmail(session.user.email, env);
  if (!admin) throw httpError("forbidden", 403);
  return session;
}

async function sessionById(sessionId, env) {
  const row = await env.DB.prepare(
    `SELECT
      s.id AS session_id, s.expires_at, s.revoked_at, s.token_hash,
      u.id AS user_id, u.email, u.name, u.picture, u.role,
      t.balance_tokens, t.plan, t.default_provider, t.default_model, t.free_grant_tokens, t.free_grant_expires_at,
      t.daily_limit_tokens, t.daily_used_tokens, t.daily_reset_at, t.unlimited_tokens
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN token_accounts t ON t.user_id = u.id
     WHERE s.id = ?`
  ).bind(sessionId).first();

  if (!row || row.revoked_at || row.expires_at < now()) return null;
  return {
    id: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture, role: row.role || "user" },
    tokens: tokenStatus(row)
  };
}

function defaultTokenStatus() {
  return {
    balance_tokens: 0,
    plan: "free",
    unlimited_tokens: false,
    default_provider: DEFAULT_FREE_TIER_PROVIDER,
    default_model: DEFAULT_FREE_TIER_MODEL,
    free_grant_tokens: 0,
    free_grant_expires_at: null,
    daily_limit_tokens: 0,
    daily_used_tokens: 0,
    daily_remaining_tokens: 0,
    daily_reset_at: nextDailyReset(now())
  };
}

function tokenStatus(row) {
  const ts = now();
  const resetAt = Number(row.daily_reset_at || 0);
  const dailyLimit = Number(row.daily_limit_tokens || 0);
  const dailyUsed = resetAt && resetAt > ts ? Number(row.daily_used_tokens || 0) : 0;
  const balance = Math.max(0, Number(row.balance_tokens || 0));
  const unlimited = isUnlimitedAccount(row);
  return {
    balance_tokens: balance,
    plan: row.plan || "free",
    unlimited_tokens: unlimited,
    default_provider: row.default_provider || DEFAULT_FREE_TIER_PROVIDER,
    default_model: row.default_model || DEFAULT_FREE_TIER_MODEL,
    free_grant_tokens: Number(row.free_grant_tokens || 0),
    free_grant_expires_at: row.free_grant_expires_at || null,
    daily_limit_tokens: dailyLimit,
    daily_used_tokens: dailyUsed,
    daily_remaining_tokens: unlimited ? null : (dailyLimit ? Math.max(0, Math.min(balance, dailyLimit - dailyUsed)) : balance),
    daily_reset_at: resetAt && resetAt > ts ? resetAt : nextDailyReset(ts)
  };
}

function freeTierProvider(env) {
  return String(env.FREE_TIER_PROVIDER || DEFAULT_FREE_TIER_PROVIDER).trim() || DEFAULT_FREE_TIER_PROVIDER;
}

function freeTierModel(env) {
  return String(env.FREE_TIER_MODEL || DEFAULT_FREE_TIER_MODEL).trim() || DEFAULT_FREE_TIER_MODEL;
}

function isAdminEmail(email, env) {
  const wanted = String(env.ADMIN_EMAILS || "")
    .split(/[\s,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return wanted.includes(String(email || "").trim().toLowerCase());
}

function isUnlimitedAccount(row) {
  return Number(row?.unlimited_tokens || 0) === 1;
}

function nextDailyReset(ts) {
  const d = new Date(ts * 1000);
  d.setUTCHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function callbackUrl(request, env) {
  const configuredBase = String(env.PUBLIC_AUTH_BASE_URL || "").trim();
  const url = new URL(configuredBase || request.url);
  const basePath = configuredBase ? url.pathname.replace(/\/+$/, "") : "";
  url.pathname = `${basePath}/auth/google/callback`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    picture: user.picture || "",
    role: user.role || "user",
    is_admin: (user.role || "user") === "admin"
  };
}

function requireGoogleConfig(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
}

function bearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function randomId(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${prefix}_${value}`;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!origin) return "";
  if (allowed.includes(origin)) return origin;
  return "";
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  return origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "origin"
  } : {};
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) }
  });
}

function htmlPage(title, message, autoClose = false) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const closeScript = autoClose ? `
  <script>
    setTimeout(() => {
      window.open("", "_self");
      window.close();
      document.body.classList.add("done");
    }, 900);
  </script>` : "";
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    body{font-family:Inter,Segoe UI,Arial,sans-serif;background:#f8faf9;color:#111;margin:0;min-height:100vh;display:grid;place-items:center}
    main{width:min(300px,calc(100vw - 32px));background:#fff;border:1px solid #e8ece9;border-radius:14px;padding:20px 22px;box-shadow:0 14px 38px rgba(0,0,0,.08)}
    .mark{color:#20b764;font-weight:650;margin-bottom:12px;font-size:13px}
    h1{font-size:20px;margin:0 0 8px}
    p{font-size:13px;line-height:1.45;color:#49524c;margin:0}
    body.done p:after{content:" If this window did not close, you can close it now."}
  </style>
</head>
<body><main><div class="mark">Boolean</div><h1>${safeTitle}</h1><p>${safeMessage}</p></main>${closeScript}</body>
</html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}
