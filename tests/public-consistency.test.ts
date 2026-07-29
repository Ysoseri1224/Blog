import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PostDetail } from '../src/shared/types';
import { processOutbox } from '../src/worker/search';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

const repositoryId = '11111111-1111-4111-8111-111111111111';

async function preparedPost(slug: string): Promise<{ session: Awaited<ReturnType<typeof login>>; post: PostDetail }> {
  const session = await login();
  const createdResponse = await authorRequest(session, '/api/manage/posts', {
    method: 'POST',
    body: JSON.stringify({ repositoryId, categoryId: null, title: '并发一致性', language: 'zh-CN' }),
  });
  const created = (await jsonBody<{ post: PostDetail }>(createdResponse)).post;
  const savedResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      baseRevision: created.revision, title: '并发一致性', slug, repositoryId, categoryId: null,
      language: 'zh-CN', summary: null, markdown: '# 并发一致性\n\n只允许一个公开快照胜出。',
      tags: [], featured: false, coverAssetId: null, customProperties: {},
    }),
  });
  return { session, post: (await jsonBody<{ post: PostDetail }>(savedResponse)).post };
}

describe('公开快照与派生索引的一致性', () => {
  it('并发发布只切换一次公开指针，失败请求不留下孤儿对象或 D1 行', async () => {
    const { session, post } = await preparedPost('concurrent-publish');
    const responses = await Promise.all([
      authorRequest(session, `/api/manage/posts/${post.id}/publish`, { method: 'POST' }),
      authorRequest(session, `/api/manage/posts/${post.id}/publish`, { method: 'POST' }),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status === 200 || response.status === 409)).toBe(true);
    expect((await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM public_snapshots WHERE post_id=?1')
      .bind(post.id).first<{ count: number }>())?.count).toBe(1);
    expect((await env.CONTENT_DB.prepare("SELECT count(*) AS count FROM post_versions WHERE post_id=?1 AND kind='publish'")
      .bind(post.id).first<{ count: number }>())?.count).toBe(1);
    expect((await env.BLOG_ARCHIVE.list({ prefix: `public/${post.id}/` })).objects).toHaveLength(1);
    expect((await workerRequest('/api/public/post?repository=life&slug=concurrent-publish')).status).toBe(200);
  });

  it('撤回墓碑阻止迟到的旧公开 upsert 复活搜索结果', async () => {
    const { session, post } = await preparedPost('search-tombstone');
    expect((await authorRequest(session, `/api/manage/posts/${post.id}/publish`, { method: 'POST' })).status).toBe(200);
    await processOutbox(env);
    const publishedState = await env.SEARCH_DB.prepare(
      "SELECT source_revision,is_deleted FROM index_state WHERE post_id=?1 AND scope='public'",
    ).bind(post.id).first<{ source_revision: number; is_deleted: number }>();
    expect(publishedState).toMatchObject({ source_revision: 1, is_deleted: 0 });

    expect((await authorRequest(session, '/api/auth/reauth', {
      method: 'POST', body: JSON.stringify({ password: 'blog-test-password' }),
    })).status).toBe(200);
    expect((await authorRequest(session, `/api/manage/posts/${post.id}/withdraw`, { method: 'POST' })).status).toBe(200);

    const eventId = crypto.randomUUID();
    await env.CONTENT_DB.prepare(
      `INSERT INTO outbox (id,idempotency_key,action,post_id,repository_id,snapshot_id,payload_json,created_at)
       VALUES (?1,?2,'upsert_public',?3,?4,'stale-snapshot',?5,?6)`,
    ).bind(eventId, `test-stale:${post.id}`, post.id, repositoryId, JSON.stringify({
      postId: post.id, repositoryId, snapshotId: 'stale-snapshot', revision: 1, title: '不应复活',
      taxonomy: '', summary: '', body: 'stale searchable body', properties: '', displayText: 'stale searchable body',
    }), new Date().toISOString()).run();
    await processOutbox(env);

    expect((await env.SEARCH_DB.prepare('SELECT count(*) AS count FROM public_posts_fts WHERE post_id=?1')
      .bind(post.id).first<{ count: number }>())?.count).toBe(0);
    expect(await env.SEARCH_DB.prepare(
      "SELECT source_revision,is_deleted FROM index_state WHERE post_id=?1 AND scope='public'",
    ).bind(post.id).first<{ source_revision: number; is_deleted: number }>()).toMatchObject({ source_revision: 2, is_deleted: 1 });
  });

  it('同一工作稿的并发定时请求只有一个成功', async () => {
    const { session, post } = await preparedPost('concurrent-schedule');
    const utc = new Date(Date.now() + 86_400_000);
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(utc).replace(' ', 'T');
    const payload = JSON.stringify({
      baseRevision: post.revision, localDateTime: local, timezone: 'Pacific/Auckland', utcDateTime: utc.toISOString(),
    });
    const responses = await Promise.all([
      authorRequest(session, `/api/manage/posts/${post.id}/schedule`, { method: 'POST', body: payload }),
      authorRequest(session, `/api/manage/posts/${post.id}/schedule`, { method: 'POST', body: payload }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await env.CONTENT_DB.prepare('SELECT revision FROM posts WHERE id=?1').bind(post.id)
      .first<{ revision: number }>())?.revision).toBe(post.revision + 1);
  });
});
