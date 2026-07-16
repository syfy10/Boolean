-- Admin console: account bans. Banned users are rejected by requireSession,
-- so /me, /tokens/debit and /chat/completions all stop working immediately.
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN banned_reason TEXT;
