ALTER TABLE token_accounts ADD COLUMN free_grant_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_accounts ADD COLUMN free_grant_expires_at INTEGER;
ALTER TABLE token_accounts ADD COLUMN daily_limit_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_accounts ADD COLUMN daily_used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_accounts ADD COLUMN daily_reset_at INTEGER NOT NULL DEFAULT 0;
