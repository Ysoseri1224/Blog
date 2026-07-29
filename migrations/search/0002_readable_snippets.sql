DROP TABLE author_posts_fts;
DROP TABLE public_posts_fts;

CREATE VIRTUAL TABLE author_posts_fts USING fts5(
  post_id UNINDEXED,
  repository_id UNINDEXED,
  title,
  taxonomy,
  summary,
  body,
  properties,
  display_text UNINDEXED,
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
  display_text UNINDEXED,
  tokenize='porter unicode61 remove_diacritics 2'
);

DELETE FROM index_state;

