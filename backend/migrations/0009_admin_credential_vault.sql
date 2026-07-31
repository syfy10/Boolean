-- Admin-only encrypted API key and connection backup. Credential JSON is
-- encrypted by the Worker before it reaches D1; plaintext is never stored.
CREATE TABLE IF NOT EXISTS cloud_credential_vaults (
  user_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
