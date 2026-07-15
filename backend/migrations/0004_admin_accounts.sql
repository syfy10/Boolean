ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE token_accounts ADD COLUMN unlimited_tokens INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET role = 'admin'
WHERE lower(email) = 'syfy10@gmail.com';

UPDATE token_accounts
SET plan = 'admin',
    unlimited_tokens = 1,
    free_grant_expires_at = NULL,
    daily_limit_tokens = 0
WHERE user_id IN (
  SELECT id FROM users WHERE lower(email) = 'syfy10@gmail.com'
);
