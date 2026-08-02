import type { PostDetail } from '../shared/types';
import type { z } from 'zod';
import type { postSaveSchema, scheduleSchema } from '../shared/schemas';
import { getManagePost } from './data';
import { sha256Hex } from './crypto';
import { HttpError } from './http';
import { extractLinks, renderMarkdown, stripMarkdown } from './markdown';
import { resolveLinkTargets, resolveWikiTargets } from './linking';
import { loadRenderArtifact, renderArtifactThreshold } from './renderArtifacts';
import { processOutbox, removePublicIndexNow, type SearchDocument } from './search';

type SaveInput = z.infer<typeof postSaveSchema>;
type ScheduleInput = z.infer<typeof scheduleSchema>;
type VersionKind = 'auto' | 'manual' | 'import' | 'publish' | 'scheduled_publish' | 'restore';

interface CurrentPostRow {
  id: string; repository_id: string; category_id: string | null; title: string; slug: string; summary: string | null;
  language: string; markdown: string; status: 'draft' | 'scheduled' | 'published' | 'withdrawn'; featured: number;
  cover_asset_id: string | null; custom_properties_json: string; revision: number; public_revision: number | null;
  public_snapshot_id: string | null; created_at: string; updated_at: string; first_published_at: string | null;
  last_published_at: string | null; scheduled_local: string | null; scheduled_timezone: string | null; scheduled_utc: string | null;
  scheduled_task_id: string | null; public_index_version: number;
}

interface PublicPointerRow {
  id: string;
  canonical_url: string;
  object_key: string;
}

async function loadPublishedHtml(env: Env, snapshotId: string): Promise<string | null> {
  const snapshot = await env.CONTENT_DB.prepare('SELECT object_key FROM public_snapshots WHERE id=?1')
    .bind(snapshotId).first<{ object_key: string }>();
  if (!snapshot) return null;
  const object = await env.BLOG_ARCHIVE.get(snapshot.object_key);
  if (!object) return null;
  return (await object.json<{ html?: string }>()).html ?? null;
}

async function loadPostRow(env: Env, postId: string): Promise<CurrentPostRow> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, repository_id, category_id, title, slug, summary, language, markdown, status, featured,
            cover_asset_id, custom_properties_json, revision, public_revision, public_snapshot_id, created_at,
            updated_at, first_published_at, last_published_at, scheduled_local, scheduled_timezone, scheduled_utc,
            scheduled_task_id, public_index_version
       FROM posts p WHERE id=?1 AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=p.repository_id AND j.completed_at IS NULL
         )`,
  ).bind(postId).first<CurrentPostRow>();
  if (!row) throw new HttpError(404, '文章不存在', 'post_not_found');
  return row;
}

async function validateLocation(env: Env, repositoryId: string, categoryId: string | null): Promise<{ key: string; visibility: string }> {
  const repository = await env.CONTENT_DB.prepare(
    `SELECT url_key,visibility FROM repositories r WHERE id=?1
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  )
    .bind(repositoryId).first<{ url_key: string; visibility: string }>();
  if (!repository) throw new HttpError(400, '仓库不存在', 'repository_not_found');
  if (categoryId) {
    const category = await env.CONTENT_DB.prepare('SELECT repository_id FROM categories WHERE id = ?1')
      .bind(categoryId).first<{ repository_id: string }>();
    if (!category || category.repository_id !== repositoryId) throw new HttpError(400, '分类不属于目标仓库', 'invalid_category');
  }
  return { key: repository.url_key, visibility: repository.visibility };
}

function mediaIds(markdown: string): string[] {
  const ids = [
    ...[...markdown.matchAll(/media:\/\/([0-9a-f-]{36})/gi)].map((match) => match[1]),
    ...[...markdown.matchAll(/\/api\/public\/media\/([0-9a-f-]{36})/gi)].map((match) => match[1]),
  ];
  return [...new Set(ids.map((id) => id?.toLowerCase()).filter((id): id is string => Boolean(id)))];
}

async function validateMedia(env: Env, markdown: string, coverAssetId: string | null): Promise<{ inline: string[]; cover: string | null }> {
  const inline = mediaIds(markdown);
  const all = [...new Set([...inline, ...(coverAssetId ? [coverAssetId] : [])])];
  if (!all.length) return { inline, cover: coverAssetId };
  const placeholders = all.map(() => '?').join(',');
  const found = await env.CONTENT_DB.prepare(
    `SELECT id FROM media_assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
  ).bind(...all).all<{ id: string }>();
  const available = new Set(found.results.map((row) => row.id));
  const missing = all.filter((id) => !available.has(id));
  if (missing.length) throw new HttpError(400, '文章引用了不存在或已删除的媒体资产', 'media_asset_missing');
  return { inline, cover: coverAssetId };
}

function searchDocument(postId: string, input: SaveInput, revision: number, body: string): SearchDocument {
  return {
    postId, repositoryId: input.repositoryId, revision, title: input.title,
    taxonomy: [...input.tags, input.categoryId ?? ''].join(' '), summary: input.summary ?? '', body,
    properties: Object.entries(input.customProperties).map(([key, value]) => `${key} ${String(value)}`).join(' '),
    displayText: body,
  };
}

async function searchTaxonomy(env: Env, categoryId: string | null, tags: string[]): Promise<string> {
  if (!categoryId) return tags.join(' ');
  const path = await env.CONTENT_DB.prepare(
    `WITH RECURSIVE chain(id,parent_id,name,depth) AS (
       SELECT id,parent_id,name,0 FROM categories WHERE id=?1
       UNION ALL
       SELECT parent.id,parent.parent_id,parent.name,chain.depth+1
         FROM categories parent JOIN chain ON parent.id=chain.parent_id
     ) SELECT name FROM chain ORDER BY depth DESC`,
  ).bind(categoryId).all<{ name: string }>();
  return [...tags, path.results.map((row) => row.name).join('/')].filter(Boolean).join(' ');
}

export async function createPost(env: Env, input: { repositoryId: string; categoryId?: string | null; title: string; language: string }): Promise<PostDetail> {
  await validateLocation(env, input.repositoryId, input.categoryId ?? null);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const provisionalSlug = `untitled-${id.slice(0, 8)}`;
  await env.CONTENT_DB.prepare(
    `INSERT INTO posts (id, repository_id, category_id, title, slug, language, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  ).bind(id, input.repositoryId, input.categoryId ?? null, input.title || '未命名', provisionalSlug, input.language, now).run();
  const post = await getManagePost(env, id);
  if (!post) throw new Error('created post missing');
  return post;
}

export async function savePost(
  env: Env,
  ctx: ExecutionContext,
  postId: string,
  input: SaveInput,
  options: { skipAutoVersion?: boolean } = {},
): Promise<PostDetail> {
  const current = await loadPostRow(env, postId);
  await validateLocation(env, input.repositoryId, input.categoryId);
  const duplicate = await env.CONTENT_DB.prepare(
    'SELECT id FROM posts WHERE repository_id = ?1 AND slug = ?2 AND id != ?3 AND deleted_at IS NULL',
  ).bind(input.repositoryId, input.slug, postId).first<{ id: string }>();
  if (duplicate) throw new HttpError(409, '这个仓库中已存在相同 slug', 'slug_conflict');
  const wikiTargets = await resolveWikiTargets(env, input.markdown, false);
  const rendered = await renderMarkdown(input.markdown, { wikiTargets });
  const media = await validateMedia(env, input.markdown, input.coverAssetId);
  const revision = input.baseRevision + 1;
  const writeId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tagNames = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
  const explicitLinks = extractLinks(input.markdown);
  for (const resolved of wikiTargets.values()) if (resolved) explicitLinks.push(resolved.url);
  const links = await resolveLinkTargets(env, explicitLinks);
  const authorDocument = searchDocument(postId, input, revision, rendered.text);
  authorDocument.taxonomy = await searchTaxonomy(env, input.categoryId, tagNames);
  const statements: D1PreparedStatement[] = [
    env.CONTENT_DB.prepare(
      `UPDATE posts SET repository_id=?1, category_id=?2, title=?3, slug=?4, language=?5, summary=?6, markdown=?7,
              featured=?8, cover_asset_id=?9, custom_properties_json=?10, word_count=?11, character_count=?12,
              reading_minutes=?13, revision=?14, updated_at=?15, last_write_id=?16
        WHERE id=?17 AND revision=?18 AND deleted_at IS NULL`,
    ).bind(input.repositoryId, input.categoryId, input.title || '未命名', input.slug, input.language, input.summary,
      input.markdown, input.featured ? 1 : 0, input.coverAssetId, JSON.stringify(input.customProperties), rendered.wordCount,
      rendered.characterCount, rendered.readingMinutes, revision, now, writeId, postId, input.baseRevision),
    env.CONTENT_DB.prepare('DELETE FROM post_tags WHERE post_id = ?1 AND EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?2 AND last_write_id=?3)')
      .bind(postId, revision, writeId),
  ];
  for (const name of tagNames) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT OR IGNORE INTO tags (id, name, created_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM posts WHERE id=?4 AND revision=?5 AND last_write_id=?6)`,
    ).bind(crypto.randomUUID(), name, now, postId, revision, writeId));
    statements.push(env.CONTENT_DB.prepare(
      `INSERT OR IGNORE INTO post_tags (post_id, tag_id)
       SELECT ?1, id FROM tags WHERE name=?2 AND EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?3 AND last_write_id=?4)`,
    ).bind(postId, name, revision, writeId));
  }
  statements.push(env.CONTENT_DB.prepare('DELETE FROM post_links WHERE source_post_id=?1 AND EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?2 AND last_write_id=?3)')
    .bind(postId, revision, writeId));
  for (const link of links) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT OR IGNORE INTO post_links (source_post_id, target_post_id, target_url, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?5 AND last_write_id=?6)`,
    ).bind(postId, link.postId, link.url, now, revision, writeId));
  }
  statements.push(env.CONTENT_DB.prepare(
    'DELETE FROM post_media WHERE post_id=?1 AND EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?2 AND last_write_id=?3)',
  ).bind(postId, revision, writeId));
  for (const assetId of media.inline) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO post_media (post_id,asset_id,role)
       SELECT ?1,?2,'inline' WHERE EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?3 AND last_write_id=?4)`,
    ).bind(postId, assetId, revision, writeId));
  }
  if (media.cover) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO post_media (post_id,asset_id,role)
       SELECT ?1,?2,'cover' WHERE EXISTS (SELECT 1 FROM posts WHERE id=?1 AND revision=?3 AND last_write_id=?4)`,
    ).bind(postId, media.cover, revision, writeId));
  }
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO outbox (id, idempotency_key, action, post_id, repository_id, payload_json, created_at)
     SELECT ?1, ?2, 'upsert_author', ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM posts WHERE id=?3 AND revision=?7 AND last_write_id=?8)`,
  ).bind(crypto.randomUUID(), `author:${postId}:${revision}`, postId, input.repositoryId, JSON.stringify(authorDocument), now, revision, writeId));
  await env.CONTENT_DB.batch(statements);
  const write = await env.CONTENT_DB.prepare('SELECT revision,last_write_id FROM posts WHERE id=?1 AND deleted_at IS NULL')
    .bind(postId).first<{ revision: number; last_write_id: string | null }>();
  if (write?.revision !== revision || write.last_write_id !== writeId) {
    const latest = await loadPostRow(env, postId);
    throw new HttpError(409, `内容已在其他页面更新（当前 revision ${latest.revision}）`, 'revision_conflict');
  }
  ctx.waitUntil(processOutbox(env));
  if (!options.skipAutoVersion) ctx.waitUntil(maybeCreateAutoVersion(env, postId, revision, input.markdown, now));
  if (current.public_snapshot_id && (current.slug !== input.slug || current.repository_id !== input.repositoryId)) {
    // 旧公开地址继续由当前快照服务；只在真正发布新快照时建立重定向。
  }
  const post = await getManagePost(env, postId, { renderedHtml: rendered.html });
  if (!post) throw new Error('saved post missing');
  return post;
}

async function archiveVersion(env: Env, postId: string, revision: number, markdown: string, kind: VersionKind, permanent: boolean, metadata: Record<string, unknown> = {}): Promise<string> {
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({ postId, revision, markdown, kind, createdAt, metadata });
  const checksum = await sha256Hex(payload);
  const versionId = crypto.randomUUID();
  const objectKey = `versions/${postId}/${createdAt.replaceAll(':', '-')}-${revision}-${checksum.slice(0, 12)}.json`;
  await env.BLOG_ARCHIVE.put(objectKey, payload, { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { postId, revision: String(revision), checksum } });
  try {
    await env.CONTENT_DB.prepare(
      `INSERT INTO post_versions (id, post_id, revision, kind, object_key, checksum, created_at, permanent, metadata_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(versionId, postId, revision, kind, objectKey, checksum, createdAt, permanent ? 1 : 0, JSON.stringify(metadata)).run();
  } catch (error) {
    await env.BLOG_ARCHIVE.delete(objectKey);
    throw error;
  }
  return versionId;
}

async function maybeCreateAutoVersion(env: Env, postId: string, revision: number, markdown: string, now: string): Promise<void> {
  await env.CONTENT_DB.prepare(
    `UPDATE posts SET last_auto_version_at=?1
      WHERE id=?2 AND deleted_at IS NULL
        AND (last_auto_version_at IS NULL OR last_auto_version_at<=?3)`,
  ).bind(now, postId, new Date(new Date(now).getTime() - 10 * 60_000).toISOString()).run();
  const claim = await env.CONTENT_DB.prepare('SELECT last_auto_version_at FROM posts WHERE id=?1 AND deleted_at IS NULL')
    .bind(postId).first<{ last_auto_version_at: string | null }>();
  if (claim?.last_auto_version_at !== now) return;
  try {
    await archiveVersion(env, postId, revision, markdown, 'auto', false);
  } catch (error) {
    await env.CONTENT_DB.prepare('UPDATE posts SET last_auto_version_at=NULL WHERE id=?1 AND last_auto_version_at=?2')
      .bind(postId, now).run();
    throw error;
  }
}

export async function createManualVersion(env: Env, postId: string): Promise<string> {
  const post = await loadPostRow(env, postId);
  return archiveVersion(env, postId, post.revision, post.markdown, 'manual', true);
}

export async function createImportVersion(env: Env, postId: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const post = await loadPostRow(env, postId);
  return archiveVersion(env, postId, post.revision, post.markdown, 'import', true, metadata);
}

export function makeOgSvg(title: string, repository: string): string {
  const safeTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const safeRepository = repository.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#f5f0e8"/><filter id="n"><feTurbulence baseFrequency=".75" numOctaves="3"/><feColorMatrix type="saturate" values="0"/></filter><rect width="1200" height="630" filter="url(#n)" opacity=".025"/><text x="88" y="120" fill="#b8522e" font-family="sans-serif" font-size="28">${safeRepository} · ysoseri.us</text><foreignObject x="88" y="176" width="1024" height="330"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 64px/1.18 Georgia,serif;color:#2a221a;display:flex;height:100%;align-items:center">${safeTitle}</div></foreignObject><path d="M88 536h1024" stroke="#2a221a" opacity=".12"/></svg>`;
}

export async function publishPost(env: Env, ctx: ExecutionContext, postId: string, kind: 'publish' | 'scheduled_publish' = 'publish'): Promise<PostDetail> {
  const post = await loadPostRow(env, postId);
  if (post.public_snapshot_id && post.public_revision === post.revision && post.status === 'published' && post.scheduled_task_id === null) {
    const unchanged = await getManagePost(env, postId, { renderedHtml: await loadPublishedHtml(env, post.public_snapshot_id) });
    if (!unchanged) throw new Error('published post missing');
    return unchanged;
  }
  if (!post.title.trim() || post.title === '未命名' || !post.slug.trim() || !post.language.trim() || !stripMarkdown(post.markdown)) {
    throw new HttpError(400, '发布前需要完整标题、slug、原文语言和非空正文', 'publish_validation');
  }
  const repository = await validateLocation(env, post.repository_id, post.category_id);
  const duplicate = await env.CONTENT_DB.prepare(
    'SELECT id FROM posts WHERE repository_id=?1 AND slug=?2 AND id!=?3 AND deleted_at IS NULL',
  ).bind(post.repository_id, post.slug, postId).first<{ id: string }>();
  if (duplicate) throw new HttpError(409, '这个仓库中已存在相同 slug', 'slug_conflict');
  const tagsResult = await env.CONTENT_DB.prepare(
    'SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=?1 ORDER BY t.name',
  ).bind(postId).all<{ name: string }>();
  const tags = tagsResult.results.map((row) => row.name);
  const media = await validateMedia(env, post.markdown, post.cover_asset_id);
  const wikiTargets = await resolveWikiTargets(env, post.markdown, true);
  const artifact = post.markdown.length > renderArtifactThreshold
    ? await loadRenderArtifact(env, postId, post.revision)
    : null;
  const rendered = artifact ?? await renderMarkdown(post.markdown, { wikiTargets });
  const linkUrls = [...rendered.links];
  for (const resolved of wikiTargets.values()) if (resolved) linkUrls.push(resolved.url);
  const linkedPosts = await resolveLinkTargets(env, linkUrls, true);
  const now = new Date().toISOString();
  const firstPublishedAt = post.first_published_at ?? now;
  const snapshotId = crypto.randomUUID();
  const publicWriteId = crypto.randomUUID();
  const nextPublicIndexVersion = post.public_index_version + 1;
  const canonicalUrl = `${env.SITE_ORIGIN}/${repository.key}/${post.slug}`;
  const description = post.summary?.trim() || rendered.description;
  const snapshotPayload = JSON.stringify({
    snapshotId, postId, revision: post.revision, title: post.title, canonicalUrl, description,
    html: rendered.html, text: rendered.text, headings: rendered.headings, links: linkUrls, publishedAt: now, firstPublishedAt,
  });
  const checksum = await sha256Hex(snapshotPayload);
  const objectKey = `public/${postId}/${post.revision}-${checksum.slice(0, 16)}.json`;
  const oldPointer = post.public_snapshot_id
    ? await env.CONTENT_DB.prepare('SELECT id, canonical_url, object_key FROM public_snapshots WHERE id=?1').bind(post.public_snapshot_id).first<PublicPointerRow>()
    : null;
  const coverUrl = post.cover_asset_id ? `${env.SITE_ORIGIN}/api/public/media/${post.cover_asset_id}` : `${env.SITE_ORIGIN}/api/public/og/${snapshotId}.svg`;
  const ogKey = post.cover_asset_id ? null : `og/${snapshotId}.svg`;
  const versionPayload = JSON.stringify({ postId, revision: post.revision, markdown: post.markdown, kind, createdAt: now });
  const versionChecksum = await sha256Hex(versionPayload);
  const versionKey = `versions/${postId}/${now.replaceAll(':', '-')}-${post.revision}-${snapshotId}-${versionChecksum.slice(0, 12)}.json`;
  const publicDocument: SearchDocument = {
    postId, repositoryId: post.repository_id, snapshotId, revision: nextPublicIndexVersion, title: post.title,
    taxonomy: await searchTaxonomy(env, post.category_id, tags), summary: description, body: rendered.text,
    properties: Object.entries(JSON.parse(post.custom_properties_json) as Record<string, unknown>).map(([key, value]) => `${key} ${String(value)}`).join(' '),
    displayText: rendered.text,
  };
  const scheduledGuard = kind === 'scheduled_publish' ? " AND status='scheduled'" : '';
  const expectedTaskId = post.scheduled_task_id;
  const currentWriteGuard = 'EXISTS (SELECT 1 FROM posts WHERE id=? AND public_snapshot_id=? AND public_index_version=? AND last_public_write_id=?)';
  const statements: D1PreparedStatement[] = [
    env.CONTENT_DB.prepare(
      `INSERT INTO public_snapshots
       (id, post_id, revision, object_key, checksum, canonical_url, title, description, cover_url,
        first_published_at, published_at, created_at, repository_id, category_id, public_repository_key,
        public_slug, language, summary, featured, tags_json, custom_properties_json, word_count, character_count, reading_minutes)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23
        WHERE EXISTS (
          SELECT 1 FROM posts WHERE id=?24 AND revision=?25 AND public_snapshot_id IS ?26
            AND public_index_version=?27 AND scheduled_task_id IS ?28${scheduledGuard}
        )`,
    ).bind(snapshotId, postId, post.revision, objectKey, checksum, canonicalUrl, post.title, description, coverUrl,
      firstPublishedAt, now, post.repository_id, post.category_id, repository.key, post.slug, post.language, post.summary,
      post.featured, JSON.stringify(tags), post.custom_properties_json, rendered.wordCount, rendered.characterCount,
      rendered.readingMinutes, postId, post.revision, post.public_snapshot_id, post.public_index_version, expectedTaskId),
    env.CONTENT_DB.prepare(
      `UPDATE posts SET status='published', public_revision=?1, public_snapshot_id=?2, public_snapshot_key=?3,
              public_visible=1, public_index_version=?4, last_public_write_id=?5,
              first_published_at=COALESCE(first_published_at,?6), last_published_at=?6,
              scheduled_local=NULL, scheduled_timezone=NULL, scheduled_utc=NULL, scheduled_task_id=NULL, last_schedule_result=?7
        WHERE id=?8 AND revision=?1 AND public_snapshot_id IS ?9 AND public_index_version=?10
          AND scheduled_task_id IS ?11${scheduledGuard}`,
    ).bind(post.revision, snapshotId, objectKey, nextPublicIndexVersion, publicWriteId, now,
      kind === 'scheduled_publish' ? 'success' : null, postId, post.public_snapshot_id, post.public_index_version, expectedTaskId),
    env.CONTENT_DB.prepare(
      `INSERT INTO post_versions (id,post_id,revision,kind,object_key,checksum,created_at,permanent,metadata_json)
       SELECT ?1,?2,?3,?4,?5,?6,?7,1,?8 WHERE ${currentWriteGuard}`,
    ).bind(crypto.randomUUID(), postId, post.revision, kind, versionKey, versionChecksum, now,
      JSON.stringify({ snapshotId }), postId, snapshotId, nextPublicIndexVersion, publicWriteId),
  ];
  for (const assetId of media.inline) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO public_snapshot_media (snapshot_id,asset_id,role)
       SELECT ?1,?2,'inline' WHERE ${currentWriteGuard}`,
    ).bind(snapshotId, assetId, postId, snapshotId, nextPublicIndexVersion, publicWriteId));
  }
  if (media.cover) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO public_snapshot_media (snapshot_id,asset_id,role)
       SELECT ?1,?2,'cover' WHERE ${currentWriteGuard}`,
    ).bind(snapshotId, media.cover, postId, snapshotId, nextPublicIndexVersion, publicWriteId));
  }
  const outboxId = crypto.randomUUID();
  const outboxAction = repository.visibility === 'private' ? 'delete_public' : 'upsert_public';
  const outboxPayload = repository.visibility === 'private'
    ? JSON.stringify({ postId, revision: nextPublicIndexVersion })
    : JSON.stringify(publicDocument);
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE ${currentWriteGuard}`,
  ).bind(outboxId, `public:${postId}:${nextPublicIndexVersion}`, outboxAction, postId, post.repository_id,
    snapshotId, outboxPayload, now, postId, snapshotId, nextPublicIndexVersion, publicWriteId));
  if (oldPointer && oldPointer.canonical_url !== canonicalUrl) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT OR IGNORE INTO redirects (id,old_path,post_id,repository_id,created_at)
       SELECT ?1,?2,?3,?4,?5 WHERE ${currentWriteGuard}`,
    ).bind(crypto.randomUUID(), new URL(oldPointer.canonical_url).pathname, postId, post.repository_id, now,
      postId, snapshotId, nextPublicIndexVersion, publicWriteId));
  }
  for (const link of linkedPosts) {
    statements.push(env.CONTENT_DB.prepare(
      `INSERT OR IGNORE INTO public_post_links (source_post_id,source_snapshot_id,target_post_id,target_url,created_at)
       SELECT ?1,?2,?3,?4,?5 WHERE ${currentWriteGuard}`,
    ).bind(postId, snapshotId, link.postId, link.url, now, postId, snapshotId, nextPublicIndexVersion, publicWriteId));
  }
  const writtenKeys: string[] = [];
  try {
    await env.BLOG_ARCHIVE.put(objectKey, snapshotPayload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { postId, revision: String(post.revision), checksum },
    });
    writtenKeys.push(objectKey);
    if (ogKey) {
      await env.BLOG_ARCHIVE.put(ogKey, makeOgSvg(post.title, repository.key), {
        httpMetadata: { contentType: 'image/svg+xml', cacheControl: 'public, max-age=31536000, immutable' },
      });
      writtenKeys.push(ogKey);
    }
    await env.BLOG_ARCHIVE.put(versionKey, versionPayload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { postId, revision: String(post.revision), snapshotId, checksum: versionChecksum },
    });
    writtenKeys.push(versionKey);
    await env.CONTENT_DB.batch(statements);
    const pointer = await env.CONTENT_DB.prepare(
      'SELECT public_snapshot_id,public_index_version,last_public_write_id FROM posts WHERE id=?1 AND deleted_at IS NULL',
    ).bind(postId).first<{ public_snapshot_id: string | null; public_index_version: number; last_public_write_id: string | null }>();
    if (pointer?.public_snapshot_id !== snapshotId || pointer.public_index_version !== nextPublicIndexVersion || pointer.last_public_write_id !== publicWriteId) {
      throw new HttpError(409, '发布期间工作稿已变化，请重新预览后发布', 'revision_conflict');
    }
  } catch (error) {
    await Promise.allSettled(writtenKeys.map((key) => env.BLOG_ARCHIVE.delete(key)));
    throw error;
  }
  ctx.waitUntil(processOutbox(env));
  const result = await getManagePost(env, postId, { renderedHtml: rendered.html });
  if (!result) throw new Error('published post missing');
  return result;
}

export async function schedulePost(env: Env, postId: string, input: ScheduleInput): Promise<PostDetail> {
  const post = await loadPostRow(env, postId);
  if (post.revision !== input.baseRevision) throw new HttpError(409, '工作稿已变化，请重新确认计划时间', 'revision_conflict');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    throw new HttpError(400, 'IANA 时区无效', 'invalid_timezone');
  }
  const utc = new Date(input.utcDateTime);
  if (Number.isNaN(utc.getTime()) || utc <= new Date()) throw new HttpError(400, '计划时间必须晚于当前时间', 'invalid_schedule_time');
  const expectedLocal = input.localDateTime.replace('T', ' ').slice(0, 19);
  if (formatter.format(utc).replace(',', '') !== expectedLocal) throw new HttpError(400, '当地时间、时区与 UTC 时刻不一致', 'schedule_timezone_mismatch');
  const scheduledTaskId = crypto.randomUUID();
  await env.CONTENT_DB.prepare(
    `UPDATE posts SET status='scheduled', scheduled_local=?1, scheduled_timezone=?2, scheduled_utc=?3,
      scheduled_task_id=?4, last_schedule_result=NULL,revision=?5,updated_at=?6
      WHERE id=?7 AND revision=?8 AND scheduled_task_id IS ?9`,
  ).bind(input.localDateTime, input.timezone, utc.toISOString(), scheduledTaskId, input.baseRevision + 1,
    new Date().toISOString(), postId, input.baseRevision,
    post.scheduled_task_id).run();
  const scheduled = await env.CONTENT_DB.prepare('SELECT revision,scheduled_task_id FROM posts WHERE id=?1 AND deleted_at IS NULL')
    .bind(postId).first<{ revision: number; scheduled_task_id: string | null }>();
  if (scheduled?.revision !== input.baseRevision + 1 || scheduled.scheduled_task_id !== scheduledTaskId) {
    throw new HttpError(409, '工作稿或发布计划已变化，请重新确认计划时间', 'revision_conflict');
  }
  const result = await getManagePost(env, postId);
  if (!result) throw new Error('scheduled post missing');
  return result;
}

export async function publishDuePosts(env: Env, ctx: ExecutionContext): Promise<void> {
  const due = await env.CONTENT_DB.prepare(
    `SELECT id,scheduled_task_id FROM posts WHERE status='scheduled' AND scheduled_utc <= ?1 AND deleted_at IS NULL ORDER BY scheduled_utc LIMIT 20`,
  ).bind(new Date().toISOString()).all<{ id: string; scheduled_task_id: string | null }>();
  for (const row of due.results) {
    try { await publishPost(env, ctx, row.id, 'scheduled_publish'); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.CONTENT_DB.prepare('UPDATE posts SET last_schedule_result=?1 WHERE id=?2 AND scheduled_task_id IS ?3')
        .bind(`failed:${message.slice(0, 300)}`, row.id, row.scheduled_task_id).run();
    }
  }
}

export async function withdrawPost(env: Env, postId: string): Promise<PostDetail> {
  const post = await loadPostRow(env, postId);
  const nextPublicIndexVersion = post.public_index_version + 1;
  const writeId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `UPDATE posts SET public_index_version=?1,last_public_write_id=?2,
      scheduled_local=NULL,scheduled_timezone=NULL,scheduled_utc=NULL,scheduled_task_id=NULL,updated_at=?3
      WHERE id=?4 AND revision=?5 AND public_snapshot_id IS ?6 AND public_index_version=?7
        AND scheduled_task_id IS ?8 AND deleted_at IS NULL`,
  ).bind(nextPublicIndexVersion, writeId, now, postId, post.revision, post.public_snapshot_id,
    post.public_index_version, post.scheduled_task_id).run();
  const reservation = await env.CONTENT_DB.prepare('SELECT public_index_version,last_public_write_id FROM posts WHERE id=?1 AND deleted_at IS NULL')
    .bind(postId).first<{ public_index_version: number; last_public_write_id: string | null }>();
  if (reservation?.public_index_version !== nextPublicIndexVersion || reservation.last_public_write_id !== writeId) {
    throw new HttpError(409, '公开状态已变化，请重新确认撤回', 'public_state_conflict');
  }
  await removePublicIndexNow(env, postId, nextPublicIndexVersion);
  await env.CONTENT_DB.prepare(
    `UPDATE posts SET status='withdrawn',public_visible=0
      WHERE id=?1 AND public_index_version=?2 AND last_public_write_id=?3`,
  ).bind(postId, nextPublicIndexVersion, writeId).run();
  const closed = await env.CONTENT_DB.prepare('SELECT status,public_visible,last_public_write_id FROM posts WHERE id=?1 AND deleted_at IS NULL')
    .bind(postId).first<{ status: string; public_visible: number; last_public_write_id: string | null }>();
  if (closed?.status !== 'withdrawn' || closed.public_visible !== 0 || closed.last_public_write_id !== writeId) {
    throw new HttpError(409, '撤回期间公开状态已变化，请重新检查文章', 'public_state_conflict');
  }
  const result = await getManagePost(env, postId);
  if (!result) throw new Error('withdrawn post missing');
  return result;
}

export async function listVersions(env: Env, postId: string): Promise<Array<{ id: string; revision: number; kind: VersionKind; createdAt: string; permanent: boolean }>> {
  const result = await env.CONTENT_DB.prepare(
    'SELECT id, revision, kind, created_at, permanent FROM post_versions WHERE post_id=?1 ORDER BY created_at DESC LIMIT 250',
  ).bind(postId).all<{ id: string; revision: number; kind: VersionKind; created_at: string; permanent: number }>();
  return result.results.map((row) => ({ id: row.id, revision: row.revision, kind: row.kind, createdAt: row.created_at, permanent: row.permanent === 1 }));
}

export async function getVersion(env: Env, postId: string, versionId: string): Promise<{ markdown: string; revision: number; createdAt: string }> {
  const row = await env.CONTENT_DB.prepare(
    'SELECT object_key, revision, created_at FROM post_versions WHERE id=?1 AND post_id=?2',
  ).bind(versionId, postId).first<{ object_key: string; revision: number; created_at: string }>();
  if (!row) throw new HttpError(404, '历史版本不存在', 'version_not_found');
  const object = await env.BLOG_ARCHIVE.get(row.object_key);
  if (!object) throw new HttpError(503, '历史归档暂时不可用', 'version_object_missing');
  const payload = await object.json<{ markdown: string }>();
  return { markdown: payload.markdown, revision: row.revision, createdAt: row.created_at };
}

export async function restoreVersion(env: Env, ctx: ExecutionContext, postId: string, versionId: string, baseRevision: number): Promise<PostDetail> {
  const [current, currentDetail, version] = await Promise.all([
    loadPostRow(env, postId), getManagePost(env, postId), getVersion(env, postId, versionId),
  ]);
  if (!currentDetail) throw new HttpError(404, '文章不存在', 'post_not_found');
  if (current.revision !== baseRevision) throw new HttpError(409, '工作稿已变化，请重新比较后恢复', 'revision_conflict');
  await archiveVersion(env, postId, current.revision, current.markdown, 'restore', true, { restoringFrom: versionId, phase: 'before' });
  const restored = await savePost(env, ctx, postId, {
    baseRevision,
    title: currentDetail.title,
    slug: currentDetail.slug,
    repositoryId: currentDetail.repositoryId,
    categoryId: currentDetail.categoryId,
    language: currentDetail.language,
    summary: currentDetail.summary,
    markdown: version.markdown,
    tags: currentDetail.tags,
    featured: currentDetail.featured,
    coverAssetId: currentDetail.coverAssetId,
    customProperties: currentDetail.customProperties,
  }, { skipAutoVersion: true });
  await archiveVersion(env, postId, restored.revision, version.markdown, 'restore', true, { restoringFrom: versionId, phase: 'after' });
  return restored;
}
