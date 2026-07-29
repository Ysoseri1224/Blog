import { reservedRepositoryKeys, type repositoryCreateSchema, type repositoryUpdateSchema } from '../shared/schemas';
import type { z } from 'zod';
import { mapRepository } from './data';
import { sha256Hex } from './crypto';
import { HttpError } from './http';
import { renderMarkdown } from './markdown';
import { makeOgSvg } from './publishing';
import { processOutbox, type SearchDocument } from './search';

type RepositoryCreate = z.infer<typeof repositoryCreateSchema>;
type RepositoryUpdate = z.infer<typeof repositoryUpdateSchema>;

interface RepositoryRow {
  id: string; name: string; url_key: string; visibility: 'public' | 'unlisted' | 'private'; created_at: string; updated_at: string;
}

interface CurrentPublicSnapshotRow {
  post_id: string; public_index_version: number; id: string; revision: number; object_key: string; checksum: string;
  canonical_url: string; title: string; description: string; cover_url: string | null; first_published_at: string;
  published_at: string; created_at: string; repository_id: string; category_id: string | null;
  public_repository_key: string; public_slug: string; language: string; summary: string | null; featured: number;
  tags_json: string; custom_properties_json: string; word_count: number; character_count: number; reading_minutes: number;
}

interface RelocatedSnapshot {
  source: CurrentPublicSnapshotRow;
  id: string;
  objectKey: string;
  checksum: string;
  canonicalUrl: string;
  coverUrl: string | null;
  repositoryId: string;
  repositoryKey: string;
  categoryId: string | null;
  payload: string;
  ogKey: string | null;
  publicDocument: SearchDocument;
}

function htmlText(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function jsonProperties(value: string): string {
  try {
    return Object.entries(JSON.parse(value) as Record<string, unknown>)
      .map(([key, property]) => `${key} ${String(property)}`).join(' ');
  } catch {
    return '';
  }
}

async function snapshotTaxonomy(env: Env, categoryId: string | null, tagsJson: string): Promise<string> {
  let tags: string[] = [];
  try { tags = JSON.parse(tagsJson) as string[]; } catch { /* 旧数据损坏时仍允许修复位置。 */ }
  if (!categoryId) return tags.join(' ');
  const path = await env.CONTENT_DB.prepare(
    `WITH RECURSIVE chain(id,parent_id,name,depth) AS (
       SELECT id,parent_id,name,0 FROM categories WHERE id=?1
       UNION ALL SELECT c.id,c.parent_id,c.name,chain.depth+1 FROM categories c JOIN chain ON c.id=chain.parent_id
     ) SELECT name FROM chain ORDER BY depth DESC`,
  ).bind(categoryId).all<{ name: string }>();
  return [...tags, path.results.map((row) => row.name).join('/')].filter(Boolean).join(' ');
}

async function loadCurrentPublicSnapshots(env: Env, repositoryId: string): Promise<CurrentPublicSnapshotRow[]> {
  const snapshots = await env.CONTENT_DB.prepare(
    `SELECT p.id AS post_id,p.public_index_version,s.id,s.revision,s.object_key,s.checksum,s.canonical_url,
            s.title,s.description,s.cover_url,s.first_published_at,s.published_at,s.created_at,s.repository_id,
            s.category_id,s.public_repository_key,s.public_slug,s.language,s.summary,s.featured,s.tags_json,
            s.custom_properties_json,s.word_count,s.character_count,s.reading_minutes
       FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id
      WHERE p.repository_id=?1 AND p.public_visible=1 AND p.deleted_at IS NULL`,
  ).bind(repositoryId).all<CurrentPublicSnapshotRow>();
  return snapshots.results;
}

function generatedOgFor(snapshot: CurrentPublicSnapshotRow): boolean {
  if (!snapshot.cover_url) return false;
  try { return new URL(snapshot.cover_url).pathname === `/api/public/og/${snapshot.id}.svg`; } catch { return false; }
}

async function prepareRelocatedSnapshot(
  env: Env,
  snapshot: CurrentPublicSnapshotRow,
  repositoryId: string,
  repositoryKey: string,
  categoryId: string | null,
): Promise<RelocatedSnapshot> {
  const object = await env.BLOG_ARCHIVE.get(snapshot.object_key);
  if (!object) throw new HttpError(409, `公开快照对象缺失：${snapshot.post_id}`, 'public_snapshot_object_missing');
  let sourcePayload: Record<string, unknown>;
  try {
    sourcePayload = await object.json<Record<string, unknown>>();
  } catch {
    throw new HttpError(409, `公开快照对象损坏：${snapshot.post_id}`, 'public_snapshot_object_invalid');
  }
  const id = crypto.randomUUID();
  const canonicalUrl = `${env.SITE_ORIGIN}/${repositoryKey}/${snapshot.public_slug}`;
  const payload = JSON.stringify({ ...sourcePayload, snapshotId: id, canonicalUrl });
  const checksum = await sha256Hex(payload);
  const objectKey = `public/${snapshot.post_id}/${snapshot.revision}-${checksum.slice(0, 16)}-${id.slice(0, 8)}.json`;
  const generatedOg = generatedOgFor(snapshot);
  const coverUrl = generatedOg ? `${env.SITE_ORIGIN}/api/public/og/${id}.svg` : snapshot.cover_url;
  const displayText = typeof sourcePayload.text === 'string'
    ? sourcePayload.text
    : htmlText(typeof sourcePayload.html === 'string' ? sourcePayload.html : '');
  return {
    source: snapshot, id, objectKey, checksum, canonicalUrl, coverUrl, repositoryId, repositoryKey, categoryId,
    payload, ogKey: generatedOg ? `og/${id}.svg` : null,
    publicDocument: {
      postId: snapshot.post_id, repositoryId, snapshotId: id, revision: snapshot.public_index_version + 1,
      title: snapshot.title, taxonomy: await snapshotTaxonomy(env, categoryId, snapshot.tags_json),
      summary: snapshot.summary ?? snapshot.description, body: displayText,
      properties: jsonProperties(snapshot.custom_properties_json), displayText,
    },
  };
}

async function documentForExistingSnapshot(
  env: Env,
  snapshot: CurrentPublicSnapshotRow,
  repositoryId: string,
  revision: number,
): Promise<SearchDocument> {
  const object = await env.BLOG_ARCHIVE.get(snapshot.object_key);
  if (!object) throw new HttpError(409, `公开快照对象缺失：${snapshot.post_id}`, 'public_snapshot_object_missing');
  let payload: Record<string, unknown>;
  try { payload = await object.json<Record<string, unknown>>(); } catch {
    throw new HttpError(409, `公开快照对象损坏：${snapshot.post_id}`, 'public_snapshot_object_invalid');
  }
  const displayText = typeof payload.text === 'string'
    ? payload.text
    : htmlText(typeof payload.html === 'string' ? payload.html : '');
  return {
    postId: snapshot.post_id, repositoryId, snapshotId: snapshot.id, revision, title: snapshot.title,
    taxonomy: await snapshotTaxonomy(env, snapshot.category_id, snapshot.tags_json),
    summary: snapshot.summary ?? snapshot.description, body: displayText,
    properties: jsonProperties(snapshot.custom_properties_json), displayText,
  };
}

async function writeRelocatedObjects(env: Env, plans: RelocatedSnapshot[], writtenKeys: string[]): Promise<void> {
  for (const plan of plans) {
    await env.BLOG_ARCHIVE.put(plan.objectKey, plan.payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { postId: plan.source.post_id, revision: String(plan.source.revision), snapshotId: plan.id, checksum: plan.checksum },
    });
    writtenKeys.push(plan.objectKey);
    if (plan.ogKey) {
      await env.BLOG_ARCHIVE.put(plan.ogKey, makeOgSvg(plan.source.title, plan.repositoryKey), {
        httpMetadata: { contentType: 'image/svg+xml', cacheControl: 'public, max-age=31536000, immutable' },
      });
      writtenKeys.push(plan.ogKey);
    }
  }
}

function appendSnapshotInsert(
  env: Env,
  statements: D1PreparedStatement[],
  plan: RelocatedSnapshot,
  now: string,
): void {
  const source = plan.source;
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO public_snapshots
     (id,post_id,revision,object_key,checksum,canonical_url,title,description,cover_url,first_published_at,
      published_at,created_at,repository_id,category_id,public_repository_key,public_slug,language,summary,
      featured,tags_json,custom_properties_json,word_count,character_count,reading_minutes)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24
      WHERE EXISTS (SELECT 1 FROM posts WHERE id=?25 AND public_snapshot_id=?26
        AND public_index_version=?27 AND public_visible=1 AND deleted_at IS NULL)`,
  ).bind(plan.id, source.post_id, source.revision, plan.objectKey, plan.checksum, plan.canonicalUrl, source.title,
    source.description, plan.coverUrl, source.first_published_at, source.published_at, now, plan.repositoryId,
    plan.categoryId, plan.repositoryKey, source.public_slug, source.language, source.summary, source.featured,
    source.tags_json, source.custom_properties_json, source.word_count, source.character_count, source.reading_minutes,
    source.post_id, source.id, source.public_index_version));
}

function appendSnapshotRelations(
  env: Env,
  statements: D1PreparedStatement[],
  plan: RelocatedSnapshot,
  nextVersion: number,
  writeId: string,
  now: string,
): void {
  const guard = `EXISTS (SELECT 1 FROM posts WHERE id=? AND public_snapshot_id=?
    AND public_index_version=? AND last_public_write_id=?)`;
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO public_snapshot_media (snapshot_id,asset_id,role)
     SELECT ?1,asset_id,role FROM public_snapshot_media WHERE snapshot_id=?2 AND ${guard}`,
  ).bind(plan.id, plan.source.id, plan.source.post_id, plan.id, nextVersion, writeId));
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO public_post_links (source_post_id,source_snapshot_id,target_post_id,target_url,created_at)
     SELECT source_post_id,?1,target_post_id,target_url,?2 FROM public_post_links
      WHERE source_snapshot_id=?3 AND ${guard}`,
  ).bind(plan.id, now, plan.source.id, plan.source.post_id, plan.id, nextVersion, writeId));
}

function appendOperationAssertion(
  env: Env,
  statements: D1PreparedStatement[],
  id: string,
  expected: number,
  actualSql: string,
  bindings: unknown[],
): void {
  statements.push(env.CONTENT_DB.prepare(
    `INSERT INTO operation_assertions (id,expected,actual) SELECT ?1,?2,(${actualSql})`,
  ).bind(id, expected, ...bindings));
}

export async function createRepository(env: Env, input: RepositoryCreate) {
  if (reservedRepositoryKeys.has(input.key)) throw new HttpError(400, '这个 URL key 是系统保留字', 'reserved_repository_key');
  const now = new Date().toISOString();
  const row: RepositoryRow = { id: crypto.randomUUID(), name: input.name, url_key: input.key, visibility: input.visibility, created_at: now, updated_at: now };
  try {
    await env.CONTENT_DB.prepare(
      'INSERT INTO repositories (id,name,url_key,visibility,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)',
    ).bind(row.id, row.name, row.url_key, row.visibility, now).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) throw new HttpError(409, '仓库 URL key 已存在', 'repository_key_conflict');
    throw error;
  }
  return mapRepository(row);
}

export async function updateRepository(env: Env, ctx: ExecutionContext, repositoryId: string, input: RepositoryUpdate) {
  const current = await env.CONTENT_DB.prepare(
    `SELECT id,name,url_key,visibility,created_at,updated_at FROM repositories r WHERE id=?1
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  ).bind(repositoryId).first<RepositoryRow>();
  if (!current) throw new HttpError(404, '仓库不存在', 'repository_not_found');
  const next = { name: input.name ?? current.name, key: input.key ?? current.url_key, visibility: input.visibility ?? current.visibility };
  if (reservedRepositoryKeys.has(next.key)) throw new HttpError(400, '这个 URL key 是系统保留字', 'reserved_repository_key');
  const keyChanged = next.key !== current.url_key;
  const privateBoundaryChanged = (current.visibility === 'private') !== (next.visibility === 'private');
  const snapshots = keyChanged || privateBoundaryChanged ? await loadCurrentPublicSnapshots(env, repositoryId) : [];
  const plans = keyChanged
    ? await Promise.all(snapshots.map((snapshot) => prepareRelocatedSnapshot(
      env, snapshot, repositoryId, next.key, snapshot.category_id,
    )))
    : [];
  const planByPost = new Map(plans.map((plan) => [plan.source.post_id, plan]));
  const documents = new Map<string, SearchDocument>();
  if (next.visibility !== 'private') {
    for (const snapshot of snapshots) {
      const plan = planByPost.get(snapshot.post_id);
      documents.set(snapshot.post_id, plan?.publicDocument
        ?? await documentForExistingSnapshot(env, snapshot, repositoryId, snapshot.public_index_version + 1));
    }
  }
  const now = new Date().toISOString();
  const repositoryWriteId = crypto.randomUUID();
  const publicWriteId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (keyChanged) {
    for (const oldPath of [`/${current.url_key}`, `/${current.url_key}/`]) {
      statements.push(env.CONTENT_DB.prepare(
        'INSERT OR IGNORE INTO redirects (id,old_path,post_id,repository_id,created_at) VALUES (?1,?2,NULL,?3,?4)',
      ).bind(crypto.randomUUID(), oldPath, repositoryId, now));
    }
  }
  for (const snapshot of snapshots) {
    const plan = planByPost.get(snapshot.post_id);
    if (plan) appendSnapshotInsert(env, statements, plan, now);
    const nextSnapshotId = plan?.id ?? snapshot.id;
    const nextObjectKey = plan?.objectKey ?? snapshot.object_key;
    const nextVersion = snapshot.public_index_version + 1;
    statements.push(env.CONTENT_DB.prepare(
      `UPDATE posts SET public_snapshot_id=?1,public_snapshot_key=?2,public_index_version=?3,last_public_write_id=?4
        WHERE id=?5 AND repository_id=?6 AND public_snapshot_id=?7 AND public_index_version=?8
          AND public_visible=1 AND deleted_at IS NULL`,
    ).bind(nextSnapshotId, nextObjectKey, nextVersion, publicWriteId, snapshot.post_id, repositoryId,
      snapshot.id, snapshot.public_index_version));
    if (plan) appendSnapshotRelations(env, statements, plan, nextVersion, publicWriteId, now);
    if (keyChanged) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT OR IGNORE INTO redirects (id,old_path,post_id,repository_id,created_at)
         SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (
           SELECT 1 FROM posts WHERE id=?3 AND public_snapshot_id=?6
             AND public_index_version=?7 AND last_public_write_id=?8
         )`,
      ).bind(crypto.randomUUID(), new URL(snapshot.canonical_url).pathname, snapshot.post_id, repositoryId, now,
        nextSnapshotId, nextVersion, publicWriteId));
    }
    const action = next.visibility === 'private' ? 'delete_public' : 'upsert_public';
    const payload = action === 'delete_public'
      ? JSON.stringify({ postId: snapshot.post_id, revision: nextVersion })
      : JSON.stringify(documents.get(snapshot.post_id));
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS (
         SELECT 1 FROM posts WHERE id=?4 AND public_snapshot_id=?6
           AND public_index_version=?9 AND last_public_write_id=?10
       )`,
    ).bind(crypto.randomUUID(), `public:repository:${snapshot.post_id}:${nextVersion}:${repositoryId}`, action,
      snapshot.post_id, repositoryId, nextSnapshotId, payload, now, nextVersion, publicWriteId));
  }
  statements.push(env.CONTENT_DB.prepare(
    `UPDATE repositories SET name=?1,url_key=?2,visibility=?3,updated_at=?4,last_write_id=?5
      WHERE id=?6 AND name=?7 AND url_key=?8 AND visibility=?9 AND updated_at=?10`,
  ).bind(next.name, next.key, next.visibility, now, repositoryWriteId, repositoryId,
    current.name, current.url_key, current.visibility, current.updated_at));
  appendOperationAssertion(env, statements, `${repositoryWriteId}:repository`, 1,
    'SELECT count(*) FROM repositories WHERE id=?3 AND last_write_id=?4', [repositoryId, repositoryWriteId]);
  if (snapshots.length) {
    appendOperationAssertion(env, statements, `${publicWriteId}:snapshots`, snapshots.length,
      'SELECT count(*) FROM posts WHERE repository_id=?3 AND last_public_write_id=?4', [repositoryId, publicWriteId]);
  }
  statements.push(env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id IN (?1,?2)')
    .bind(`${repositoryWriteId}:repository`, `${publicWriteId}:snapshots`));
  const writtenKeys: string[] = [];
  try {
    await writeRelocatedObjects(env, plans, writtenKeys);
    await env.CONTENT_DB.batch(statements);
  } catch (error) {
    await Promise.allSettled(writtenKeys.map((key) => env.BLOG_ARCHIVE.delete(key)));
    if (error instanceof Error && error.message.includes('UNIQUE')) throw new HttpError(409, '仓库 URL key 已存在', 'repository_key_conflict');
    if (error instanceof Error && error.message.includes('operation_assertions')) {
      throw new HttpError(409, '仓库在操作期间已变化，请刷新后重试', 'repository_revision_conflict');
    }
    throw error;
  }
  if (snapshots.length) ctx.waitUntil(processOutbox(env));
  return mapRepository({ ...current, name: next.name, url_key: next.key, visibility: next.visibility, updated_at: now });
}

export async function createCategory(env: Env, input: { repositoryId: string; parentId?: string | null; name: string }) {
  const repository = await env.CONTENT_DB.prepare(
    `SELECT id FROM repositories r WHERE id=?1
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  ).bind(input.repositoryId).first<{ id: string }>();
  if (!repository) throw new HttpError(400, '仓库不存在或正在删除', 'repository_not_found');
  if (input.parentId) {
    const parent = await env.CONTENT_DB.prepare('SELECT repository_id FROM categories WHERE id=?1').bind(input.parentId).first<{ repository_id: string }>();
    if (!parent || parent.repository_id !== input.repositoryId) throw new HttpError(400, '上级分类不属于当前仓库', 'invalid_parent_category');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await env.CONTENT_DB.prepare(
      'INSERT INTO categories (id,repository_id,parent_id,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)',
    ).bind(id, input.repositoryId, input.parentId ?? null, input.name, now).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) throw new HttpError(409, '同一位置已经有同名分类', 'category_name_conflict');
    throw error;
  }
  return { id, repositoryId: input.repositoryId, parentId: input.parentId ?? null, name: input.name, createdAt: now, updatedAt: now };
}

export async function updateCategory(env: Env, categoryId: string, input: { name?: string; parentId?: string | null }) {
  const current = await env.CONTENT_DB.prepare(
    `SELECT c.id,c.repository_id,c.parent_id,c.name,c.created_at,c.updated_at FROM categories c
      WHERE c.id=?1 AND NOT EXISTS (
        SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=c.repository_id AND j.completed_at IS NULL
      )`,
  ).bind(categoryId).first<{ id: string; repository_id: string; parent_id: string | null; name: string; created_at: string; updated_at: string }>();
  if (!current) throw new HttpError(404, '分类不存在', 'category_not_found');
  const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
  if (parentId === categoryId) throw new HttpError(400, '分类不能成为自己的上级', 'category_cycle');
  if (parentId) {
    const parent = await env.CONTENT_DB.prepare('SELECT repository_id FROM categories WHERE id=?1').bind(parentId).first<{ repository_id: string }>();
    if (!parent || parent.repository_id !== current.repository_id) throw new HttpError(400, '上级分类不属于当前仓库', 'invalid_parent_category');
    const ancestors = await env.CONTENT_DB.prepare(
      `WITH RECURSIVE chain(id,parent_id) AS (
         SELECT id,parent_id FROM categories WHERE id=?1 UNION ALL
         SELECT c.id,c.parent_id FROM categories c JOIN chain ON c.id=chain.parent_id
       ) SELECT id FROM chain`,
    ).bind(parentId).all<{ id: string }>();
    if (ancestors.results.some((row) => row.id === categoryId)) throw new HttpError(400, '移动会形成分类循环', 'category_cycle');
  }
  const now = new Date().toISOString();
  try {
    await env.CONTENT_DB.prepare('UPDATE categories SET name=?1,parent_id=?2,updated_at=?3 WHERE id=?4')
      .bind(input.name ?? current.name, parentId, now, categoryId).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) throw new HttpError(409, '同一位置已经有同名分类', 'category_name_conflict');
    throw error;
  }
  return { id: categoryId, repositoryId: current.repository_id, parentId, name: input.name ?? current.name, createdAt: current.created_at, updatedAt: now };
}

export async function deleteCategory(env: Env, categoryId: string): Promise<void> {
  const usage = await env.CONTENT_DB.prepare(
    `SELECT (SELECT count(*) FROM posts WHERE category_id=c.id AND deleted_at IS NULL) AS posts,
            (SELECT count(*) FROM categories WHERE parent_id=c.id) AS children
       FROM categories c WHERE c.id=?1 AND NOT EXISTS (
         SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=c.repository_id AND j.completed_at IS NULL
       )`,
  ).bind(categoryId).first<{ posts: number; children: number }>();
  if (!usage) throw new HttpError(404, '分类不存在', 'category_not_found');
  if (usage.posts || usage.children) throw new HttpError(409, '请先移动分类中的文章和子分类', 'category_not_empty');
  await env.CONTENT_DB.prepare('DELETE FROM categories WHERE id=?1').bind(categoryId).run();
}

export async function deletePostPermanently(env: Env, postId: string): Promise<void> {
  const post = await env.CONTENT_DB.prepare(
    'SELECT id,repository_id,revision,public_index_version,public_snapshot_id FROM posts WHERE id=?1 AND deleted_at IS NULL',
  ).bind(postId).first<{
    id: string; repository_id: string; revision: number; public_index_version: number; public_snapshot_id: string | null;
  }>();
  if (!post) throw new HttpError(404, '文章不存在', 'post_not_found');
  const [versions, snapshots, redirects] = await Promise.all([
    env.CONTENT_DB.prepare('SELECT object_key FROM post_versions WHERE post_id=?1').bind(postId).all<{ object_key: string }>(),
    env.CONTENT_DB.prepare('SELECT id,object_key,canonical_url FROM public_snapshots WHERE post_id=?1').bind(postId).all<{ id: string; object_key: string; canonical_url: string }>(),
    env.CONTENT_DB.prepare('SELECT old_path FROM redirects WHERE post_id=?1').bind(postId).all<{ old_path: string }>(),
  ]);
  const keys = [...versions.results.map((row) => row.object_key), ...snapshots.results.flatMap((row) => [row.object_key, `og/${row.id}.svg`])];
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const writeId = crypto.randomUUID();
  const authorRevision = post.revision + 1;
  const publicRevision = post.public_index_version + 1;
  const statements: D1PreparedStatement[] = [
    env.CONTENT_DB.prepare(
      `UPDATE posts SET deleted_at=?1,status='withdrawn',public_visible=0,public_index_version=?2,
              last_public_write_id=?3,last_write_id=?3
        WHERE id=?4 AND revision=?5 AND public_index_version=?6 AND deleted_at IS NULL`,
    ).bind(now, publicRevision, writeId, postId, post.revision, post.public_index_version),
    env.CONTENT_DB.prepare(
      'INSERT INTO deletion_jobs (id,kind,target_id,object_keys_json,created_at) VALUES (?1,\'post\',?2,?3,?4)',
    ).bind(jobId, postId, JSON.stringify(keys), now),
    env.CONTENT_DB.prepare(
      `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,payload_json,created_at)
       SELECT ?1,?2,'delete_author',?3,?4,?5,?6 WHERE EXISTS (
         SELECT 1 FROM posts WHERE id=?3 AND deleted_at=?6 AND last_write_id=?7
       )`,
    ).bind(crypto.randomUUID(), `author:delete:${postId}:${authorRevision}`, postId, post.repository_id,
      JSON.stringify({ postId, revision: authorRevision }), now, writeId),
    env.CONTENT_DB.prepare(
      `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
       SELECT ?1,?2,'delete_public',?3,?4,?5,?6,?7 WHERE EXISTS (
         SELECT 1 FROM posts WHERE id=?3 AND deleted_at=?7 AND public_index_version=?8 AND last_public_write_id=?9
       )`,
    ).bind(crypto.randomUUID(), `public:delete:${postId}:${publicRevision}`, postId, post.repository_id,
      post.public_snapshot_id, JSON.stringify({ postId, revision: publicRevision }), now, publicRevision, writeId),
    env.CONTENT_DB.prepare(
      `INSERT INTO operation_assertions (id,expected,actual)
       SELECT ?1,1,(SELECT count(*) FROM posts WHERE id=?2 AND deleted_at=?3 AND last_write_id=?1)`,
    ).bind(writeId, postId, now),
    env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id=?1').bind(writeId),
  ];
  if (snapshots.results.length) statements.push(env.CONTENT_DB.prepare(
    `INSERT OR REPLACE INTO deleted_urls (path,deleted_at,former_post_id)
     SELECT CASE WHEN canonical_url LIKE (?1 || '/%') THEN substr(canonical_url,length(?1)+1) ELSE canonical_url END,?2,?3
       FROM public_snapshots WHERE post_id=?3`,
  ).bind(env.SITE_ORIGIN, now, postId));
  if (redirects.results.length) statements.push(env.CONTENT_DB.prepare(
    `INSERT OR REPLACE INTO deleted_urls (path,deleted_at,former_post_id)
     SELECT old_path,?1,?2 FROM redirects WHERE post_id=?2`,
  ).bind(now, postId));
  await env.CONTENT_DB.batch(statements);
  await processOutbox(env);
  await processDeletionJob(env, jobId);
}

export async function processDeletionJob(env: Env, jobId: string): Promise<void> {
  const job = await env.CONTENT_DB.prepare(
    'SELECT kind,target_id,object_keys_json FROM deletion_jobs WHERE id=?1 AND completed_at IS NULL',
  ).bind(jobId).first<{ kind: 'post' | 'repository'; target_id: string; object_keys_json: string }>();
  if (!job) return;
  try {
    const keys = JSON.parse(job.object_keys_json) as string[];
    for (let offset = 0; offset < keys.length; offset += 1000) await env.BLOG_ARCHIVE.delete(keys.slice(offset, offset + 1000));
    const statements: D1PreparedStatement[] = [];
    const finalGuardId = `${jobId}:final`;
    if (job.kind === 'post') {
      appendOperationAssertion(env, statements, finalGuardId, 0,
        'SELECT count(*) FROM posts WHERE id=?3 AND deleted_at IS NULL', [job.target_id]);
      statements.push(env.CONTENT_DB.prepare('DELETE FROM posts WHERE id=?1 AND deleted_at IS NOT NULL').bind(job.target_id));
    } else {
      appendOperationAssertion(env, statements, finalGuardId, 0,
        'SELECT count(*) FROM posts WHERE repository_id=?3 AND deleted_at IS NULL', [job.target_id]);
      statements.push(
        env.CONTENT_DB.prepare('DELETE FROM posts WHERE repository_id=?1 AND deleted_at IS NOT NULL').bind(job.target_id),
        env.CONTENT_DB.prepare('UPDATE categories SET parent_id=NULL WHERE repository_id=?1').bind(job.target_id),
        env.CONTENT_DB.prepare('DELETE FROM repositories WHERE id=?1').bind(job.target_id),
      );
    }
    statements.push(env.CONTENT_DB.prepare(
      'UPDATE deletion_jobs SET completed_at=?1,attempts=attempts+1,last_error=NULL WHERE id=?2',
    ).bind(new Date().toISOString(), jobId));
    statements.push(env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id=?1').bind(finalGuardId));
    await env.CONTENT_DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.CONTENT_DB.prepare('UPDATE deletion_jobs SET attempts=attempts+1,last_error=?1 WHERE id=?2')
      .bind(message.slice(0, 500), jobId).run();
    throw error;
  }
}

export async function retryDeletionJobs(env: Env): Promise<void> {
  const pending = await env.CONTENT_DB.prepare('SELECT id FROM deletion_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 20').all<{ id: string }>();
  for (const job of pending.results) {
    try { await processDeletionJob(env, job.id); } catch { /* 下次 Cron 继续重试。 */ }
  }
}

export async function deleteRepository(env: Env, ctx: ExecutionContext, repositoryId: string, mode: { action: 'move'; targetRepositoryId: string } | { action: 'delete' }): Promise<void> {
  const pendingDeletion = await env.CONTENT_DB.prepare(
    `SELECT id FROM deletion_jobs WHERE kind='repository' AND target_id=?1 AND completed_at IS NULL ORDER BY created_at LIMIT 1`,
  ).bind(repositoryId).first<{ id: string }>();
  if (pendingDeletion) {
    await processOutbox(env);
    await processDeletionJob(env, pendingDeletion.id);
    return;
  }
  const source = await env.CONTENT_DB.prepare(
    'SELECT id,name,url_key,visibility,created_at,updated_at FROM repositories WHERE id=?1',
  ).bind(repositoryId).first<RepositoryRow>();
  if (!source) throw new HttpError(404, '仓库不存在', 'repository_not_found');
  if (mode.action === 'move') {
    if (mode.targetRepositoryId === repositoryId) throw new HttpError(400, '目标仓库不能是当前仓库', 'invalid_target_repository');
    const target = await env.CONTENT_DB.prepare(
      `SELECT id,name,url_key,visibility,created_at,updated_at FROM repositories r WHERE id=?1
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
    ).bind(mode.targetRepositoryId).first<RepositoryRow>();
    if (!target) throw new HttpError(400, '目标仓库不存在', 'repository_not_found');
    const conflicts = await env.CONTENT_DB.prepare(
      `SELECT source.slug FROM posts source JOIN posts existing ON existing.repository_id=?1 AND existing.slug=source.slug
       WHERE source.repository_id=?2 AND source.deleted_at IS NULL AND existing.deleted_at IS NULL LIMIT 20`,
    ).bind(target.id, repositoryId).all<{ slug: string }>();
    if (conflicts.results.length) {
      throw new HttpError(409, `目标仓库已有相同 slug：${conflicts.results.map((row) => row.slug).join(', ')}`, 'repository_move_slug_conflict');
    }
    const posts = await env.CONTENT_DB.prepare(
      `SELECT id,revision,public_index_version,title,summary,markdown,custom_properties_json,public_visible,public_snapshot_id
         FROM posts WHERE repository_id=?1 AND deleted_at IS NULL`,
    ).bind(repositoryId).all<{
      id: string; revision: number; public_index_version: number; title: string; summary: string | null; markdown: string; custom_properties_json: string;
      public_visible: number; public_snapshot_id: string | null;
    }>();
    const snapshots = await loadCurrentPublicSnapshots(env, repositoryId);
    const visiblePosts = posts.results.filter((post) => post.public_visible === 1);
    if (visiblePosts.length !== snapshots.length) {
      throw new HttpError(409, '仓库中存在公开指针不完整的文章，请先运行一致性修复', 'public_snapshot_pointer_invalid');
    }
    const plans = await Promise.all(snapshots.map((snapshot) => prepareRelocatedSnapshot(
      env, snapshot, target.id, target.url_key, null,
    )));
    const planByPost = new Map(plans.map((plan) => [plan.source.post_id, plan]));
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const repositoryWriteId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    statements.push(env.CONTENT_DB.prepare(
      `UPDATE repositories SET last_write_id=?1 WHERE id=?2 AND name=?3 AND url_key=?4 AND visibility=?5 AND updated_at=?6`,
    ).bind(repositoryWriteId, source.id, source.name, source.url_key, source.visibility, source.updated_at));
    appendOperationAssertion(env, statements, `${repositoryWriteId}:source`, 1,
      'SELECT count(*) FROM repositories WHERE id=?3 AND last_write_id=?4', [source.id, repositoryWriteId]);
    statements.push(env.CONTENT_DB.prepare(
      `UPDATE repositories SET last_write_id=?1 WHERE id=?2 AND name=?3 AND url_key=?4 AND visibility=?5 AND updated_at=?6`,
    ).bind(repositoryWriteId, target.id, target.name, target.url_key, target.visibility, target.updated_at));
    appendOperationAssertion(env, statements, `${repositoryWriteId}:target`, 1,
      'SELECT count(*) FROM repositories WHERE id=?3 AND last_write_id=?4', [target.id, repositoryWriteId]);
    statements.push(env.CONTENT_DB.prepare('UPDATE redirects SET repository_id=?1 WHERE repository_id=?2')
      .bind(target.id, source.id));
    for (const oldPath of [`/${source.url_key}`, `/${source.url_key}/`]) {
      statements.push(env.CONTENT_DB.prepare(
        'INSERT OR IGNORE INTO redirects (id,old_path,post_id,repository_id,created_at) VALUES (?1,?2,NULL,?3,?4)',
      ).bind(crypto.randomUUID(), oldPath, target.id, now));
    }
    for (const post of posts.results) {
      const revision = post.revision + 1;
      const plan = planByPost.get(post.id);
      const publicIndexVersion = plan ? post.public_index_version + 1 : post.public_index_version;
      if (plan) appendSnapshotInsert(env, statements, plan, now);
      const tags = await env.CONTENT_DB.prepare('SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=?1 ORDER BY t.name')
        .bind(post.id).all<{ name: string }>();
      const rendered = await renderMarkdown(post.markdown);
      const authorDocument: SearchDocument = {
        postId: post.id, repositoryId: target.id, revision, title: post.title,
        taxonomy: tags.results.map((row) => row.name).join(' '), summary: post.summary ?? '', body: rendered.text,
        properties: post.custom_properties_json, displayText: rendered.text,
      };
      statements.push(env.CONTENT_DB.prepare(
        `UPDATE posts SET repository_id=?1,category_id=NULL,revision=?2,updated_at=?3,last_write_id=?4,
                public_snapshot_id=CASE WHEN ?5=1 THEN ?6 ELSE public_snapshot_id END,
                public_snapshot_key=CASE WHEN ?5=1 THEN ?7 ELSE public_snapshot_key END,
                public_index_version=?8,
                last_public_write_id=CASE WHEN ?5=1 THEN ?4 ELSE last_public_write_id END
          WHERE id=?9 AND repository_id=?10 AND revision=?11 AND public_index_version=?12
            AND public_snapshot_id IS ?13 AND deleted_at IS NULL`,
      ).bind(target.id, revision, now, operationId, plan ? 1 : 0, plan?.id ?? null, plan?.objectKey ?? null,
        publicIndexVersion, post.id, source.id, post.revision, post.public_index_version, post.public_snapshot_id));
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,payload_json,created_at)
         SELECT ?1,?2,'upsert_author',?3,?4,?5,?6
          WHERE EXISTS (SELECT 1 FROM posts WHERE id=?3 AND revision=?7 AND last_write_id=?8)`,
      ).bind(crypto.randomUUID(), `author:${post.id}:${revision}`, post.id, target.id, JSON.stringify(authorDocument), now, revision, operationId));
      if (!plan) continue;
      appendSnapshotRelations(env, statements, plan, publicIndexVersion, operationId, now);
      statements.push(env.CONTENT_DB.prepare(
        `INSERT OR IGNORE INTO redirects (id,old_path,post_id,repository_id,created_at)
         SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (
           SELECT 1 FROM posts WHERE id=?3 AND revision=?6 AND public_snapshot_id=?7
             AND public_index_version=?8 AND last_public_write_id=?9
         )`,
      ).bind(crypto.randomUUID(), new URL(plan.source.canonical_url).pathname, post.id, target.id, now, revision,
        plan.id, publicIndexVersion, operationId));
      const action = target.visibility === 'private' ? 'delete_public' : 'upsert_public';
      const payload = action === 'delete_public'
        ? JSON.stringify({ postId: post.id, revision: publicIndexVersion })
        : JSON.stringify(plan.publicDocument);
      statements.push(env.CONTENT_DB.prepare(
        `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS (
           SELECT 1 FROM posts WHERE id=?4 AND public_snapshot_id=?6
             AND public_index_version=?9 AND last_public_write_id=?10
         )`,
      ).bind(crypto.randomUUID(), `public:move:${post.id}:${publicIndexVersion}:${target.id}`, action, post.id,
        target.id, plan.id, payload, now, publicIndexVersion, operationId));
    }
    appendOperationAssertion(env, statements, `${operationId}:posts`, posts.results.length,
      'SELECT count(*) FROM posts WHERE repository_id=?3 AND last_write_id=?4', [target.id, operationId]);
    statements.push(env.CONTENT_DB.prepare('DELETE FROM repositories WHERE id=?1 AND last_write_id=?2')
      .bind(source.id, repositoryWriteId));
    statements.push(env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id IN (?1,?2,?3)')
      .bind(`${repositoryWriteId}:source`, `${repositoryWriteId}:target`, `${operationId}:posts`));
    const writtenKeys: string[] = [];
    try {
      await writeRelocatedObjects(env, plans, writtenKeys);
      await env.CONTENT_DB.batch(statements);
    } catch (error) {
      await Promise.allSettled(writtenKeys.map((key) => env.BLOG_ARCHIVE.delete(key)));
      if (error instanceof Error && error.message.includes('operation_assertions')) {
        throw new HttpError(409, '仓库或文章在迁移期间已变化，请刷新后重试', 'repository_revision_conflict');
      }
      throw error;
    }
    ctx.waitUntil(processOutbox(env));
    return;
  } else {
    const [posts, totalPosts, versions, snapshots] = await Promise.all([
      env.CONTENT_DB.prepare(
        `SELECT id,revision,public_index_version,public_snapshot_id FROM posts
          WHERE repository_id=?1 AND deleted_at IS NULL ORDER BY id`,
      ).bind(repositoryId).all<{
        id: string; revision: number; public_index_version: number; public_snapshot_id: string | null;
      }>(),
      env.CONTENT_DB.prepare('SELECT count(*) AS count FROM posts WHERE repository_id=?1')
        .bind(repositoryId).first<{ count: number }>(),
      env.CONTENT_DB.prepare(
        `SELECT v.object_key FROM post_versions v JOIN posts p ON p.id=v.post_id WHERE p.repository_id=?1`,
      ).bind(repositoryId).all<{ object_key: string }>(),
      env.CONTENT_DB.prepare(
        `SELECT s.id,s.object_key FROM public_snapshots s JOIN posts p ON p.id=s.post_id WHERE p.repository_id=?1`,
      ).bind(repositoryId).all<{ id: string; object_key: string }>(),
    ]);
    const keys = [...new Set([
      ...versions.results.map((row) => row.object_key),
      ...snapshots.results.flatMap((row) => [row.object_key, `og/${row.id}.svg`]),
    ])];
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const writeId = crypto.randomUUID();
    const repositoryWriteId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    for (const post of posts.results) {
      const authorRevision = post.revision + 1;
      const publicRevision = post.public_index_version + 1;
      statements.push(
        env.CONTENT_DB.prepare(
          `UPDATE posts SET deleted_at=?1,status='withdrawn',public_visible=0,public_index_version=?2,
                  last_public_write_id=?3,last_write_id=?3
            WHERE id=?4 AND repository_id=?5 AND revision=?6 AND public_index_version=?7 AND deleted_at IS NULL`,
        ).bind(now, publicRevision, writeId, post.id, repositoryId, post.revision, post.public_index_version),
        env.CONTENT_DB.prepare(
          `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,payload_json,created_at)
           SELECT ?1,?2,'delete_author',?3,?4,?5,?6 WHERE EXISTS (
             SELECT 1 FROM posts WHERE id=?3 AND deleted_at=?6 AND last_write_id=?7
           )`,
        ).bind(crypto.randomUUID(), `author:repository-delete:${post.id}:${authorRevision}`, post.id, repositoryId,
          JSON.stringify({ postId: post.id, revision: authorRevision }), now, writeId),
        env.CONTENT_DB.prepare(
          `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
           SELECT ?1,?2,'delete_public',?3,?4,?5,?6,?7 WHERE EXISTS (
             SELECT 1 FROM posts WHERE id=?3 AND deleted_at=?7 AND public_index_version=?8 AND last_public_write_id=?9
           )`,
        ).bind(crypto.randomUUID(), `public:repository-delete:${post.id}:${publicRevision}`, post.id, repositoryId,
          post.public_snapshot_id, JSON.stringify({ postId: post.id, revision: publicRevision }), now, publicRevision, writeId),
      );
    }
    statements.push(env.CONTENT_DB.prepare(
      `UPDATE repositories SET visibility='private',updated_at=?1,last_write_id=?2
        WHERE id=?3 AND name=?4 AND url_key=?5 AND visibility=?6 AND updated_at=?7`,
    ).bind(now, repositoryWriteId, source.id, source.name, source.url_key, source.visibility, source.updated_at));
    appendOperationAssertion(env, statements, `${repositoryWriteId}:repository`, 1,
      'SELECT count(*) FROM repositories WHERE id=?3 AND last_write_id=?4', [repositoryId, repositoryWriteId]);
    appendOperationAssertion(env, statements, `${writeId}:active-posts`, posts.results.length,
      'SELECT count(*) FROM posts WHERE repository_id=?3 AND deleted_at=?4 AND last_write_id=?5',
      [repositoryId, now, writeId]);
    appendOperationAssertion(env, statements, `${writeId}:all-posts`, totalPosts?.count ?? 0,
      'SELECT count(*) FROM posts WHERE repository_id=?3', [repositoryId]);
    statements.push(
      env.CONTENT_DB.prepare(
        `INSERT OR REPLACE INTO deleted_urls (path,deleted_at,former_post_id)
         SELECT CASE WHEN s.canonical_url LIKE (?1 || '/%') THEN substr(s.canonical_url,length(?1)+1) ELSE s.canonical_url END,
                ?2,s.post_id
           FROM public_snapshots s JOIN posts p ON p.id=s.post_id WHERE p.repository_id=?3`,
      ).bind(env.SITE_ORIGIN, now, repositoryId),
      env.CONTENT_DB.prepare(
        `INSERT OR REPLACE INTO deleted_urls (path,deleted_at,former_post_id)
         SELECT d.old_path,?1,COALESCE(d.post_id,?2) FROM redirects d WHERE d.repository_id=?2`,
      ).bind(now, repositoryId),
      env.CONTENT_DB.prepare(
        `INSERT OR REPLACE INTO deleted_urls (path,deleted_at,former_post_id)
         SELECT ?1,?2,?3 UNION ALL SELECT ?4,?2,?3`,
      ).bind(`/${source.url_key}`, now, repositoryId, `/${source.url_key}/`),
      env.CONTENT_DB.prepare(
        `INSERT INTO deletion_jobs (id,kind,target_id,object_keys_json,created_at)
         VALUES (?1,'repository',?2,?3,?4)`,
      ).bind(jobId, repositoryId, JSON.stringify(keys), now),
      env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id IN (?1,?2,?3)')
        .bind(`${repositoryWriteId}:repository`, `${writeId}:active-posts`, `${writeId}:all-posts`),
    );
    try {
      await env.CONTENT_DB.batch(statements);
    } catch (error) {
      if (error instanceof Error && error.message.includes('operation_assertions')) {
        throw new HttpError(409, '仓库或文章在删除期间已变化，请刷新后重试', 'repository_revision_conflict');
      }
      throw error;
    }
    await processOutbox(env);
    await processDeletionJob(env, jobId);
    return;
  }
}
