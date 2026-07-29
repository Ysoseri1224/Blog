import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Category, PostDetail } from '../src/shared/types';
import { processOutbox, reconcileSearchIndexes } from '../src/worker/search';
import { authorRequest, jsonBody, login, workerRequest, type AuthSession } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';
const techRepositoryId = '33333333-3333-4333-8333-333333333333';

async function createPost(session: AuthSession, repositoryId: string, title: string): Promise<PostDetail> {
  const response = await authorRequest(session, '/api/manage/posts', {
    method: 'POST', body: JSON.stringify({ repositoryId, categoryId: null, title, language: 'zh-CN' }),
  });
  expect(response.status).toBe(201);
  return (await jsonBody<{ post: PostDetail }>(response)).post;
}

async function savePost(session: AuthSession, post: PostDetail, input: {
  slug: string; title: string; markdown: string; summary?: string; tags?: string[];
  categoryId?: string | null; customProperties?: Record<string, unknown>;
}): Promise<PostDetail> {
  const response = await authorRequest(session, `/api/manage/posts/${post.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      baseRevision: post.revision, title: input.title, slug: input.slug, repositoryId: post.repositoryId,
      categoryId: input.categoryId ?? null, language: 'zh-CN', summary: input.summary ?? null,
      markdown: input.markdown, tags: input.tags ?? [], featured: false, coverAssetId: null,
      customProperties: input.customProperties ?? {},
    }),
  });
  expect(response.status).toBe(200);
  return (await jsonBody<{ post: PostDetail }>(response)).post;
}

async function authorSearch(session: AuthSession, query: string): Promise<string[]> {
  const response = await authorRequest(session, `/api/manage/search?repository=${lifeRepositoryId}&q=${encodeURIComponent(query)}`);
  expect(response.status).toBe(200);
  const body = await jsonBody<{ results: Array<{ postId: string; snippet: string }> }>(response);
  return body.results.map((result) => result.postId);
}

describe('仓库内全文搜索', () => {
  it('解析短语、字段、属性、中英混排与纯排除查询，并拒绝未知语法', async () => {
    const session = await login();
    const parentResponse = await authorRequest(session, '/api/manage/categories', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, parentId: null, name: '研究笔记' }),
    });
    expect(parentResponse.status).toBe(201);
    const parent = (await jsonBody<{ category: Category }>(parentResponse)).category;
    const childResponse = await authorRequest(session, '/api/manage/categories', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, parentId: parent.id, name: '纸张实验' }),
    });
    expect(childResponse.status).toBe(201);
    const child = (await jsonBody<{ category: Category }>(childResponse)).category;

    const first = await savePost(session, await createPost(session, lifeRepositoryId, 'Searchable Notebook'), {
      slug: 'runtime-search-first', title: 'Searchable Notebook 中文札记', categoryId: child.id,
      summary: 'alpha summary', tags: ['archive', 'paper'], customProperties: { mood: 'quiet', medium: 'ink' },
      markdown: '# Entry\n\nA quick brown fox records 中文检索词 and an obsolete method.',
    });
    const second = await savePost(session, await createPost(session, lifeRepositoryId, 'Second Note'), {
      slug: 'runtime-search-second', title: 'Second Note', tags: ['paper'], customProperties: { mood: 'bright' },
      markdown: '# Current\n\nA quick red fox keeps the 中文检索词 current.',
    });
    await savePost(session, await createPost(session, techRepositoryId, 'Cross Repository'), {
      slug: 'runtime-search-cross', title: 'Searchable Notebook 中文札记', markdown: 'quick brown fox',
    });
    await processOutbox(env);

    await expect(authorSearch(session, '"quick brown"')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, 'content:"brown fox"')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, 'tag:archive')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, 'path:纸张实验')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, 'file:searchable')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, '[mood:quiet]')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, '中文 searchable')).resolves.toEqual([first.id]);
    await expect(authorSearch(session, 'paper -archive')).resolves.toEqual([second.id]);
    await expect(authorSearch(session, '-obsolete')).resolves.toEqual([second.id]);

    const unsupported = await authorRequest(session, `/api/manage/search?repository=${lifeRepositoryId}&q=${encodeURIComponent('line:12')}`);
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json<{ error: string }>()).toMatchObject({ error: 'unsupported_search_syntax' });

    const publicBeforePublish = await workerRequest('/api/public/search?repository=life&q=obsolete');
    expect(publicBeforePublish.status).toBe(200);
    expect(await publicBeforePublish.json<{ results: unknown[] }>()).toMatchObject({ results: [] });
  });

  it('reconcile 可修复同 revision 的作者索引，并清除公共索引中的私密和撤回内容且保留墓碑', async () => {
    const session = await login();
    const repair = await savePost(session, await createPost(session, lifeRepositoryId, 'Repair author index'), {
      slug: 'runtime-search-repair', title: 'Repair author index', markdown: 'reconcile author repair needle',
    });
    const visible = await savePost(session, await createPost(session, lifeRepositoryId, 'Visible reconcile'), {
      slug: 'runtime-search-visible', title: 'Visible reconcile', markdown: 'visible public reconcile needle',
    });
    expect((await authorRequest(session, `/api/manage/posts/${visible.id}/publish`, { method: 'POST' })).status).toBe(200);
    const withdrawn = await savePost(session, await createPost(session, lifeRepositoryId, 'Withdrawn reconcile'), {
      slug: 'runtime-search-withdrawn', title: 'Withdrawn reconcile', markdown: 'withdrawn public reconcile needle',
    });
    expect((await authorRequest(session, `/api/manage/posts/${withdrawn.id}/publish`, { method: 'POST' })).status).toBe(200);
    const privateRepositoryResponse = await authorRequest(session, '/api/manage/repositories', {
      method: 'POST', body: JSON.stringify({ name: '搜索私密仓库', key: 'search-private', visibility: 'private' }),
    });
    const privateRepository = (await privateRepositoryResponse.json<{ repository: { id: string } }>()).repository;
    const privatePost = await savePost(session, await createPost(session, privateRepository.id, 'Private reconcile'), {
      slug: 'runtime-search-private', title: 'Private reconcile', markdown: 'private public reconcile needle',
    });
    expect((await authorRequest(session, `/api/manage/posts/${privatePost.id}/publish`, { method: 'POST' })).status).toBe(200);
    await processOutbox(env, 100);

    await env.SEARCH_DB.prepare('DELETE FROM author_posts_fts WHERE post_id=?1').bind(repair.id).run();
    await env.CONTENT_DB.prepare(
      `UPDATE posts SET public_visible=0,public_index_version=public_index_version+1 WHERE id=?1`,
    ).bind(withdrawn.id).run();
    for (const post of [withdrawn, privatePost]) {
      const version = await env.CONTENT_DB.prepare('SELECT public_index_version FROM posts WHERE id=?1')
        .bind(post.id).first<{ public_index_version: number }>();
      await env.SEARCH_DB.batch([
        env.SEARCH_DB.prepare(
          `INSERT INTO index_state (post_id,scope,source_revision,snapshot_id,indexed_at,is_deleted,event_id)
           VALUES (?1,'public',?2,'bogus',?3,0,?4)
           ON CONFLICT(post_id,scope) DO UPDATE SET source_revision=excluded.source_revision,
             snapshot_id=excluded.snapshot_id,indexed_at=excluded.indexed_at,is_deleted=0,event_id=excluded.event_id`,
        ).bind(post.id, version!.public_index_version, new Date().toISOString(), crypto.randomUUID()),
        env.SEARCH_DB.prepare(
          `INSERT INTO public_posts_fts
           (post_id,repository_id,snapshot_id,title,taxonomy,summary,body,properties,display_text)
           VALUES (?1,?2,'bogus','bogus','','','reconcile bogus leak','','reconcile bogus leak')`,
        ).bind(post.id, post.repositoryId),
      ]);
    }

    await reconcileSearchIndexes(env);
    await expect(authorSearch(session, 'repair needle')).resolves.toContain(repair.id);
    expect((await env.SEARCH_DB.prepare('SELECT post_id FROM public_posts_fts ORDER BY post_id')
      .all<{ post_id: string }>()).results.map((row) => row.post_id)).toContain(visible.id);
    for (const post of [withdrawn, privatePost]) {
      expect((await env.SEARCH_DB.prepare('SELECT count(*) AS count FROM public_posts_fts WHERE post_id=?1')
        .bind(post.id).first<{ count: number }>())?.count).toBe(0);
    }
    const tombstone = await env.SEARCH_DB.prepare(
      "SELECT source_revision,is_deleted FROM index_state WHERE post_id=?1 AND scope='public'",
    ).bind(withdrawn.id).first<{ source_revision: number; is_deleted: number }>();
    expect(tombstone?.is_deleted).toBe(1);
    await reconcileSearchIndexes(env);
    expect(await env.SEARCH_DB.prepare(
      "SELECT source_revision,is_deleted FROM index_state WHERE post_id=?1 AND scope='public'",
    ).bind(withdrawn.id).first()).toEqual(tombstone);
  });
});
