PRAGMA foreign_keys = ON;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','unlisted','private')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, parent_id, name)
);
CREATE INDEX categories_repository_parent_idx ON categories(repository_id, parent_id);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '未命名',
  slug TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  summary TEXT,
  markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','withdrawn')),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  cover_asset_id TEXT,
  custom_properties_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  public_revision INTEGER,
  public_snapshot_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_published_at TEXT,
  last_published_at TEXT,
  scheduled_local TEXT,
  scheduled_timezone TEXT,
  scheduled_utc TEXT,
  scheduled_task_id TEXT,
  last_schedule_result TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  character_count INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  UNIQUE(repository_id, slug)
);
CREATE INDEX posts_repository_category_idx ON posts(repository_id, category_id);
CREATE INDEX posts_repository_status_idx ON posts(repository_id, status, first_published_at);
CREATE INDEX posts_scheduled_idx ON posts(status, scheduled_utc);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(post_id, tag_id)
);

CREATE TABLE post_links (
  source_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  target_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_post_id, target_post_id, target_url)
);
CREATE INDEX post_links_target_idx ON post_links(target_post_id);

CREATE TABLE post_versions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual','import','publish','scheduled_publish','restore')),
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX post_versions_post_created_idx ON post_versions(post_id, created_at DESC);

CREATE TABLE public_snapshots (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  cover_url TEXT,
  first_published_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX public_snapshots_post_created_idx ON public_snapshots(post_id, created_at DESC);

CREATE TABLE redirects (
  id TEXT PRIMARY KEY,
  old_path TEXT NOT NULL UNIQUE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL,
  user_agent_hash TEXT,
  ip_hash TEXT
);
CREATE INDEX sessions_active_idx ON sessions(token_hash, expires_at, revoked_at);

CREATE TABLE auth_attempts (
  key_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT NOT NULL,
  last_failure_at TEXT NOT NULL,
  blocked_until TEXT
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('upsert_author','delete_author','upsert_public','delete_public')),
  post_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX outbox_pending_idx ON outbox(processed_at, created_at);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX media_assets_created_idx ON media_assets(created_at DESC);

CREATE TABLE post_media (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('inline','cover')),
  PRIMARY KEY(post_id, asset_id, role)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO repositories (id, name, url_key, visibility, created_at, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', '生活碎片', 'life', 'public', datetime('now'), datetime('now')),
  ('22222222-2222-4222-8222-222222222222', '我的思考', 'thoughts', 'public', datetime('now'), datetime('now')),
  ('33333333-3333-4333-8333-333333333333', '技术内容', 'tech', 'public', datetime('now'), datetime('now'));

