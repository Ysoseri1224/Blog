import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDetail } from '../src/shared/types';
import { publishDuePosts } from '../src/worker/publishing';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';

async function preparedPost(): Promise<{ session: Awaited<ReturnType<typeof login>>; post: PostDetail }> {
  const session = await login();
  const createdResponse = await authorRequest(session, '/api/manage/posts', {
    method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: null, title: '定时边界', language: 'zh-CN' }),
  });
  expect(createdResponse.status).toBe(201);
  const created = (await jsonBody<{ post: PostDetail }>(createdResponse)).post;
  const savedResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
    method: 'PUT', body: JSON.stringify({
      baseRevision: created.revision, title: '定时边界', slug: 'runtime-schedule-test', repositoryId: lifeRepositoryId,
      categoryId: null, language: 'zh-CN', summary: null, markdown: '# 定时发布\n\n正文。', tags: [],
      featured: false, coverAssetId: null, customProperties: {},
    }),
  });
  expect(savedResponse.status).toBe(200);
  return { session, post: (await jsonBody<{ post: PostDetail }>(savedResponse)).post };
}

describe('定时发布与时区', () => {
  it('拒绝 DST 不存在时间，并让重复 Cron 只生成一个公开快照', async () => {
    const { session, post } = await preparedPost();
    const nonexistent = await authorRequest(session, `/api/manage/posts/${post.id}/schedule`, {
      method: 'POST', body: JSON.stringify({
        baseRevision: post.revision,
        localDateTime: '2026-09-27T02:30:00',
        timezone: 'Pacific/Auckland',
        utcDateTime: '2026-09-26T14:30:00Z',
      }),
    });
    expect(nonexistent.status).toBe(400);
    expect(await nonexistent.json<{ error: string }>()).toMatchObject({ error: 'schedule_timezone_mismatch' });

    const invalidTimezone = await authorRequest(session, `/api/manage/posts/${post.id}/schedule`, {
      method: 'POST', body: JSON.stringify({
        baseRevision: post.revision,
        localDateTime: '2030-07-01T10:00:00',
        timezone: 'Pacific/Not-A-Real-Zone',
        utcDateTime: '2030-06-30T22:00:00Z',
      }),
    });
    expect(invalidTimezone.status).toBe(400);
    expect(await invalidTimezone.json<{ error: string }>()).toMatchObject({ error: 'invalid_timezone' });

    const scheduledResponse = await authorRequest(session, `/api/manage/posts/${post.id}/schedule`, {
      method: 'POST', body: JSON.stringify({
        baseRevision: post.revision,
        localDateTime: '2030-07-01T10:00:00',
        timezone: 'Pacific/Auckland',
        utcDateTime: '2030-06-30T22:00:00Z',
      }),
    });
    expect(scheduledResponse.status).toBe(200);
    const scheduled = (await jsonBody<{ post: PostDetail }>(scheduledResponse)).post;
    expect(scheduled).toMatchObject({
      status: 'scheduled', scheduledLocal: '2030-07-01T10:00:00',
      scheduledTimezone: 'Pacific/Auckland', scheduledUtc: '2030-06-30T22:00:00.000Z',
    });

    await env.CONTENT_DB.prepare("UPDATE posts SET scheduled_utc='2000-01-01T00:00:00.000Z' WHERE id=?1").bind(post.id).run();
    const firstContext = createExecutionContext();
    await publishDuePosts(env, firstContext);
    await waitOnExecutionContext(firstContext);
    const repeatedContext = createExecutionContext();
    await publishDuePosts(env, repeatedContext);
    await waitOnExecutionContext(repeatedContext);

    expect((await workerRequest('/api/public/post?repository=life&slug=runtime-schedule-test')).status).toBe(200);
    const snapshotCount = await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM public_snapshots WHERE post_id=?1').bind(post.id).first<{ count: number }>();
    const versionCount = await env.CONTENT_DB.prepare("SELECT count(*) AS count FROM post_versions WHERE post_id=?1 AND kind='scheduled_publish'").bind(post.id).first<{ count: number }>();
    expect(snapshotCount?.count).toBe(1);
    expect(versionCount?.count).toBe(1);
  });
});
