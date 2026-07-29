ALTER TABLE posts ADD COLUMN public_index_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN last_public_write_id TEXT;
ALTER TABLE posts ADD COLUMN last_auto_version_at TEXT;

UPDATE posts
SET public_index_version = COALESCE(public_revision, 0);

CREATE TABLE public_snapshot_media (
  snapshot_id TEXT NOT NULL REFERENCES public_snapshots(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('inline','cover')),
  PRIMARY KEY(snapshot_id, asset_id, role)
);
CREATE INDEX public_snapshot_media_asset_idx ON public_snapshot_media(asset_id);
