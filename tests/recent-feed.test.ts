import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PostDetail, RecentPublicPost } from '../src/shared/types';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';
const thoughtsRepositoryId = '22222222-2222-4222-8222-222222222222';
const techRepositoryId = '33333333-3333-4333-8333-333333333333';

async function publishPost(repositoryId: string, title: string, slug: string, summary: string): Promise<string> {
  const session = await login();
  const createdResponse = await authorRequest(session, '/api/manage/posts', {
    method: 'POST',
    body: JSON.stringify({ repositoryId, categoryId: null, title, language: 'zh-CN' }),
  });
  const created = (await jsonBody<{ post: PostDetail }>(createdResponse)).post;
  const savedResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      baseRevision: created.revision, title, slug, repositoryId, categoryId: null,
      language: 'zh-CN', summary, markdown: `# ${title}\n\n${summary}`,
      tags: [], featured: false, coverAssetId: null, customProperties: {},
    }),
  });
  expect(savedResponse.status).toBe(200);
  expect((await authorRequest(session, `/api/manage/posts/${created.id}/publish`, { method: 'POST' })).status).toBe(200);
  return created.id;
}

describe('主页近期思考公共 Feed', () => {
  it('按首次发布时间跨公开仓库返回真实标题与 description，并排除私有仓库', async () => {
    const lifeId = await publishPost(lifeRepositoryId, '较早的生活文章', 'older-life-post', '生活文章的真实摘要');
    const thoughtsId = await publishPost(thoughtsRepositoryId, '最新思考', 'latest-thought', '首页应展示的真实 description');
    const privateId = await publishPost(techRepositoryId, '不应公开发现', 'private-tech-post', '私有仓库摘要');

    const timestamps = new Map([
      [lifeId, '2026-07-28T10:00:00.000Z'],
      [thoughtsId, '2026-07-29T10:00:00.000Z'],
      [privateId, '2026-07-30T10:00:00.000Z'],
    ]);
    for (const [postId, timestamp] of timestamps) {
      await env.CONTENT_DB.prepare(
        'UPDATE public_snapshots SET first_published_at=?2,published_at=?2 WHERE post_id=?1',
      ).bind(postId, timestamp).run();
    }
    await env.CONTENT_DB.prepare("UPDATE repositories SET visibility='private' WHERE id=?1").bind(techRepositoryId).run();

    const response = await workerRequest('/api/public/recent?limit=2', {
      headers: { origin: 'https://ysoseri.us' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toContain('max-age=60');
    const body = await jsonBody<{ posts: RecentPublicPost[] }>(response);
    expect(body.posts).toHaveLength(2);
    expect(body.posts.map((post) => post.title)).toEqual(['最新思考', '较早的生活文章']);
    expect(body.posts[0]).toMatchObject({
      description: '首页应展示的真实 description',
      url: 'https://blog.ysoseri.us/thoughts/latest-thought',
      repositoryKey: 'thoughts',
      repositoryName: '我的思考',
      firstPublishedAt: '2026-07-29T10:00:00.000Z',
    });
    expect(body.posts.some((post) => post.id === privateId)).toBe(false);
  });
});
