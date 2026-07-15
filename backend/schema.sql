CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_devices (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT,
  session_token TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_login_devices_state ON login_devices(state);

CREATE TABLE IF NOT EXISTS token_accounts (
  user_id TEXT PRIMARY KEY,
  balance_tokens INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  default_provider TEXT NOT NULL DEFAULT 'workers-ai',
  default_model TEXT NOT NULL DEFAULT '@cf/zai-org/glm-4.7-flash',
  free_grant_tokens INTEGER NOT NULL DEFAULT 0,
  free_grant_expires_at INTEGER,
  daily_limit_tokens INTEGER NOT NULL DEFAULT 0,
  daily_used_tokens INTEGER NOT NULL DEFAULT 0,
  daily_reset_at INTEGER NOT NULL DEFAULT 0,
  unlimited_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta_tokens INTEGER NOT NULL,
  reason TEXT NOT NULL,
  stripe_event_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_user_id ON token_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_stripe_event ON token_ledger(stripe_event_id);

CREATE TABLE IF NOT EXISTS app_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
