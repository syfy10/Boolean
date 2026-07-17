-- Admin-only cross-device notepad snapshots. One compact document per user;
-- the revision supports optimistic concurrency between multiple computers.
CREATE TABLE IF NOT EXISTS cloud_notepads (
  user_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
