CREATE TABLE object_deletion_queue (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('auto_version')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX object_deletion_queue_pending_idx ON object_deletion_queue(completed_at, created_at);
