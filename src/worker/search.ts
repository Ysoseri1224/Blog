import { stemmer } from 'stemmer';
import { HttpError } from './http';
import { renderMarkdown } from './markdown';

export interface SearchDocument {
  postId: string;
  repositoryId: string;
  snapshotId?: string;
  revision: number;
  title: string;
  taxonomy: string;
  summary: string;
  body: string;
  properties: string;
  displayText: string;
}

interface OutboxRow {
  id: string;
  action: 'upsert_author' | 'delete_author' | 'upsert_public' | 'delete_public';
  payload_json: string;
}

type SearchScope = 'author' | 'public';

function tokenizeCjk(value: string): string[] {
  const chars = Array.from(value.normalize('NFKC')).filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char));
  const tokens = [...chars];
  for (let index = 0; index < chars.length - 1; index += 1) tokens.push(`${chars[index]}${chars[index + 1]}`);
  return tokens;
}

export function tokenizeForSearch(value: string): string {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const english = normalized.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g)?.map((word) => stemmer(word)) ?? [];
  return [...english, ...tokenizeCjk(normalized)].join(' ');
}

function ftsClauses(value: string, column: 'title' | 'taxonomy' | 'summary' | 'body' | 'properties' | null, phrase = false): string {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const english = normalized.match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g)?.map((word) => stemmer(word)) ?? [];
  const cjk = tokenizeCjk(normalized);
  const bigrams = cjk.filter((token) => Array.from(token).length > 1);
  const terms = [...english, ...(bigrams.length ? bigrams : cjk)];
  if (phrase && !cjk.length && terms.length > 1) {
    return `${column ? `${column}:` : ''}"${terms.map((term) => term.replaceAll('"', '""')).join(' ')}"`;
  }
  return terms.map((term) => `${column ? `${column}:` : ''}"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function queryTokens(input: string): string[] {
  return input.match(/-?(?:[a-z-]+:)?"[^"]+"|-?\[[^\]]+\]|-?\S+/gi) ?? [];
}

interface ParsedQuery {
  include: string;
  exclude: string[];
  unsupported: string[];
}

export function parseSearchQuery(input: string): ParsedQuery {
  const tokens = queryTokens(input);
  const include: string[] = [];
  const exclude: string[] = [];
  const unsupported: string[] = [];
  for (const rawToken of tokens) {
    const excluded = rawToken.startsWith('-');
    const token = excluded ? rawToken.slice(1) : rawToken;
    if (!token) continue;
    let column: 'title' | 'taxonomy' | 'summary' | 'body' | 'properties' | null = null;
    let value = token;
    if (token.startsWith('tag:') || token.startsWith('path:')) { column = 'taxonomy'; value = token.slice(token.indexOf(':') + 1); }
    else if (token.startsWith('file:')) { column = 'title'; value = token.slice(5); }
    else if (token.startsWith('content:')) { column = 'body'; value = token.slice(8); }
    else if (token.startsWith('[') && token.endsWith(']') && token.includes(':')) { column = 'properties'; value = token.slice(1, -1).replace(':', ' '); }
    else if (/^[a-z-]+:/i.test(token)) { unsupported.push(token.split(':')[0] ?? token); continue; }
    const phrase = value.startsWith('"') && value.endsWith('"');
    value = value.replace(/^"|"$/g, '').trim();
    if (!value) continue;
    const clause = ftsClauses(value, column, phrase);
    if (!clause) continue;
    (excluded ? exclude : include).push(clause);
  }
  return { include: include.join(' AND '), exclude, unsupported };
}

function stateWinnerClause(forceEqual = false): string {
  return `source_revision=excluded.source_revision, snapshot_id=excluded.snapshot_id,
          indexed_at=excluded.indexed_at, is_deleted=excluded.is_deleted, event_id=excluded.event_id
    WHERE excluded.source_revision > index_state.source_revision
       OR (excluded.source_revision = index_state.source_revision AND excluded.is_deleted > index_state.is_deleted)
       ${forceEqual ? 'OR (excluded.source_revision = index_state.source_revision AND excluded.is_deleted = index_state.is_deleted)' : ''}`;
}

function currentEventGuard(): string {
  return `EXISTS (
    SELECT 1 FROM index_state
     WHERE post_id=? AND scope=? AND source_revision=? AND is_deleted=? AND event_id=?
  )`;
}

async function upsertIndex(env: Env, scope: SearchScope, document: SearchDocument, eventId: string, forceEqual = false): Promise<void> {
  const table = scope === 'author' ? 'author_posts_fts' : 'public_posts_fts';
  const values = [
    document.postId, document.repositoryId, tokenizeForSearch(document.title), tokenizeForSearch(document.taxonomy),
    tokenizeForSearch(document.summary), tokenizeForSearch(document.body), tokenizeForSearch(document.properties),
    document.displayText,
  ];
  if (scope === 'public') values.splice(2, 0, document.snapshotId ?? '');
  const now = new Date().toISOString();
  const state = env.SEARCH_DB.prepare(
    `INSERT INTO index_state (post_id,scope,source_revision,snapshot_id,indexed_at,is_deleted,event_id)
     VALUES (?1,?2,?3,?4,?5,0,?6)
     ON CONFLICT(post_id,scope) DO UPDATE SET ${stateWinnerClause(forceEqual)}`,
  ).bind(document.postId, scope, document.revision, document.snapshotId ?? null, now, eventId);
  const guardBindings = [document.postId, scope, document.revision, 0, eventId] as const;
  await env.SEARCH_DB.batch([
    state,
    env.SEARCH_DB.prepare(`DELETE FROM ${table} WHERE post_id=? AND ${currentEventGuard()}`)
      .bind(document.postId, ...guardBindings),
    env.SEARCH_DB.prepare(
      scope === 'author'
        ? `INSERT INTO ${table} (post_id,repository_id,title,taxonomy,summary,body,properties,display_text)
           SELECT ?,?,?,?,?,?,?,? WHERE ${currentEventGuard()}`
        : `INSERT INTO ${table} (post_id,repository_id,snapshot_id,title,taxonomy,summary,body,properties,display_text)
           SELECT ?,?,?,?,?,?,?,?,? WHERE ${currentEventGuard()}`,
    ).bind(...values, ...guardBindings),
  ]);
}

async function deleteIndex(env: Env, scope: SearchScope, postId: string, revision: number, eventId: string): Promise<void> {
  const table = scope === 'author' ? 'author_posts_fts' : 'public_posts_fts';
  const now = new Date().toISOString();
  await env.SEARCH_DB.batch([
    env.SEARCH_DB.prepare(
      `INSERT INTO index_state (post_id,scope,source_revision,snapshot_id,indexed_at,is_deleted,event_id)
       VALUES (?1,?2,?3,NULL,?4,1,?5)
       ON CONFLICT(post_id,scope) DO UPDATE SET ${stateWinnerClause()}`,
    ).bind(postId, scope, revision, now, eventId),
    env.SEARCH_DB.prepare(`DELETE FROM ${table} WHERE post_id=? AND ${currentEventGuard()}`)
      .bind(postId, postId, scope, revision, 1, eventId),
  ]);
}

export async function processOutbox(env: Env, limit = 25): Promise<void> {
  const rows = await env.CONTENT_DB.prepare(
    'SELECT id, action, payload_json FROM outbox WHERE processed_at IS NULL ORDER BY created_at LIMIT ?1',
  ).bind(limit).all<OutboxRow>();
  for (const row of rows.results) {
    try {
      if (row.action === 'delete_author' || row.action === 'delete_public') {
        const payload = JSON.parse(row.payload_json) as { postId: string; revision: number };
        await deleteIndex(env, row.action === 'delete_author' ? 'author' : 'public', payload.postId, payload.revision, row.id);
      } else {
        const document = JSON.parse(row.payload_json) as SearchDocument;
        await upsertIndex(env, row.action === 'upsert_author' ? 'author' : 'public', document, row.id);
      }
      await env.CONTENT_DB.prepare('UPDATE outbox SET processed_at = ?1, attempts = attempts + 1, last_error = NULL WHERE id = ?2')
        .bind(new Date().toISOString(), row.id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.CONTENT_DB.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ?1 WHERE id = ?2')
        .bind(message.slice(0, 500), row.id).run();
    }
  }
}

export async function removePublicIndexNow(env: Env, postId: string, revision: number): Promise<void> {
  await deleteIndex(env, 'public', postId, revision, crypto.randomUUID());
}

export async function removeAuthorIndexNow(env: Env, postId: string, revision: number): Promise<void> {
  await deleteIndex(env, 'author', postId, revision, crypto.randomUUID());
}

interface RebuildRow {
  id: string;
  repository_id: string;
  category_id: string | null;
  revision: number;
  public_index_version: number;
  title: string;
  summary: string | null;
  markdown: string;
  custom_properties_json: string;
  snapshot_id: string | null;
  object_key: string | null;
  tags_json: string | null;
}

async function taxonomyForPost(env: Env, postId: string, categoryId: string | null, snapshotTags?: string | null): Promise<string> {
  const tags = snapshotTags
    ? JSON.parse(snapshotTags) as string[]
    : (await env.CONTENT_DB.prepare(
      'SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=?1 ORDER BY t.name',
    ).bind(postId).all<{ name: string }>()).results.map((row) => row.name);
  if (!categoryId) return tags.join(' ');
  const categories = await env.CONTENT_DB.prepare(
    `WITH RECURSIVE chain(id,parent_id,name,depth) AS (
       SELECT id,parent_id,name,0 FROM categories WHERE id=?1
       UNION ALL SELECT c.id,c.parent_id,c.name,chain.depth+1 FROM categories c JOIN chain ON c.id=chain.parent_id
     ) SELECT name FROM chain ORDER BY depth DESC`,
  ).bind(categoryId).all<{ name: string }>();
  return [...tags, categories.results.map((row) => row.name).join('/')].filter(Boolean).join(' ');
}

export async function reconcileSearchIndexes(env: Env): Promise<void> {
  await processOutbox(env, 500);
  const authorRows = await env.CONTENT_DB.prepare(
    `SELECT id,repository_id,category_id,revision,public_index_version,title,summary,markdown,custom_properties_json,
            NULL AS snapshot_id,NULL AS object_key,NULL AS tags_json
       FROM posts WHERE deleted_at IS NULL`,
  ).all<RebuildRow>();
  const publicRows = await env.CONTENT_DB.prepare(
    `SELECT p.id,s.repository_id,s.category_id,p.revision,p.public_index_version,s.title,s.summary,'' AS markdown,
            s.custom_properties_json,s.id AS snapshot_id,s.object_key,s.tags_json
       FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id
       JOIN repositories r ON r.id=s.repository_id
      WHERE p.public_visible=1 AND p.deleted_at IS NULL AND r.visibility!='private'`,
  ).all<RebuildRow>();
  const desired = {
    author: new Set(authorRows.results.map((row) => row.id)),
    public: new Set(publicRows.results.map((row) => row.id)),
  };
  const states = await env.SEARCH_DB.prepare(
    'SELECT post_id,scope,source_revision,is_deleted,event_id FROM index_state',
  ).all<{ post_id: string; scope: SearchScope; source_revision: number; is_deleted: number; event_id: string }>();
  const stateByKey = new Map(states.results.map((state) => [`${state.scope}:${state.post_id}`, state]));
  for (const scope of ['author', 'public'] as const) {
    const table = scope === 'author' ? 'author_posts_fts' : 'public_posts_fts';
    const indexed = await env.SEARCH_DB.prepare(`SELECT DISTINCT post_id FROM ${table}`).all<{ post_id: string }>();
    const candidates = new Set([
      ...states.results.filter((state) => state.scope === scope).map((state) => state.post_id),
      ...indexed.results.map((row) => row.post_id),
    ]);
    for (const postId of candidates) {
      if (desired[scope].has(postId)) continue;
      const state = stateByKey.get(`${scope}:${postId}`);
      if (state?.is_deleted === 1) {
        await env.SEARCH_DB.prepare(
          `DELETE FROM ${table} WHERE post_id=?1 AND EXISTS (
             SELECT 1 FROM index_state WHERE post_id=?1 AND scope=?2 AND source_revision=?3
               AND is_deleted=1 AND event_id=?4
           )`,
        ).bind(postId, scope, state.source_revision, state.event_id).run();
      } else {
        await deleteIndex(env, scope, postId, state ? state.source_revision + 1 : 0, crypto.randomUUID());
      }
    }
  }
  for (const row of authorRows.results) {
    const rendered = await renderMarkdown(row.markdown);
    await upsertIndex(env, 'author', {
      postId: row.id, repositoryId: row.repository_id, revision: row.revision, title: row.title,
      taxonomy: await taxonomyForPost(env, row.id, row.category_id), summary: row.summary ?? '', body: rendered.text,
      properties: Object.entries(JSON.parse(row.custom_properties_json) as Record<string, unknown>)
        .map(([key, value]) => `${key} ${String(value)}`).join(' '), displayText: rendered.text,
    }, crypto.randomUUID(), true);
  }
  for (const row of publicRows.results) {
    if (!row.object_key || !row.snapshot_id) continue;
    const object = await env.BLOG_ARCHIVE.get(row.object_key);
    if (!object) continue;
    const snapshot = await object.json<{ html: string; text?: string }>();
    const displayText = snapshot.text ?? snapshot.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    await upsertIndex(env, 'public', {
      postId: row.id, repositoryId: row.repository_id, snapshotId: row.snapshot_id,
      revision: row.public_index_version, title: row.title,
      taxonomy: await taxonomyForPost(env, row.id, row.category_id, row.tags_json), summary: row.summary ?? '',
      body: displayText, properties: Object.entries(JSON.parse(row.custom_properties_json) as Record<string, unknown>)
        .map(([key, value]) => `${key} ${String(value)}`).join(' '), displayText,
    }, crypto.randomUUID(), true);
  }
}

export async function searchPosts(env: Env, repositoryId: string, query: string, author: boolean): Promise<Array<{ postId: string; snippet: string; score: number }>> {
  const parsed = parseSearchQuery(query);
  if (parsed.unsupported.length) throw new HttpError(400, `暂不支持搜索语法：${parsed.unsupported.join(', ')}`, 'unsupported_search_syntax');
  if (!parsed.include && !parsed.exclude.length) return [];
  const table = author ? 'author_posts_fts' : 'public_posts_fts';
  const weights = author ? '0,0,10,5,4,1,0.5,0' : '0,0,0,10,5,4,1,0.5,0';
  const conditions = ['repository_id = ?1'];
  const bindings: string[] = [repositoryId];
  if (parsed.include) {
    bindings.push(parsed.include);
    conditions.push(`${table} MATCH ?${bindings.length}`);
  }
  for (const excluded of parsed.exclude) {
    bindings.push(repositoryId, excluded);
    conditions.push(`post_id NOT IN (
      SELECT post_id FROM ${table} WHERE repository_id = ?${bindings.length - 1} AND ${table} MATCH ?${bindings.length}
    )`);
  }
  const score = parsed.include ? `bm25(${table}, ${weights})` : '0';
  const result = await env.SEARCH_DB.prepare(
    `SELECT post_id, display_text,
            ${score} AS score
       FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY score, post_id LIMIT 80`,
  ).bind(...bindings).all<{ post_id: string; display_text: string; score: number }>();
  return result.results.map((row) => ({ postId: row.post_id, snippet: readableSnippet(row.display_text, query), score: row.score }));
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function readableSnippet(text: string, query: string): string {
  const positive = queryTokens(query)
    .filter((token) => !token.startsWith('-'))
    .map((token) => token.replace(/^\w+:/, '').replace(/^\[[^:]+:/, '').replace(/[\]"]+$/g, '').trim())
    .filter(Boolean);
  const lower = text.toLocaleLowerCase();
  const match = positive.map((term) => ({ term, index: lower.indexOf(term.toLocaleLowerCase()) }))
    .filter((item) => item.index >= 0).sort((left, right) => left.index - right.index)[0];
  const start = Math.max(0, (match?.index ?? 0) - 56);
  const end = Math.min(text.length, start + 180);
  const excerpt = text.slice(start, end);
  if (!match) return `${start ? '…' : ''}${escapeHtml(excerpt)}${end < text.length ? '…' : ''}`;
  const localIndex = match.index - start;
  const before = excerpt.slice(0, localIndex);
  const hit = excerpt.slice(localIndex, localIndex + match.term.length);
  const after = excerpt.slice(localIndex + match.term.length);
  return `${start ? '…' : ''}${escapeHtml(before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}${end < text.length ? '…' : ''}`;
}
