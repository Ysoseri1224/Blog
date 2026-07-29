CREATE TABLE public_post_links (
  source_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source_snapshot_id TEXT NOT NULL REFERENCES public_snapshots(id) ON DELETE CASCADE,
  target_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_snapshot_id, target_post_id, target_url)
);
CREATE INDEX public_post_links_target_idx ON public_post_links(target_post_id);

