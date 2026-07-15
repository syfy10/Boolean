CREATE TABLE IF NOT EXISTS app_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_counters (key, value, updated_at)
VALUES ('free_signup_grants_used', 0, unixepoch());
