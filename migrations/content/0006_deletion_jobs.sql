CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('post','repository')),
  target_id TEXT NOT NULL,
  object_keys_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX deletion_jobs_pending_idx ON deletion_jobs(completed_at, created_at);

