ALTER TABLE posts ADD COLUMN public_snapshot_id TEXT REFERENCES public_snapshots(id);

ALTER TABLE public_snapshots ADD COLUMN repository_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_snapshots ADD COLUMN category_id TEXT;
ALTER TABLE public_snapshots ADD COLUMN public_repository_key TEXT NOT NULL DEFAULT '';
ALTER TABLE public_snapshots ADD COLUMN public_slug TEXT NOT NULL DEFAULT '';
ALTER TABLE public_snapshots ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-CN';
ALTER TABLE public_snapshots ADD COLUMN summary TEXT;
ALTER TABLE public_snapshots ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_snapshots ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE public_snapshots ADD COLUMN custom_properties_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE public_snapshots ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_snapshots ADD COLUMN character_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_snapshots ADD COLUMN reading_minutes INTEGER NOT NULL DEFAULT 0;

CREATE INDEX public_snapshots_path_idx ON public_snapshots(public_repository_key, public_slug);
CREATE INDEX posts_public_snapshot_idx ON posts(public_snapshot_id);

