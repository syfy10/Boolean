# Boolean Cloud Backend

Cloudflare Worker backend for Boolean accounts, cloud tokens, and billing.

This backend owns secrets. The Windows app should never contain Google client
secrets, Stripe secrets, or paid LLM provider keys.

## Current scope

Implemented:

- Google Sign-In device flow for the desktop app
- D1 tables for users, sessions, login devices, token balance, and ledger
- 100k free cloud tokens for new Google sign-ins
- 10k/day free-tier daily usage cap
- 30-day expiration for signup tokens
- free-tier default model metadata set to GLM-4.7-Flash on Workers AI
- `/me` endpoint for the signed-in user
- server-side admin roles and explicit unlimited-token accounts

Coming next:

- Stripe Checkout
- Stripe webhook to add tokens or activate subscriptions
- `/ai/chat` proxy that checks token balance before calling cloud models

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
https://YOUR_WORKER_DOMAIN/auth/google/callback
```

Authorized redirect URI for local Wrangler dev:

```text
http://localhost:8787/auth/google/callback
```

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
| `FREE_TIER_PROVIDER` | var | default provider for free cloud token usage, currently `workers-ai` |
| `FREE_TIER_MODEL` | var | default free cloud model, currently `@cf/zai-org/glm-4.7-flash` |

## Routes

| route | method | purpose |
|---|---|---|
| `/health` | GET | backend health check |
| `/auth/device/start` | POST | create Google sign-in attempt |
| `/auth/google/callback` | GET | Google OAuth redirect |
| `/auth/device/status?device_id=...` | GET | poll login status |
| `/me` | GET | current user and token balance |
| `/tokens/debit` | POST | authenticated token debit with balance, expiry, and daily-cap enforcement |
| `/auth/logout` | POST | revoke current session |

## Free signup token rules

When a new user completes Google Sign-In for the first time:

- `100,000` cloud tokens are added to their account
- free tokens expire after `30` days
- free-tier usage is capped at `10,000` tokens per UTC day
- the free tier currently points to GLM-4.7-Flash through Cloudflare Workers AI
- usage debits are written to `token_ledger`

These limits are enforced by `/tokens/debit` now and should also be used by the
future `/ai/chat` cloud proxy before calling any paid model provider.

Admin accounts are identified only by the server-side `ADMIN_EMAILS` allowlist.
`/me` reports `user.role`, `user.is_admin`, and `tokens.unlimited_tokens`. Their
usage is still written to `token_ledger`, but it is not blocked by balance,
expiration, or the free-tier daily cap.
