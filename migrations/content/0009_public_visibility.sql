ALTER TABLE posts ADD COLUMN public_visible INTEGER NOT NULL DEFAULT 0 CHECK (public_visible IN (0,1));

UPDATE posts
SET public_visible = 1
WHERE status = 'published' AND public_snapshot_id IS NOT NULL;

CREATE INDEX posts_public_visible_idx ON posts(public_visible, repository_id);

