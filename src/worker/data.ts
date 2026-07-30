import type { Category, PostDetail, PostStatus, PostSummary, RecentPublicPost, Repository, RepositoryWorkspace, Visibility } from '../shared/types';
import { renderMarkdown } from './markdown';
import { resolveWikiTargets } from './linking';

interface RepositoryRow {
  id: string; name: string; url_key: string; visibility: Visibility; created_at: string; updated_at: string;
}
interface CategoryRow {
  id: string; repository_id: string; parent_id: string | null; name: string; created_at: string; updated_at: string;
}
interface PostRow {
  id: string; repository_id: string; category_id: string | null; title: string; slug: string; summary: string | null;
  language: string; status: PostStatus; featured: number; created_at: string; updated_at: string;
  first_published_at: string | null; last_published_at: string | null; scheduled_local: string | null;
  scheduled_timezone: string | null; scheduled_utc: string | null; word_count: number; character_count: number;
  reading_minutes: number; revision: number; public_revision: number | null; markdown?: string; cover_asset_id?: string | null;
  custom_properties_json?: string; tags_json?: string;
}
interface SnapshotRow extends PostRow {
  snapshot_id: string;
  object_key: string;
  canonical_url: string;
  published_at: string;
}
interface SnapshotObject {
  html: string;
  headings: Array<{ depth: number; text: string; id: string }>;
  links: string[];
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function mapRepository(row: RepositoryRow): Repository {
  return { id: row.id, name: row.name, key: row.url_key, visibility: row.visibility, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapCategory(row: CategoryRow): Category {
  return { id: row.id, repositoryId: row.repository_id, parentId: row.parent_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapPost(row: PostRow, tags: string[] = parseJson<string[]>(row.tags_json, [])): PostSummary {
  return {
    id: row.id, repositoryId: row.repository_id, categoryId: row.category_id, title: row.title, slug: row.slug,
    summary: row.summary, language: row.language, status: row.status, featured: row.featured === 1, tags,
    createdAt: row.created_at, updatedAt: row.updated_at, firstPublishedAt: row.first_published_at,
    lastPublishedAt: row.last_published_at, scheduledLocal: row.scheduled_local, scheduledTimezone: row.scheduled_timezone,
    scheduledUtc: row.scheduled_utc, wordCount: row.word_count, characterCount: row.character_count,
    readingMinutes: row.reading_minutes, revision: row.revision, publicRevision: row.public_revision,
  };
}

async function tagsByPost(env: Env, postIds: string[]): Promise<Map<string, string[]>> {
  if (!postIds.length) return new Map();
  const placeholders = postIds.map(() => '?').join(',');
  const result = await env.CONTENT_DB.prepare(
    `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id IN (${placeholders}) ORDER BY t.name`,
  ).bind(...postIds).all<{ post_id: string; name: string }>();
  const mapped = new Map<string, string[]>();
  for (const row of result.results) mapped.set(row.post_id, [...(mapped.get(row.post_id) ?? []), row.name]);
  return mapped;
}

export async function listRepositories(env: Env, author: boolean): Promise<Repository[]> {
  const query = author
    ? `SELECT id, name, url_key, visibility, created_at, updated_at FROM repositories r
       WHERE NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)
       ORDER BY created_at`
    : `SELECT id, name, url_key, visibility, created_at, updated_at FROM repositories r
       WHERE visibility='public'
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)
       ORDER BY created_at`;
  const result = await env.CONTENT_DB.prepare(query).all<RepositoryRow>();
  return result.results.map(mapRepository);
}

export async function getRepositoryByKey(env: Env, key: string, author: boolean): Promise<Repository | null> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, name, url_key, visibility, created_at, updated_at FROM repositories r
     WHERE url_key = ?1 ${author ? '' : "AND visibility != 'private'"}
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  ).bind(key).first<RepositoryRow>();
  return row ? mapRepository(row) : null;
}

export async function getRepositoryById(env: Env, id: string): Promise<Repository | null> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, name, url_key, visibility, created_at, updated_at FROM repositories r WHERE id=?1
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  ).bind(id).first<RepositoryRow>();
  return row ? mapRepository(row) : null;
}

async function listCategories(env: Env, repositoryId: string): Promise<Category[]> {
  const result = await env.CONTENT_DB.prepare(
    'SELECT id, repository_id, parent_id, name, created_at, updated_at FROM categories WHERE repository_id = ?1 ORDER BY name',
  ).bind(repositoryId).all<CategoryRow>();
  return result.results.map(mapCategory);
}

function publicCategorySubset(categories: Category[], posts: PostSummary[]): Category[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const included = new Set<string>();
  for (const post of posts) {
    let current = post.categoryId ? byId.get(post.categoryId) : undefined;
    while (current && !included.has(current.id)) {
      included.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return categories.filter((category) => included.has(category.id));
}

export async function getWorkspace(env: Env, repository: Repository, author: boolean): Promise<RepositoryWorkspace> {
  const categories = await listCategories(env, repository.id);
  if (author) {
    const result = await env.CONTENT_DB.prepare(
      `SELECT id, repository_id, category_id, title, slug, summary, language, status, featured,
              created_at, updated_at, first_published_at, last_published_at, scheduled_local,
              scheduled_timezone, scheduled_utc, word_count, character_count, reading_minutes, revision, public_revision
       FROM posts WHERE repository_id = ?1 AND deleted_at IS NULL`,
    ).bind(repository.id).all<PostRow>();
    const tags = await tagsByPost(env, result.results.map((post) => post.id));
    return { repository, categories, posts: result.results.map((post) => mapPost(post, tags.get(post.id) ?? [])) };
  }
  const result = await env.CONTENT_DB.prepare(
    `SELECT p.id, s.repository_id, s.category_id, s.title, s.public_slug AS slug, s.summary, s.language,
            'published' AS status, s.featured, p.created_at, s.published_at AS updated_at,
            s.first_published_at, s.published_at AS last_published_at, NULL AS scheduled_local,
            NULL AS scheduled_timezone, NULL AS scheduled_utc, s.word_count, s.character_count,
            s.reading_minutes, s.revision, s.revision AS public_revision, s.tags_json
       FROM posts p JOIN public_snapshots s ON s.id = p.public_snapshot_id
      WHERE s.repository_id = ?1 AND p.public_visible = 1 AND p.deleted_at IS NULL`,
  ).bind(repository.id).all<PostRow>();
  const posts = result.results.map((post) => mapPost(post));
  return { repository, categories: publicCategorySubset(categories, posts), posts };
}

export async function listRecentPublicPosts(env: Env, limit: number): Promise<RecentPublicPost[]> {
  const result = await env.CONTENT_DB.prepare(
    `SELECT p.id,s.title,s.description,s.canonical_url,s.public_repository_key,r.name AS repository_name,
            s.language,s.first_published_at,s.published_at
       FROM posts p
       JOIN public_snapshots s ON s.id=p.public_snapshot_id
       JOIN repositories r ON r.id=s.repository_id
      WHERE p.public_visible=1 AND p.deleted_at IS NULL AND r.visibility='public'
        AND NOT EXISTS (
          SELECT 1 FROM deletion_jobs j
           WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL
        )
      ORDER BY s.first_published_at DESC,s.published_at DESC,s.id DESC
      LIMIT ?1`,
  ).bind(limit).all<{
    id: string; title: string; description: string; canonical_url: string; public_repository_key: string;
    repository_name: string; language: string; first_published_at: string; published_at: string;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    url: row.canonical_url,
    repositoryKey: row.public_repository_key,
    repositoryName: row.repository_name,
    language: row.language,
    firstPublishedAt: row.first_published_at,
    lastPublishedAt: row.published_at,
  }));
}

async function backlinks(env: Env, postId: string, author: boolean): Promise<PostDetail['backlinks']> {
  if (author) {
    const result = await env.CONTENT_DB.prepare(
      `SELECT p.id AS post_id, p.title, p.slug, r.url_key, r.name AS repository_name
         FROM post_links l JOIN posts p ON p.id = l.source_post_id JOIN repositories r ON r.id = p.repository_id
        WHERE l.target_post_id = ?1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`,
    ).bind(postId).all<{ post_id: string; title: string; slug: string; url_key: string; repository_name: string }>();
    return result.results.map((row) => ({ postId: row.post_id, title: row.title, url: `/${row.url_key}/${row.slug}`, repositoryName: row.repository_name }));
  }
  const result = await env.CONTENT_DB.prepare(
    `SELECT p.id AS post_id, s.title, s.public_slug AS slug, s.public_repository_key AS url_key, r.name AS repository_name
       FROM public_post_links l
       JOIN posts p ON p.id = l.source_post_id AND p.public_snapshot_id = l.source_snapshot_id
       JOIN public_snapshots s ON s.id = l.source_snapshot_id
       JOIN repositories r ON r.id = s.repository_id
      WHERE l.target_post_id = ?1 AND p.public_visible = 1 AND r.visibility != 'private'
      ORDER BY s.published_at DESC`,
  ).bind(postId).all<{ post_id: string; title: string; slug: string; url_key: string; repository_name: string }>();
  return result.results.map((row) => ({ postId: row.post_id, title: row.title, url: `/${row.url_key}/${row.slug}`, repositoryName: row.repository_name }));
}

export async function getManagePost(env: Env, postId: string): Promise<PostDetail | null> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, repository_id, category_id, title, slug, summary, language, status, featured, markdown,
            cover_asset_id, custom_properties_json, created_at, updated_at, first_published_at, last_published_at,
            scheduled_local, scheduled_timezone, scheduled_utc, word_count, character_count, reading_minutes,
            revision, public_revision FROM posts WHERE id = ?1 AND deleted_at IS NULL`,
  ).bind(postId).first<PostRow>();
  if (!row) return null;
  const [tags, linked, back, wikiTargets] = await Promise.all([
    tagsByPost(env, [postId]),
    env.CONTENT_DB.prepare(
      `SELECT p.id AS post_id, p.title, r.url_key, p.slug FROM post_links l JOIN posts p ON p.id = l.target_post_id
       JOIN repositories r ON r.id = p.repository_id WHERE l.source_post_id = ?1`,
    ).bind(postId).all<{ post_id: string; title: string; url_key: string; slug: string }>(),
    backlinks(env, postId, true), resolveWikiTargets(env, row.markdown ?? '', false),
  ]);
  const rendered = await renderMarkdown(row.markdown ?? '', { wikiTargets });
  return {
    ...mapPost(row, tags.get(postId) ?? []), markdown: row.markdown ?? '', html: rendered.html,
    coverAssetId: row.cover_asset_id ?? null, customProperties: parseJson<Record<string, unknown>>(row.custom_properties_json, {}),
    forwardLinks: linked.results.map((link) => ({ postId: link.post_id, title: link.title, url: `/${link.url_key}/${link.slug}` })), backlinks: back,
  };
}

export async function getPublicPostByPath(env: Env, repositoryKey: string, slug: string): Promise<PostDetail | null> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT p.id, s.repository_id, s.category_id, s.title, s.public_slug AS slug, s.summary, s.language,
            'published' AS status, s.featured, p.created_at, s.published_at AS updated_at,
            s.first_published_at, s.published_at AS last_published_at, NULL AS scheduled_local,
            NULL AS scheduled_timezone, NULL AS scheduled_utc, s.word_count, s.character_count, s.reading_minutes,
            s.revision, s.revision AS public_revision, s.tags_json, s.custom_properties_json, s.id AS snapshot_id,
            s.object_key, s.canonical_url
       FROM posts p JOIN public_snapshots s ON s.id = p.public_snapshot_id JOIN repositories r ON r.id = s.repository_id
      WHERE s.public_repository_key = ?1 AND s.public_slug = ?2 AND p.public_visible = 1
        AND p.deleted_at IS NULL AND r.visibility != 'private'`,
  ).bind(repositoryKey, slug).first<SnapshotRow>();
  if (!row) return null;
  const object = await env.BLOG_ARCHIVE.get(row.object_key);
  if (!object) return null;
  const snapshot = await object.json<SnapshotObject>();
  const back = await backlinks(env, row.id, false);
  return {
    ...mapPost(row), markdown: '', html: snapshot.html, coverAssetId: null,
    customProperties: parseJson<Record<string, unknown>>(row.custom_properties_json, {}),
    forwardLinks: [], backlinks: back,
  };
}

export async function resolveRedirect(env: Env, path: string): Promise<{ location: string; createdAt: string } | null> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT s.canonical_url, r.url_key, d.created_at FROM redirects d
     JOIN repositories r ON r.id=d.repository_id
     LEFT JOIN posts p ON p.id=d.post_id
     LEFT JOIN public_snapshots s ON s.id=p.public_snapshot_id
     WHERE d.old_path = ?1 AND r.visibility != 'private'`,
  ).bind(path).first<{ canonical_url: string | null; url_key: string; created_at: string }>();
  if (!row) return null;
  return {
    location: row.canonical_url ?? `${env.SITE_ORIGIN}/${row.url_key}/`,
    createdAt: row.created_at,
  };
}
