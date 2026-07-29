CREATE TABLE deleted_urls (
  path TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  former_post_id TEXT NOT NULL
);

