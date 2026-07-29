CREATE VIRTUAL TABLE author_posts_fts USING fts5(
  post_id UNINDEXED,
  repository_id UNINDEXED,
  title,
  taxonomy,
  summary,
  body,
  properties,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE public_posts_fts USING fts5(
  post_id UNINDEXED,
  repository_id UNINDEXED,
  snapshot_id UNINDEXED,
  title,
  taxonomy,
  summary,
  body,
  properties,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE index_state (
  post_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('author','public')),
  source_revision INTEGER NOT NULL,
  snapshot_id TEXT,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY(post_id, scope)
);

