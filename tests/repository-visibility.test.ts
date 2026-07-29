import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { PostDetail, Repository } from '../src/shared/types';
import { retryDeletionJobs } from '../src/worker/management';
import { processOutbox } from '../src/worker/search';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

async function createPublishedPost(): Promise<{
  session: Awaited<ReturnType<typeof login>>; repository: Repository; post: PostDetail;
}> {
  const session = await login();
  const repositoryResponse = await authorRequest(session, '/api/manage/repositories', {
    method: 'POST', body: JSON.stringify({ name: '边界仓库名称', key: 'runtime-visibility', visibility: 'public' }),
  });
  expect(repositoryResponse.status).toBe(201);
  const repository = (await jsonBody<{ repository: Repository }>(repositoryResponse)).repository;
  const createResponse = await authorRequest(session, '/api/manage/posts', {
    method: 'POST', body: JSON.stringify({ repositoryId: repository.id, categoryId: null, title: '权限边界标题', language: 'zh-CN' }),
  });
  const created = (await jsonBody<{ post: PostDetail }>(createResponse)).post;
  const saveResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
    method: 'PUT', body: JSON.stringify({
      baseRevision: created.revision, title: '权限边界标题', slug: 'visibility-post', repositoryId: repository.id,
      categoryId: null, language: 'zh-CN', summary: '权限边界摘要', markdown: '# 权限边界\n\nvisibility needle。',
      tags: [], featured: false, coverAssetId: null, customProperties: {},
    }),
  });
  const saved = (await jsonBody<{ post: PostDetail }>(saveResponse)).post;
  const publishResponse = await authorRequest(session, `/api/manage/posts/${saved.id}/publish`, { method: 'POST' });
  expect(publishResponse.status).toBe(200);
  await processOutbox(env);
  return { session, repository, post: (await jsonBody<{ post: PostDetail }>(publishResponse)).post };
}

async function patchRepository(session: Awaited<ReturnType<typeof login>>, repositoryId: string, patch: Partial<Pick<Repository, 'name' | 'key' | 'visibility'>>): Promise<Repository> {
  const response = await authorRequest(session, `/api/manage/repositories/${repositoryId}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
  return (await jsonBody<{ repository: Repository }>(response)).repository;
}

describe('仓库改名、三档可见性与永久删除', () => {
  it('同步更新 canonical/索引边界，保留 301，并让已公开删除地址返回 410', async () => {
    const { session, repository, post } = await createPublishedPost();
    expect((await workerRequest('/runtime-visibility/visibility-post')).status).toBe(200);
    const originalPointer = await env.CONTENT_DB.prepare(
      `SELECT s.id,s.object_key,s.canonical_url,s.public_repository_key
         FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id WHERE p.id=?1`,
    ).bind(post.id).first<{ id: string; object_key: string; canonical_url: string; public_repository_key: string }>();
    expect(originalPointer).not.toBeNull();
    const originalPayload = await (await env.BLOG_ARCHIVE.get(originalPointer!.object_key))!
      .json<{ snapshotId: string; canonicalUrl: string }>();

    const renamed = await patchRepository(session, repository.id, { name: '重命名后的仓库', key: 'runtime-renamed' });
    expect(renamed).toMatchObject({ name: '重命名后的仓库', key: 'runtime-renamed' });
    const renamedPointer = await env.CONTENT_DB.prepare(
      `SELECT s.id,s.object_key,s.canonical_url,s.public_repository_key
         FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id WHERE p.id=?1`,
    ).bind(post.id).first<{ id: string; object_key: string; canonical_url: string; public_repository_key: string }>();
    expect(renamedPointer).toMatchObject({
      canonical_url: 'https://blog.ysoseri.us/runtime-renamed/visibility-post',
      public_repository_key: 'runtime-renamed',
    });
    expect(renamedPointer!.id).not.toBe(originalPointer!.id);
    expect(await env.CONTENT_DB.prepare(
      'SELECT canonical_url,public_repository_key FROM public_snapshots WHERE id=?1',
    ).bind(originalPointer!.id).first()).toEqual({
      canonical_url: 'https://blog.ysoseri.us/runtime-visibility/visibility-post',
      public_repository_key: 'runtime-visibility',
    });
    expect(await (await env.BLOG_ARCHIVE.get(originalPointer!.object_key))!.json()).toEqual(originalPayload);
    expect(await (await env.BLOG_ARCHIVE.get(renamedPointer!.object_key))!
      .json<{ snapshotId: string; canonicalUrl: string }>()).toMatchObject({
      snapshotId: renamedPointer!.id,
      canonicalUrl: renamedPointer!.canonical_url,
    });
    const oldRepository = await workerRequest('/runtime-visibility/', { redirect: 'manual' });
    expect(oldRepository.status).toBe(301);
    expect(oldRepository.headers.get('location')).toBe('https://blog.ysoseri.us/runtime-renamed/');
    const oldPost = await workerRequest('/runtime-visibility/visibility-post', { redirect: 'manual' });
    expect(oldPost.status).toBe(301);
    expect(oldPost.headers.get('location')).toBe('https://blog.ysoseri.us/runtime-renamed/visibility-post');
    expect((await workerRequest('/runtime-renamed/visibility-post')).status).toBe(200);
    const renamedSearch = await workerRequest('/api/public/search?repository=runtime-renamed&q=needle');
    expect((await renamedSearch.json<{ results: Array<{ postId: string }> }>()).results.map((item) => item.postId)).toEqual([post.id]);

    await patchRepository(session, repository.id, { visibility: 'unlisted' });
    await processOutbox(env);
    const rootWhenUnlisted = await workerRequest('/');
    expect(await rootWhenUnlisted.text()).not.toContain('runtime-renamed');
    const unlistedPage = await workerRequest('/runtime-renamed/visibility-post');
    expect(unlistedPage.status).toBe(200);
    expect(await unlistedPage.text()).toContain('noindex');
    const unlistedSearch = await workerRequest('/api/public/search?repository=runtime-renamed&q=needle');
    expect((await unlistedSearch.json<{ results: Array<{ postId: string }> }>()).results.map((item) => item.postId)).toEqual([post.id]);
    expect(await (await workerRequest('/sitemap.xml')).text()).not.toContain('runtime-renamed');
    expect(await (await workerRequest('/feed.xml')).text()).not.toContain('权限边界标题');

    await patchRepository(session, repository.id, { visibility: 'private' });
    await processOutbox(env);
    const privatePage = await workerRequest('/runtime-renamed/visibility-post');
    expect(privatePage.status).toBe(404);
    const privateHtml = await privatePage.text();
    expect(privateHtml).not.toContain('权限边界标题');
    expect(privateHtml).not.toContain('边界仓库名称');
    expect((await workerRequest('/api/public/post?repository=runtime-renamed&slug=visibility-post')).status).toBe(404);
    expect((await workerRequest('/api/public/search?repository=runtime-renamed&q=needle')).status).toBe(404);
    expect((await env.SEARCH_DB.prepare('SELECT count(*) AS count FROM public_posts_fts WHERE post_id=?1').bind(post.id).first<{ count: number }>())?.count).toBe(0);
    const authorSearch = await authorRequest(session, `/api/manage/search?repository=${repository.id}&q=needle`);
    expect((await authorSearch.json<{ results: Array<{ postId: string }> }>()).results.map((item) => item.postId)).toEqual([post.id]);

    await patchRepository(session, repository.id, { visibility: 'unlisted' });
    await processOutbox(env);
    expect((await workerRequest('/runtime-renamed/visibility-post')).status).toBe(200);
    expect((await workerRequest('/api/public/search?repository=runtime-renamed&q=needle')).status).toBe(200);

    const archived = await env.CONTENT_DB.prepare(
      `SELECT object_key FROM public_snapshots WHERE post_id=?1
       UNION ALL SELECT object_key FROM post_versions WHERE post_id=?1`,
    ).bind(post.id).all<{ object_key: string }>();
    const withoutStepUp = await authorRequest(session, `/api/manage/posts/${post.id}`, { method: 'DELETE' });
    expect(withoutStepUp.status).toBe(403);
    expect((await authorRequest(session, '/api/auth/reauth', {
      method: 'POST', body: JSON.stringify({ password: 'blog-test-password' }),
    })).status).toBe(200);
    expect((await authorRequest(session, `/api/manage/posts/${post.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await workerRequest('/runtime-renamed/visibility-post')).status).toBe(410);
    expect((await workerRequest('/runtime-visibility/visibility-post')).status).toBe(410);
    expect(await env.CONTENT_DB.prepare('SELECT id FROM posts WHERE id=?1').bind(post.id).first()).toBeNull();
    for (const object of archived.results) expect(await env.BLOG_ARCHIVE.head(object.object_key)).toBeNull();

    const deleteRepository = await authorRequest(session, `/api/manage/repositories/${repository.id}`, {
      method: 'DELETE', body: JSON.stringify({ action: 'delete' }),
    });
    expect(deleteRepository.status).toBe(200);
    expect(await env.CONTENT_DB.prepare('SELECT id FROM repositories WHERE id=?1').bind(repository.id).first()).toBeNull();
  });

  it('删除仓库时把全部文章原子迁移到目标仓库，并为公开地址生成新快照', async () => {
    const { session, repository, post } = await createPublishedPost();
    const targetResponse = await authorRequest(session, '/api/manage/repositories', {
      method: 'POST', body: JSON.stringify({ name: '迁移目标', key: 'move-target', visibility: 'public' }),
    });
    const target = (await jsonBody<{ repository: Repository }>(targetResponse)).repository;
    const before = await env.CONTENT_DB.prepare(
      `SELECT p.revision,p.public_index_version,s.id AS snapshot_id,s.object_key,s.canonical_url
         FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id WHERE p.id=?1`,
    ).bind(post.id).first<{
      revision: number; public_index_version: number; snapshot_id: string; object_key: string; canonical_url: string;
    }>();
    expect((await authorRequest(session, '/api/auth/reauth', {
      method: 'POST', body: JSON.stringify({ password: 'blog-test-password' }),
    })).status).toBe(200);
    const moved = await authorRequest(session, `/api/manage/repositories/${repository.id}`, {
      method: 'DELETE', body: JSON.stringify({ action: 'move', targetRepositoryId: target.id }),
    });
    expect(moved.status).toBe(200);
    await processOutbox(env);

    expect(await env.CONTENT_DB.prepare('SELECT id FROM repositories WHERE id=?1').bind(repository.id).first()).toBeNull();
    const after = await env.CONTENT_DB.prepare(
      `SELECT p.repository_id,p.category_id,p.revision,p.public_index_version,s.id AS snapshot_id,s.object_key,
              s.canonical_url,s.repository_id AS snapshot_repository_id,s.public_repository_key
         FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id WHERE p.id=?1`,
    ).bind(post.id).first<{
      repository_id: string; category_id: string | null; revision: number; public_index_version: number;
      snapshot_id: string; object_key: string; canonical_url: string; snapshot_repository_id: string;
      public_repository_key: string;
    }>();
    expect(after).toMatchObject({
      repository_id: target.id, category_id: null, revision: before!.revision + 1,
      public_index_version: before!.public_index_version + 1, snapshot_repository_id: target.id,
      public_repository_key: 'move-target', canonical_url: 'https://blog.ysoseri.us/move-target/visibility-post',
    });
    expect(after!.snapshot_id).not.toBe(before!.snapshot_id);
    expect(await env.CONTENT_DB.prepare(
      'SELECT canonical_url,repository_id,public_repository_key FROM public_snapshots WHERE id=?1',
    ).bind(before!.snapshot_id).first()).toEqual({
      canonical_url: before!.canonical_url, repository_id: repository.id, public_repository_key: repository.key,
    });
    expect(await env.BLOG_ARCHIVE.head(before!.object_key)).not.toBeNull();
    expect(await env.BLOG_ARCHIVE.head(after!.object_key)).not.toBeNull();
    const oldPost = await workerRequest('/runtime-visibility/visibility-post', { redirect: 'manual' });
    expect(oldPost.status).toBe(301);
    expect(oldPost.headers.get('location')).toBe('https://blog.ysoseri.us/move-target/visibility-post');
    const oldRoot = await workerRequest('/runtime-visibility/', { redirect: 'manual' });
    expect(oldRoot.status).toBe(301);
    expect(oldRoot.headers.get('location')).toBe('https://blog.ysoseri.us/move-target/');
    expect((await workerRequest('/move-target/visibility-post')).status).toBe(200);
    const publicSearch = await workerRequest('/api/public/search?repository=move-target&q=needle');
    expect((await publicSearch.json<{ results: Array<{ postId: string }> }>()).results.map((item) => item.postId)).toEqual([post.id]);
    const authorSearch = await authorRequest(session, `/api/manage/search?repository=${target.id}&q=needle`);
    expect((await authorSearch.json<{ results: Array<{ postId: string }> }>()).results.map((item) => item.postId)).toEqual([post.id]);
  });

  it('连同内容删除仓库时统一封闭全部文章，并在 R2 清理失败后安全重试', async () => {
    const { session, repository, post } = await createPublishedPost();
    const draftResponse = await authorRequest(session, '/api/manage/posts', {
      method: 'POST', body: JSON.stringify({
        repositoryId: repository.id, categoryId: null, title: '仓库删除草稿', language: 'zh-CN',
      }),
    });
    const draft = (await jsonBody<{ post: PostDetail }>(draftResponse)).post;
    expect((await authorRequest(session, `/api/manage/posts/${draft.id}/versions`, { method: 'POST' })).status).toBe(201);
    const archived = await env.CONTENT_DB.prepare(
      `SELECT object_key FROM public_snapshots WHERE post_id IN (?1,?2)
       UNION ALL SELECT object_key FROM post_versions WHERE post_id IN (?1,?2)`,
    ).bind(post.id, draft.id).all<{ object_key: string }>();
    expect(archived.results.length).toBeGreaterThan(1);
    expect((await authorRequest(session, '/api/auth/reauth', {
      method: 'POST', body: JSON.stringify({ password: 'blog-test-password' }),
    })).status).toBe(200);

    const deleteSpy = vi.spyOn(env.BLOG_ARCHIVE, 'delete').mockRejectedValueOnce(new Error('synthetic R2 delete failure'));
    const firstAttempt = await authorRequest(session, `/api/manage/repositories/${repository.id}`, {
      method: 'DELETE', body: JSON.stringify({ action: 'delete' }),
    });
    deleteSpy.mockRestore();
    expect(firstAttempt.status).toBe(500);
    expect(await env.CONTENT_DB.prepare(
      `SELECT r.visibility,p.public_visible,p.deleted_at FROM repositories r JOIN posts p ON p.repository_id=r.id
        WHERE r.id=?1 AND p.id=?2`,
    ).bind(repository.id, post.id).first()).toMatchObject({
      visibility: 'private', public_visible: 0, deleted_at: expect.any(String),
    });
    expect(await env.CONTENT_DB.prepare(
      `SELECT path FROM deleted_urls WHERE path='/runtime-visibility/visibility-post'`,
    ).first()).not.toBeNull();
    expect((await workerRequest('/runtime-visibility/visibility-post')).status).toBe(410);
    expect(await env.CONTENT_DB.prepare('SELECT id FROM repositories WHERE id=?1').bind(repository.id).first()).not.toBeNull();
    expect(await env.CONTENT_DB.prepare('SELECT id FROM posts WHERE repository_id=?1 AND deleted_at IS NULL')
      .bind(repository.id).first()).toBeNull();
    const pending = await env.CONTENT_DB.prepare(
      `SELECT id,attempts,last_error FROM deletion_jobs
        WHERE kind='repository' AND target_id=?1 AND completed_at IS NULL`,
    ).bind(repository.id).first<{ id: string; attempts: number; last_error: string | null }>();
    expect(pending).toMatchObject({ attempts: 1 });
    expect(pending?.last_error).toContain('synthetic R2 delete failure');
    for (const object of archived.results) expect(await env.BLOG_ARCHIVE.head(object.object_key)).not.toBeNull();

    await retryDeletionJobs(env);
    expect(await env.CONTENT_DB.prepare('SELECT id FROM repositories WHERE id=?1').bind(repository.id).first()).toBeNull();
    expect(await env.CONTENT_DB.prepare('SELECT id FROM posts WHERE repository_id=?1').bind(repository.id).first()).toBeNull();
    expect((await workerRequest('/runtime-visibility/')).status).toBe(410);
    for (const object of archived.results) expect(await env.BLOG_ARCHIVE.head(object.object_key)).toBeNull();
    expect(await env.CONTENT_DB.prepare(
      `SELECT completed_at,attempts,last_error FROM deletion_jobs WHERE id=?1`,
    ).bind(pending!.id).first()).toMatchObject({ attempts: 2, last_error: null });
  });
});
