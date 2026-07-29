import yaml from 'js-yaml';
import type { PostDetail } from '../shared/types';
import { getManagePost } from './data';
import { sha256Hex, toBase64Url } from './crypto';
import { HttpError } from './http';
import { extractLinks, extractWikiTargets, renderMarkdown } from './markdown';
import { resolveLinkTargets, resolveWikiTargets } from './linking';
import { processOutbox, type SearchDocument } from './search';

export interface ImportFile { path: string; content: string }
export interface ImportAttachment { path: string; assetId?: string }
export interface ImportPreviewInput {
  repositoryId: string;
  categoryId?: string | null;
  files: ImportFile[];
  attachments: ImportAttachment[];
}
export interface PublishedTimeCandidate {
  field: 'date' | 'published';
  raw: string;
  parsedAt: string | null;
  timezone: string | null;
  issue: string | null;
}
export interface ImportItem {
  key: string;
  path: string;
  directory: string;
  title: string;
  slug: string;
  language: string;
  summary: string | null;
  tags: string[];
  coverAssetId: string | null;
  customProperties: Record<string, unknown>;
  markdown: string;
  missingAttachments: string[];
  resolvedAttachments: Record<string, string>;
  duplicateCandidates: Array<{ postId: string; title: string; reason: string }>;
  attachmentMatches: Record<string, string>;
  exportedPostId: string | null;
  exportSignature: string | null;
  exportedPostIdVerified: boolean;
  publishedTimeCandidate: PublishedTimeCandidate | null;
  slugConflict: boolean;
}
export interface AttachmentConflict {
  normalizedPath: string;
  paths: string[];
  reason: 'case_collision' | 'duplicate_path';
}
export interface ImportPreview {
  items: ImportItem[];
  ignored: string[];
  unreferencedAttachments: string[];
  attachmentConflicts: AttachmentConflict[];
}

interface CommitItem extends ImportItem {
  action: 'new' | 'update' | 'skip';
  targetPostId?: string;
  preserveFirstPublishedAt?: string | null;
}

interface CurrentImportPost {
  id: string;
  revision: number;
  markdown: string;
}

interface PlannedCategory {
  id: string;
  repositoryId: string;
  parentId: string | null;
  name: string;
}

interface VersionPlan {
  id: string;
  postId: string;
  revision: number;
  objectKey: string;
  checksum: string;
  payload: string;
  metadata: Record<string, unknown>;
}

interface PreparedItem {
  item: CommitItem;
  id: string;
  current: CurrentImportPost | null;
  revision: number;
  categoryId: string | null;
  markdown: string;
  firstPublishedAt: string | null;
}

const encoder = new TextEncoder();
const exportContext = 'ysoseri-blog-export:v1';

function normalizePath(value: string): string {
  const normalized = value.normalize('NFKC').replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter((part) => part && part !== '.');
  if (normalized.some((part) => part === '..')) throw new HttpError(400, '导入路径不能越出导入包', 'import_path_escape');
  return normalized.join('/');
}

function decodeReference(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content };
  const parsed = yaml.load(match[1] ?? '', { schema: yaml.JSON_SCHEMA });
  return {
    data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
    body: content.slice(match[0].length),
  };
}

function slugify(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/[\s-]+/g, '-').slice(0, 90) || `imported-${crypto.randomUUID().slice(0, 8)}`;
}

function titleFrom(path: string, body: string, data: Record<string, unknown>): string {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.split('/').at(-1)?.replace(/\.md$/i, '') || '未命名';
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function localReferences(markdown: string): string[] {
  const references = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((?!https?:|media:)([^)]+)\)|!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const value = (match[1] ?? match[2])?.trim();
    if (value) references.add(value);
  }
  return [...references];
}

function referencePath(reference: string, sourcePath: string): string | null {
  const decoded = decodeReference(reference).normalize('NFKC');
  const sourceDirectory = sourcePath.split('/').slice(0, -1);
  const parts = [...sourceDirectory, ...decoded.replaceAll('\\', '/').split('/')];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else resolved.push(part);
  }
  return resolved.join('/');
}

function resolveAttachment(
  reference: string,
  sourcePath: string,
  attachments: Map<string, string>,
  conflictedPaths: Set<string>,
): { path: string; assetId: string } | null {
  const exactPath = referencePath(reference, sourcePath);
  if (!exactPath || conflictedPaths.has(exactPath.toLocaleLowerCase())) return null;
  if (attachments.has(exactPath)) return { path: exactPath, assetId: attachments.get(exactPath) ?? '' };
  const pathCandidates = [...attachments].filter(([path]) => path.toLocaleLowerCase() === exactPath.toLocaleLowerCase());
  if (pathCandidates.length === 1 && pathCandidates[0]) return { path: pathCandidates[0][0], assetId: pathCandidates[0][1] };
  const basename = decodeReference(reference).split(/[\\/]/).at(-1)?.toLocaleLowerCase();
  const candidates = [...attachments].filter(([path]) => path.split('/').at(-1)?.toLocaleLowerCase() === basename
    && !conflictedPaths.has(path.toLocaleLowerCase()));
  return candidates.length === 1 && candidates[0] ? { path: candidates[0][0], assetId: candidates[0][1] } : null;
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

async function exportKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(env.IMPORT_EXPORT_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signExportId(env: Env, postId: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await exportKey(env), encoder.encode(`${exportContext}:${postId}`))));
}

async function verifyExportId(env: Env, postId: string, signature: string): Promise<boolean> {
  const decoded = fromBase64Url(signature);
  if (!decoded) return false;
  return crypto.subtle.verify('HMAC', await exportKey(env), decoded, encoder.encode(`${exportContext}:${postId}`));
}

function publishedCandidate(data: Record<string, unknown>): PublishedTimeCandidate | null {
  const selected = typeof data.date === 'string'
    ? { field: 'date' as const, raw: data.date.trim() }
    : typeof data.published === 'string' ? { field: 'published' as const, raw: data.published.trim() } : null;
  if (!selected?.raw) return null;
  const timezoneMatch = selected.raw.match(/(Z|[+-]\d{2}:?\d{2})$/i);
  if (!timezoneMatch) return { ...selected, parsedAt: null, timezone: null, issue: '时间没有明确时区，请补充带偏移的 ISO 8601 时间' };
  const parsed = new Date(selected.raw);
  if (Number.isNaN(parsed.getTime())) return { ...selected, parsedAt: null, timezone: null, issue: '时间格式无法解析' };
  const suffix = timezoneMatch[1]?.toUpperCase() ?? 'Z';
  const timezone = suffix === 'Z' ? 'UTC' : `UTC${suffix.includes(':') ? suffix : `${suffix.slice(0, 3)}:${suffix.slice(3)}`}`;
  return { ...selected, parsedAt: parsed.toISOString(), timezone, issue: null };
}

function attachmentInventory(input: ImportAttachment[]): {
  map: Map<string, string>;
  conflicts: AttachmentConflict[];
  conflictedPaths: Set<string>;
} {
  const map = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const item of input) {
    const path = normalizePath(item.path);
    map.set(path, item.assetId ?? '');
    const folded = path.toLocaleLowerCase();
    groups.set(folded, [...(groups.get(folded) ?? []), path]);
  }
  const conflicts: AttachmentConflict[] = [];
  const conflictedPaths = new Set<string>();
  for (const [folded, paths] of groups) {
    if (paths.length < 2) continue;
    conflictedPaths.add(folded);
    conflicts.push({
      normalizedPath: folded,
      paths,
      reason: new Set(paths).size === 1 ? 'duplicate_path' : 'case_collision',
    });
  }
  return { map, conflicts, conflictedPaths };
}

export async function previewImport(env: Env, input: ImportPreviewInput): Promise<ImportPreview> {
  if (input.files.length > 100) throw new HttpError(400, '标准导入一次最多 100 篇文章', 'import_too_many_files');
  const repository = await env.CONTENT_DB.prepare(
    `SELECT id FROM repositories r WHERE id=?1
       AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
  ).bind(input.repositoryId).first<{ id: string }>();
  if (!repository) throw new HttpError(400, '目标仓库不存在', 'repository_not_found');
  if (input.categoryId) {
    const category = await env.CONTENT_DB.prepare('SELECT repository_id FROM categories WHERE id=?1').bind(input.categoryId)
      .first<{ repository_id: string }>();
    if (!category || category.repository_id !== input.repositoryId) throw new HttpError(400, '目标分类不属于目标仓库', 'invalid_category');
  }
  const ignored: string[] = [];
  const files = input.files.map((file) => ({ ...file, path: normalizePath(file.path) })).filter((file) => {
    const internal = file.path.split('/').some((part) => part === '.obsidian');
    if (internal) ignored.push(file.path);
    return !internal && /\.md$/i.test(file.path);
  });
  const inventory = attachmentInventory(input.attachments);
  const used = new Set<string>();
  const items: ImportItem[] = [];
  const seenSlugs = new Set<string>();
  for (const file of files) {
    const { data, body } = parseFrontmatter(file.content);
    const title = titleFrom(file.path, body, data);
    const tags = stringArray(data.tags);
    const known = new Set([
      'title', 'tags', 'summary', 'description', 'language', 'slug', 'cover', 'ysoseri_post_id',
      'ysoseri_export_signature', 'id', 'revision', 'status', 'draft', 'published', 'date',
    ]);
    const customProperties = Object.fromEntries(Object.entries(data).filter(([key]) => !known.has(key)));
    const resolvedAttachments: Record<string, string> = {};
    const attachmentMatches: Record<string, string> = {};
    const missingAttachments: string[] = [];
    for (const reference of localReferences(body)) {
      const match = resolveAttachment(reference, file.path, inventory.map, inventory.conflictedPaths);
      if (match) {
        attachmentMatches[reference] = match.path;
        used.add(match.path);
        if (match.assetId) resolvedAttachments[reference] = match.assetId;
      } else missingAttachments.push(reference);
    }
    const exportedPostId = typeof data.ysoseri_post_id === 'string' ? data.ysoseri_post_id : null;
    const exportSignature = typeof data.ysoseri_export_signature === 'string' ? data.ysoseri_export_signature : null;
    const exportedPostIdVerified = Boolean(exportedPostId && exportSignature
      && await verifyExportId(env, exportedPostId, exportSignature));
    const duplicateCandidates: Array<{ postId: string; title: string; reason: string }> = [];
    if (exportedPostId) {
      const declared = await env.CONTENT_DB.prepare('SELECT id,title FROM posts WHERE id=?1 AND deleted_at IS NULL')
        .bind(exportedPostId).first<{ id: string; title: string }>();
      if (declared) duplicateCandidates.push({
        postId: declared.id,
        title: declared.title,
        reason: exportedPostIdVerified ? '本站导出签名已验证' : '本站 ID 签名无效，仅作候选',
      });
    }
    const identical = await env.CONTENT_DB.prepare(
      'SELECT id,title FROM posts WHERE repository_id=?1 AND markdown=?2 AND deleted_at IS NULL LIMIT 5',
    ).bind(input.repositoryId, body).all<{ id: string; title: string }>();
    for (const candidate of identical.results) {
      if (!duplicateCandidates.some((item) => item.postId === candidate.id)) {
        duplicateCandidates.push({ postId: candidate.id, title: candidate.title, reason: '内容完全相同' });
      }
    }
    const candidates = await env.CONTENT_DB.prepare(
      'SELECT id,title FROM posts WHERE repository_id=?1 AND title=?2 AND deleted_at IS NULL LIMIT 5',
    ).bind(input.repositoryId, title).all<{ id: string; title: string }>();
    for (const candidate of candidates.results) {
      if (!duplicateCandidates.some((item) => item.postId === candidate.id)) {
        duplicateCandidates.push({ postId: candidate.id, title: candidate.title, reason: '标题相同，仅作候选' });
      }
    }
    const slug = typeof data.slug === 'string' ? slugify(data.slug) : slugify(title);
    const existingSlug = await env.CONTENT_DB.prepare(
      'SELECT id FROM posts WHERE repository_id=?1 AND slug=?2 AND deleted_at IS NULL LIMIT 1',
    ).bind(input.repositoryId, slug).first<{ id: string }>();
    const slugConflict = seenSlugs.has(slug) || Boolean(existingSlug);
    seenSlugs.add(slug);
    items.push({
      key: crypto.randomUUID(), path: file.path, directory: file.path.split('/').slice(0, -1).join('/'),
      title, slug, language: typeof data.language === 'string' ? data.language : 'zh-CN',
      summary: typeof data.summary === 'string' ? data.summary : typeof data.description === 'string' ? data.description : null,
      tags, coverAssetId: typeof data.cover === 'string' && data.cover.startsWith('media://') ? data.cover.slice(8) : null,
      customProperties, markdown: body, missingAttachments, resolvedAttachments, attachmentMatches,
      duplicateCandidates, exportedPostId, exportSignature, exportedPostIdVerified,
      publishedTimeCandidate: publishedCandidate(data), slugConflict,
    });
  }
  return {
    items,
    ignored,
    unreferencedAttachments: [...inventory.map.keys()].filter((path) => !used.has(path)),
    attachmentConflicts: inventory.conflicts,
  };
}

function rewriteAttachments(markdown: string, resolved: Record<string, string>): string {
  let output = markdown;
  for (const [reference, assetId] of Object.entries(resolved)) {
    output = output.replaceAll(`](${reference})`, `](media://${assetId})`).replaceAll(`![[${reference}]]`, `![](media://${assetId})`);
  }
  return output;
}

function mediaIds(markdown: string): string[] {
  const ids = [
    ...[...markdown.matchAll(/media:\/\/([0-9a-f-]{36})/gi)].map((match) => match[1]),
    ...[...markdown.matchAll(/\/api\/public\/media\/([0-9a-f-]{36})/gi)].map((match) => match[1]),
  ];
  return [...new Set(ids.map((id) => id?.toLowerCase()).filter((id): id is string => Boolean(id)))];
}

function normalizeConfirmedTime(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new HttpError(400, '首次发布时间必须包含明确时区', 'import_time_timezone_required');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, '首次发布时间无法解析', 'import_time_invalid');
  return parsed.toISOString();
}

async function discardImportBatchMedia(env: Env, batchId: string): Promise<void> {
  const assets = await env.CONTENT_DB.prepare(
    `SELECT id,object_key FROM media_assets m WHERE import_batch_id=?1
      AND NOT EXISTS (SELECT 1 FROM post_media WHERE asset_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM public_snapshot_media WHERE asset_id=m.id)`,
  ).bind(batchId).all<{ id: string; object_key: string }>();
  for (const asset of assets.results) {
    await env.SITE_MEDIA.delete(asset.object_key);
    await env.CONTENT_DB.prepare(
      `DELETE FROM media_assets WHERE id=?1 AND import_batch_id=?2
        AND NOT EXISTS (SELECT 1 FROM post_media WHERE asset_id=?1)
        AND NOT EXISTS (SELECT 1 FROM public_snapshot_media WHERE asset_id=?1)`,
    ).bind(asset.id, batchId).run();
  }
}

export async function cleanupAbandonedImportMedia(env: Env): Promise<void> {
  const batches = await env.CONTENT_DB.prepare(
    `SELECT DISTINCT import_batch_id FROM media_assets
      WHERE import_batch_id IS NOT NULL AND created_at<?1 LIMIT 20`,
  ).bind(new Date(Date.now() - 24 * 60 * 60_000).toISOString()).all<{ import_batch_id: string }>();
  for (const batch of batches.results) await discardImportBatchMedia(env, batch.import_batch_id);
}

function versionPlan(postId: string, revision: number, markdown: string, sourcePath: string, phase: 'before' | 'created', now: string): Promise<VersionPlan> {
  const metadata = { sourcePath, phase };
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ postId, revision, markdown, kind: 'import', createdAt: now, metadata });
  return sha256Hex(payload).then((checksum) => ({
    id, postId, revision, payload, checksum, metadata,
    objectKey: `versions/${postId}/${now.replaceAll(':', '-')}-${revision}-${id.slice(0, 8)}-${checksum.slice(0, 12)}.json`,
  }));
}

async function planCategories(
  env: Env,
  repositoryId: string,
  baseCategoryId: string | null,
  directories: string[],
): Promise<{ ids: Map<string, string | null>; planned: PlannedCategory[] }> {
  if (baseCategoryId) {
    const base = await env.CONTENT_DB.prepare('SELECT repository_id FROM categories WHERE id=?1').bind(baseCategoryId)
      .first<{ repository_id: string }>();
    if (!base || base.repository_id !== repositoryId) throw new HttpError(400, '目标分类不属于目标仓库', 'invalid_category');
  }
  const existing = await env.CONTENT_DB.prepare(
    'SELECT id,parent_id,name FROM categories WHERE repository_id=?1',
  ).bind(repositoryId).all<{ id: string; parent_id: string | null; name: string }>();
  const byLocation = new Map(existing.results.map((category) => [`${category.parent_id ?? 'root'}\u0000${category.name}`, category.id]));
  const ids = new Map<string, string | null>();
  const planned: PlannedCategory[] = [];
  for (const directory of directories) {
    let parent = baseCategoryId;
    let accumulated = '';
    for (const name of directory.split('/').filter(Boolean)) {
      accumulated = accumulated ? `${accumulated}/${name}` : name;
      const location = `${parent ?? 'root'}\u0000${name}`;
      let id = byLocation.get(location);
      if (!id) {
        id = crypto.randomUUID();
        byLocation.set(location, id);
        planned.push({ id, repositoryId, parentId: parent, name });
      }
      parent = id;
      ids.set(accumulated, id);
    }
    ids.set(directory, parent);
  }
  return { ids, planned };
}

async function validateImportAssets(env: Env, items: PreparedItem[]): Promise<void> {
  const assetIds = new Set<string>();
  for (const prepared of items) {
    for (const assetId of mediaIds(prepared.markdown)) assetIds.add(assetId);
    if (prepared.item.coverAssetId) assetIds.add(prepared.item.coverAssetId);
  }
  if (!assetIds.size) return;
  const ids = [...assetIds];
  const found = await env.CONTENT_DB.prepare(
    `SELECT id FROM media_assets WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
  ).bind(...ids).all<{ id: string }>();
  const available = new Set(found.results.map((row) => row.id));
  if (ids.some((id) => !available.has(id))) throw new HttpError(400, '导入引用了不存在的媒体资产', 'import_asset_missing');
}

export async function commitImport(
  env: Env,
  ctx: ExecutionContext,
  input: { batchId: string; repositoryId: string; categoryId?: string | null; items: CommitItem[] },
): Promise<{ posts: PostDetail[] }> {
  try {
    const active = input.items.filter((item) => item.action !== 'skip');
    if (!active.length) return { posts: [] };
    const repository = await env.CONTENT_DB.prepare(
      `SELECT id,url_key FROM repositories r WHERE id=?1
         AND NOT EXISTS (SELECT 1 FROM deletion_jobs j WHERE j.kind='repository' AND j.target_id=r.id AND j.completed_at IS NULL)`,
    )
      .bind(input.repositoryId).first<{ id: string; url_key: string }>();
    if (!repository) throw new HttpError(400, '目标仓库不存在', 'repository_not_found');
    const slugs = new Set<string>();
    const targets = new Set<string>();
    for (const item of active) {
      if (slugs.has(item.slug)) throw new HttpError(409, `导入项存在重复 slug：${item.slug}`, 'import_slug_conflict');
      slugs.add(item.slug);
      const matched = Object.keys(item.attachmentMatches);
      if (matched.some((reference) => !item.resolvedAttachments[reference])) {
        throw new HttpError(400, '引用的本地附件尚未完成上传', 'import_attachments_not_uploaded');
      }
      if (item.action === 'update') {
        if (!item.targetPostId) throw new HttpError(400, '更新导入缺少目标文章', 'missing_import_target');
        if (targets.has(item.targetPostId)) throw new HttpError(409, '同一篇既有文章不能在一次导入中被更新两次', 'duplicate_import_target');
        targets.add(item.targetPostId);
      }
    }
    const categoryPlan = await planCategories(env, input.repositoryId, input.categoryId ?? null, active.map((item) => item.directory));
    const prepared: PreparedItem[] = [];
    for (const item of active) {
      const current = item.action === 'update'
        ? await env.CONTENT_DB.prepare('SELECT id,revision,markdown FROM posts WHERE id=?1 AND deleted_at IS NULL')
          .bind(item.targetPostId!).first<CurrentImportPost>()
        : null;
      if (item.action === 'update' && !current) throw new HttpError(404, '导入目标文章不存在', 'post_not_found');
      const duplicate = await env.CONTENT_DB.prepare(
        'SELECT id FROM posts WHERE repository_id=?1 AND slug=?2 AND id!=?3 AND deleted_at IS NULL',
      ).bind(input.repositoryId, item.slug, current?.id ?? '').first<{ id: string }>();
      if (duplicate) throw new HttpError(409, `目标仓库已存在 slug：${item.slug}`, 'import_slug_conflict');
      prepared.push({
        item,
        id: current?.id ?? crypto.randomUUID(),
        current,
        revision: (current?.revision ?? 0) + 1,
        categoryId: categoryPlan.ids.get(item.directory) ?? input.categoryId ?? null,
        markdown: rewriteAttachments(item.markdown, item.resolvedAttachments),
        firstPublishedAt: normalizeConfirmedTime(item.preserveFirstPublishedAt),
      });
    }
    await validateImportAssets(env, prepared);
    const importedTitles = new Map<string, PreparedItem[]>();
    const importedPaths = new Map<string, PreparedItem>();
    for (const item of prepared) {
      importedTitles.set(item.item.title, [...(importedTitles.get(item.item.title) ?? []), item]);
      importedPaths.set(`/${repository.url_key}/${item.item.slug}`, item);
    }
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    const postStatements: D1PreparedStatement[] = [];
    const contentStatements: D1PreparedStatement[] = [];
    for (const category of categoryPlan.planned) {
      statements.push(env.CONTENT_DB.prepare(
        'INSERT INTO categories (id,repository_id,parent_id,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)',
      ).bind(category.id, category.repositoryId, category.parentId, category.name, now));
    }
    const versions: VersionPlan[] = [];
    for (const preparedItem of prepared) {
      const { item, current, id, revision, categoryId, markdown, firstPublishedAt } = preparedItem;
      const wikiTargets = await resolveWikiTargets(env, markdown, false);
      for (const target of extractWikiTargets(markdown)) {
        const imported = importedTitles.get(target);
        if (imported?.length === 1 && imported[0]) {
          wikiTargets.set(target, { title: imported[0].item.title, url: `/${repository.url_key}/${imported[0].item.slug}` });
        }
      }
      const rendered = await renderMarkdown(markdown, { wikiTargets });
      const linkUrls = extractLinks(markdown);
      for (const target of wikiTargets.values()) if (target) linkUrls.push(target.url);
      const linked = await resolveLinkTargets(env, linkUrls);
      for (const raw of linkUrls) {
        let path: string;
        try { path = new URL(raw, env.SITE_ORIGIN).pathname; } catch { continue; }
        const imported = importedPaths.get(path);
        if (imported && !linked.some((target) => target.postId === imported.id && target.url === path)) {
          linked.push({ postId: imported.id, url: path });
        }
      }
      if (current) {
        postStatements.push(env.CONTENT_DB.prepare(
          `UPDATE posts SET repository_id=?1,category_id=?2,title=?3,slug=?4,language=?5,summary=?6,markdown=?7,
                  featured=0,cover_asset_id=?8,custom_properties_json=?9,word_count=?10,character_count=?11,
                  reading_minutes=?12,revision=?13,updated_at=?14,last_write_id=?15,
                  first_published_at=COALESCE(first_published_at,?16)
            WHERE id=?17 AND revision=?18 AND deleted_at IS NULL`,
        ).bind(input.repositoryId, categoryId, item.title, item.slug, item.language, item.summary, markdown,
          item.coverAssetId, JSON.stringify(item.customProperties), rendered.wordCount, rendered.characterCount,
          rendered.readingMinutes, revision, now, operationId, firstPublishedAt, id, current.revision));
      } else {
        postStatements.push(env.CONTENT_DB.prepare(
          `INSERT INTO posts
           (id,repository_id,category_id,title,slug,language,summary,markdown,status,featured,cover_asset_id,
            custom_properties_json,revision,created_at,updated_at,first_published_at,word_count,character_count,
            reading_minutes,last_write_id)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft',0,?9,?10,?11,?12,?12,?13,?14,?15,?16,?17)`,
        ).bind(id, input.repositoryId, categoryId, item.title, item.slug, item.language, item.summary, markdown,
          item.coverAssetId, JSON.stringify(item.customProperties), revision, now, firstPublishedAt,
          rendered.wordCount, rendered.characterCount, rendered.readingMinutes, operationId));
      }
      const writeGuard = 'EXISTS (SELECT 1 FROM posts WHERE id=? AND revision=? AND last_write_id=?)';
      contentStatements.push(env.CONTENT_DB.prepare(`DELETE FROM post_tags WHERE post_id=?1 AND ${writeGuard}`)
        .bind(id, id, revision, operationId));
      for (const tag of [...new Set(item.tags.map((value) => value.trim()).filter(Boolean))]) {
        contentStatements.push(env.CONTENT_DB.prepare(
          `INSERT OR IGNORE INTO tags (id,name,created_at) SELECT ?1,?2,?3 WHERE ${writeGuard}`,
        ).bind(crypto.randomUUID(), tag, now, id, revision, operationId));
        contentStatements.push(env.CONTENT_DB.prepare(
          `INSERT OR IGNORE INTO post_tags (post_id,tag_id)
           SELECT ?1,id FROM tags WHERE name=?2 AND ${writeGuard}`,
        ).bind(id, tag, id, revision, operationId));
      }
      contentStatements.push(env.CONTENT_DB.prepare(`DELETE FROM post_links WHERE source_post_id=?1 AND ${writeGuard}`)
        .bind(id, id, revision, operationId));
      for (const link of linked) {
        contentStatements.push(env.CONTENT_DB.prepare(
          `INSERT OR IGNORE INTO post_links (source_post_id,target_post_id,target_url,created_at)
           SELECT ?1,?2,?3,?4 WHERE ${writeGuard}`,
        ).bind(id, link.postId, link.url, now, id, revision, operationId));
      }
      contentStatements.push(env.CONTENT_DB.prepare(`DELETE FROM post_media WHERE post_id=?1 AND ${writeGuard}`)
        .bind(id, id, revision, operationId));
      for (const assetId of mediaIds(markdown)) {
        contentStatements.push(env.CONTENT_DB.prepare(
          `INSERT OR IGNORE INTO post_media (post_id,asset_id,role) SELECT ?1,?2,'inline' WHERE ${writeGuard}`,
        ).bind(id, assetId, id, revision, operationId));
      }
      if (item.coverAssetId) {
        contentStatements.push(env.CONTENT_DB.prepare(
          `INSERT OR IGNORE INTO post_media (post_id,asset_id,role) SELECT ?1,?2,'cover' WHERE ${writeGuard}`,
        ).bind(id, item.coverAssetId, id, revision, operationId));
      }
      const document: SearchDocument = {
        postId: id, repositoryId: input.repositoryId, revision, title: item.title,
        taxonomy: [...item.tags, item.directory].filter(Boolean).join(' '), summary: item.summary ?? '',
        body: rendered.text,
        properties: Object.entries(item.customProperties).map(([key, value]) => `${key} ${String(value)}`).join(' '),
        displayText: rendered.text,
      };
      contentStatements.push(env.CONTENT_DB.prepare(
        `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,payload_json,created_at)
         SELECT ?1,?2,'upsert_author',?3,?4,?5,?6 WHERE ${writeGuard}`,
      ).bind(crypto.randomUUID(), `author:${id}:${revision}`, id, input.repositoryId, JSON.stringify(document), now,
        id, revision, operationId));
      const version = await versionPlan(id, current?.revision ?? revision, current?.markdown ?? markdown, item.path, current ? 'before' : 'created', now);
      versions.push(version);
      contentStatements.push(env.CONTENT_DB.prepare(
        `INSERT INTO post_versions (id,post_id,revision,kind,object_key,checksum,created_at,permanent,metadata_json)
         SELECT ?1,?2,?3,'import',?4,?5,?6,1,?7 WHERE ${writeGuard}`,
      ).bind(version.id, id, version.revision, version.objectKey, version.checksum, now, JSON.stringify(version.metadata),
        id, revision, operationId));
    }
    statements.push(...postStatements, ...contentStatements);
    statements.push(env.CONTENT_DB.prepare(
      `INSERT INTO operation_assertions (id,expected,actual)
       SELECT ?1,?2,(SELECT count(*) FROM posts WHERE last_write_id=?1)`,
    ).bind(operationId, prepared.length));
    statements.push(env.CONTENT_DB.prepare('UPDATE media_assets SET import_batch_id=NULL WHERE import_batch_id=?1').bind(input.batchId));
    statements.push(env.CONTENT_DB.prepare('DELETE FROM operation_assertions WHERE id=?1').bind(operationId));
    const writtenKeys: string[] = [];
    try {
      for (const version of versions) {
        await env.BLOG_ARCHIVE.put(version.objectKey, version.payload, {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          customMetadata: { postId: version.postId, revision: String(version.revision), checksum: version.checksum },
        });
        writtenKeys.push(version.objectKey);
      }
      await env.CONTENT_DB.batch(statements);
    } catch (error) {
      await Promise.allSettled(writtenKeys.map((key) => env.BLOG_ARCHIVE.delete(key)));
      throw error;
    }
    ctx.waitUntil(processOutbox(env));
    const posts = await Promise.all(prepared.map((item) => getManagePost(env, item.id)));
    return { posts: posts.filter((post): post is PostDetail => Boolean(post)) };
  } catch (error) {
    await discardImportBatchMedia(env, input.batchId);
    throw error;
  }
}

export async function exportPostMarkdown(env: Env, postId: string): Promise<{ body: string; filename: string }> {
  const post = await getManagePost(env, postId);
  if (!post) throw new HttpError(404, '文章不存在', 'post_not_found');
  const frontmatter: Record<string, unknown> = {
    title: post.title,
    slug: post.slug,
    language: post.language,
    summary: post.summary ?? undefined,
    tags: post.tags,
    cover: post.coverAssetId ? `media://${post.coverAssetId}` : undefined,
    date: post.firstPublishedAt ?? undefined,
    ysoseri_post_id: post.id,
    ysoseri_export_signature: await signExportId(env, post.id),
    ...post.customProperties,
  };
  const body = `---\n${yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: 100, skipInvalid: true }).trimEnd()}\n---\n${post.markdown}`;
  const filename = `${post.slug || `post-${post.id.slice(0, 8)}`}.md`;
  return { body, filename };
}
