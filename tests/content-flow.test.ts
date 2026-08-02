import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parsePublicPostResponse } from '../src/client/public/publicPostContract';
import type { PostDetail } from '../src/shared/types';
import { getManagePost } from '../src/worker/data';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';

function draft(post: PostDetail, markdown: string, slug: string, title = '边界测试文章') {
  return {
    baseRevision: post.revision,
    title,
    slug,
    repositoryId: lifeRepositoryId,
    categoryId: null,
    language: 'zh-CN',
    summary: '用于 Workers Runtime 的隔离测试',
    markdown,
    tags: ['中文', 'runtime'],
    featured: false,
    coverAssetId: null,
    customProperties: { mood: 'quiet' },
  };
}

async function createPost(): Promise<{ session: Awaited<ReturnType<typeof login>>; post: PostDetail }> {
  const session = await login();
  const response = await authorRequest(session, '/api/manage/posts', {
    method: 'POST',
    body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: null, title: '边界测试文章', language: 'zh-CN' }),
  });
  expect(response.status).toBe(201);
  return { session, post: (await jsonBody<{ post: PostDetail }>(response)).post };
}

describe('工作稿、快照与历史', () => {
  it('以 revision CAS 防止旧写入覆盖，并保持普通保存不改变公开快照', async () => {
    const { session, post } = await createPost();
    const slug = 'runtime-cas-test';
    const first = await authorRequest(session, `/api/manage/posts/${post.id}`, {
      method: 'PUT', body: JSON.stringify(draft(post, '# 第一版\n\n中文检索词与 English phrase。', slug)),
    });
    expect(first.status).toBe(200);
    const saved = (await jsonBody<{ post: PostDetail }>(first)).post;
    expect(saved.revision).toBe(1);

    const stale = await authorRequest(session, `/api/manage/posts/${post.id}`, {
      method: 'PUT', body: JSON.stringify(draft(post, '# 过期写入\n\n不应落库', slug)),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json<{ error: string }>()).toMatchObject({ error: 'revision_conflict' });

    const unpublished = await workerRequest(`/api/public/post?repository=life&slug=${slug}`);
    expect(unpublished.status).toBe(404);
    const publish = await authorRequest(session, `/api/manage/posts/${post.id}/publish`, { method: 'POST' });
    expect(publish.status).toBe(200);
    expect((await jsonBody<{ post: PostDetail }>(publish)).post.html).toContain('第一版');
    const firstPublic = await workerRequest(`/api/public/post?repository=life&slug=${slug}`);
    expect(firstPublic.status).toBe(200);
    const publicPayload = await firstPublic.json<unknown>();
    const publicPost = parsePublicPostResponse(publicPayload);
    expect(publicPost.html).toContain('第一版');
    expect(() => parsePublicPostResponse({ post: publicPost })).toThrow('不完整的数据');

    const second = await authorRequest(session, `/api/manage/posts/${post.id}`, {
      method: 'PUT', body: JSON.stringify(draft(saved, '# 第二版工作稿\n\n尚未更新发布。', slug)),
    });
    expect(second.status).toBe(200);
    const stillFirst = await workerRequest(`/api/public/post?repository=life&slug=${slug}`);
    expect((await stillFirst.json<PostDetail>()).html).toContain('第一版');
    expect((await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM public_snapshots WHERE post_id=?1').bind(post.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('发布响应可复用已生成 HTML，不重复渲染工作稿', async () => {
    const { post } = await createPost();
    const cachedHtml = '<p>已在发布阶段完成的渲染结果</p>';
    const detail = await getManagePost(env, post.id, { renderedHtml: cachedHtml });
    expect(detail?.html).toBe(cachedHtml);
  });

  it('创建永久历史、恢复为新工作稿，并要求 step-up 才能撤回', async () => {
    const { session, post } = await createPost();
    const slug = 'runtime-history-test';
    const savedResponse = await authorRequest(session, `/api/manage/posts/${post.id}`, {
      method: 'PUT', body: JSON.stringify(draft(post, '# 可恢复版本\n\n历史正文。', slug)),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await jsonBody<{ post: PostDetail }>(savedResponse)).post;
    const versionResponse = await authorRequest(session, `/api/manage/posts/${post.id}/versions`, { method: 'POST' });
    expect(versionResponse.status).toBe(201);
    const versionId = (await jsonBody<{ versionId: string }>(versionResponse)).versionId;

    const changedResponse = await authorRequest(session, `/api/manage/posts/${post.id}`, {
      method: 'PUT', body: JSON.stringify(draft(saved, '# 临时修改\n\n准备恢复。', slug)),
    });
    expect(changedResponse.status).toBe(200);
    const changed = (await jsonBody<{ post: PostDetail }>(changedResponse)).post;
    const restoredResponse = await authorRequest(session, `/api/manage/posts/${post.id}/restore`, {
      method: 'POST', body: JSON.stringify({ versionId, baseRevision: changed.revision }),
    });
    expect(restoredResponse.status).toBe(200);
    const restored = (await jsonBody<{ post: PostDetail }>(restoredResponse)).post;
    expect(restored.revision).toBe(changed.revision + 1);
    expect(restored.markdown).toContain('可恢复版本');
    expect(restored.publicRevision).toBeNull();

    await authorRequest(session, `/api/manage/posts/${post.id}/publish`, { method: 'POST' });
    const withoutStepUp = await authorRequest(session, `/api/manage/posts/${post.id}/withdraw`, { method: 'POST' });
    expect(withoutStepUp.status).toBe(403);
    expect(await withoutStepUp.json<{ error: string }>()).toMatchObject({ error: 'reauth_required' });
    const reauth = await authorRequest(session, '/api/auth/reauth', {
      method: 'POST', body: JSON.stringify({ password: 'blog-test-password' }),
    });
    expect(reauth.status).toBe(200);
    const withdrawn = await authorRequest(session, `/api/manage/posts/${post.id}/withdraw`, { method: 'POST' });
    expect(withdrawn.status).toBe(200);
    expect((await workerRequest(`/api/public/post?repository=life&slug=${slug}`)).status).toBe(404);
    expect((await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM public_snapshots WHERE post_id=?1').bind(post.id).first<{ count: number }>())?.count).toBe(1);
  });
});
