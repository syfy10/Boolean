# Boolean Account Backend

Cloudflare Worker backend for Boolean account sign-in and administration. The
desktop app connects to AI providers directly with user-supplied API keys.

This backend owns secrets. The Windows app should never contain Google client
secrets, Stripe secrets, or paid LLM provider keys.

## Current scope

Implemented:

- Google Sign-In device flow for the desktop app
- D1 tables for users, sessions, and login devices
- legacy token and billing tables retained for migration compatibility
- 30-day expiration for signup tokens
- word-based cloud metering for now: one word counts as one token
- free-tier default model metadata set to Qwen3-30B-A3B on Workers AI
- `/me` endpoint for the signed-in user
- server-side admin roles and explicit unlimited-token accounts
- OpenAI-compatible `/chat/completions` cloud proxy with session, balance,
  expiration, daily-limit, and ban enforcement
- web admin console for account search, token adjustments, unlimited access,
  bans, roles, usage statistics, and account deletion

Coming next:

- Stripe Checkout
- Stripe webhook to add tokens or activate subscriptions

## Setup

Install backend dependencies:

```powershell
cd backend
npm install
```

Create a D1 database:

```powershell
npx wrangler d1 create boolean-cloud
```

Copy the returned `database_id` into `wrangler.jsonc`.

Initialize the database:

```powershell
npm run db:init
npm run db:init:remote
```

If you already created the database before the free-token fields were added,
apply the migration instead:

```powershell
npm run db:migrate
npm run db:migrate:remote
```

Create a Google OAuth Web application client in Google Cloud Console.

Authorized redirect URI for deployed backend:

```text
https://saz3.com/boolean/auth/google/callback
```

Authorized redirect URI for local Wrangler dev:

```text
http://localhost:8787/auth/google/callback
```

The production Worker route is `saz3.com/boolean/auth/*`. Keep
`PUBLIC_AUTH_BASE_URL` set to `https://saz3.com/boolean` so Google displays the
public saz3.com domain during sign-in instead of the workers.dev hostname.

Set Cloudflare secrets:

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Run locally:

```powershell
npm run dev
```

Deploy:

```powershell
npm run deploy
```

## Desktop login flow

1. Boolean calls `POST /auth/device/start`.
2. Backend returns `device_id` and `auth_url`.
3. Boolean opens `auth_url` in the browser.
4. User signs in with Google.
5. Backend completes `/auth/google/callback`.
6. Boolean polls `GET /auth/device/status?device_id=...`.
7. When status is `complete`, Boolean stores `session_token`.
8. Boolean calls cloud endpoints with:

```text
Authorization: Bearer SESSION_TOKEN
```

## Environment variables

| name | where | purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | secret | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret |
| `ALLOWED_ORIGINS` | var | comma-separated app origins allowed by CORS |
| `ADMIN_EMAILS` | var | comma-separated Google account emails promoted to admin with unlimited tokens |
| `PUBLIC_APP_URL` | var | public Boolean/app URL for future billing redirects |
| `FREE_TIER_PROVIDER` | var | legacy compatibility setting; desktop managed AI is disabled |
| `FREE_TIER_MODEL` | var | legacy compatibility setting; desktop managed AI is disabled |

## Routes

| route | method | purpose |
|---|---|---|
| `/health` | GET | backend health check |
| `/auth/device/start` | POST | create Google sign-in attempt |
| `/auth/google/callback` | GET | Google OAuth redirect |
| `/auth/device/status?device_id=...` | GET | poll login status |
| `/me` | GET | current user and token balance |
| `/tokens/debit` | POST | authenticated token debit with balance, expiry, and daily-cap enforcement |
| `/chat/completions` | POST | authenticated OpenAI-compatible cloud chat stream |
| `/auth/logout` | POST | revoke current session |
| `/admin` | GET | Boolean account admin console |
| `/admin/api/*` | GET/POST | admin-only stats and account controls |

## Free signup token rules

New accounts receive no managed AI token grant. Legacy token fields and routes
remain in the Worker for database and admin compatibility, but the desktop app
does not expose Boolean-managed AI access or token purchases.
- usage debits are written to `token_ledger`

These limits are enforced by `/tokens/debit` and `/chat/completions` before
cloud usage is accepted.

Admin accounts are identified only by the server-side `ADMIN_EMAILS` allowlist.
`/me` reports `user.role`, `user.is_admin`, and `tokens.unlimited_tokens`. Their
usage is still written to `token_ledger`, but it is not blocked by balance,
expiration, or the free-tier daily cap.
