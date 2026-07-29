CREATE TRIGGER posts_block_pending_repository_insert
BEFORE INSERT ON posts
WHEN EXISTS (
  SELECT 1 FROM deletion_jobs
   WHERE kind='repository' AND target_id=NEW.repository_id AND completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'repository deletion pending');
END;

CREATE TRIGGER posts_block_pending_repository_update
BEFORE UPDATE ON posts
WHEN NEW.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM deletion_jobs
   WHERE kind='repository' AND target_id=NEW.repository_id AND completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'repository deletion pending');
END;

CREATE TRIGGER post_versions_block_pending_repository_insert
BEFORE INSERT ON post_versions
WHEN EXISTS (
  SELECT 1 FROM posts p JOIN deletion_jobs j ON j.target_id=p.repository_id
   WHERE p.id=NEW.post_id AND j.kind='repository' AND j.completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'repository deletion pending');
END;

CREATE TRIGGER public_snapshots_block_pending_repository_insert
BEFORE INSERT ON public_snapshots
WHEN EXISTS (
  SELECT 1 FROM posts p JOIN deletion_jobs j ON j.target_id=p.repository_id
   WHERE p.id=NEW.post_id AND j.kind='repository' AND j.completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'repository deletion pending');
END;
