import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { PostDetail } from '../src/shared/types';
import { commitImport, type ImportItem } from '../src/worker/importer';
import { sha256Hex } from '../src/worker/crypto';
import { authorRequest, jsonBody, login, workerRequest, type AuthSession } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';

async function uploadPixel(session: AuthSession, importBatchId?: string, marker = 9): Promise<string> {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, marker]);
  const checksum = await sha256Hex(bytes.buffer);
  const response = await authorRequest(session, '/api/manage/media', {
    method: 'PUT',
    headers: {
      'content-type': 'image/png', 'content-length': String(bytes.byteLength),
      'x-file-name': 'import-photo.png', 'x-file-sha256': checksum,
      ...(importBatchId ? { 'x-import-batch-id': importBatchId } : {}),
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  expect([200, 201]).toContain(response.status);
  return (await jsonBody<{ asset: { id: string } }>(response)).asset.id;
}

async function preview(session: AuthSession, input: {
  files: Array<{ path: string; content: string }>;
  attachments?: Array<{ path: string; assetId?: string }>;
}): Promise<{
  items: ImportItem[]; ignored: string[]; unreferencedAttachments: string[];
  attachmentConflicts: Array<{ normalizedPath: string; paths: string[]; reason: string }>;
}> {
  const response = await authorRequest(session, '/api/manage/import/preview', {
    method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: null, files: input.files, attachments: input.attachments ?? [] }),
  });
  expect(response.status).toBe(200);
  return jsonBody(response);
}

async function createSavedPost(session: AuthSession, slug = 'runtime-import-existing'): Promise<PostDetail> {
  const createdResponse = await authorRequest(session, '/api/manage/posts', {
    method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: null, title: '导入更新目标', language: 'zh-CN' }),
  });
  const created = (await jsonBody<{ post: PostDetail }>(createdResponse)).post;
  const savedResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
    method: 'PUT', body: JSON.stringify({
      baseRevision: created.revision, title: '导入更新目标', slug, repositoryId: lifeRepositoryId,
      categoryId: null, language: 'zh-CN', summary: null, markdown: '# 原公开稿\n\n保持公开。', tags: [], featured: false,
      coverAssetId: null, customProperties: {},
    }),
  });
  expect(savedResponse.status).toBe(200);
  return (await jsonBody<{ post: PostDetail }>(savedResponse)).post;
}

describe('Markdown、文件夹与 ZIP 共用的导入管线', () => {
  it('预检目录与附件，保留未知属性，并把确认项写成带永久版本的草稿', async () => {
    const session = await login();
    const assetId = await uploadPixel(session);
    const result = await preview(session, {
      files: [
        {
          path: 'Vault\\Notes\\Entry.md',
          content: `---\ntitle: 导入文章\nslug: runtime-import-new\ntags: [纸张, archive]\nlanguage: zh-CN\nstatus: published\npublished: true\nmood: quiet\ncover: media://${assetId}\n---\n# 导入文章\n\n![](../Assets/My%20Photo.png)\n\n![[missing.png]]`,
        },
        { path: '.obsidian/workspace.md', content: '# 不应导入' },
      ],
      attachments: [
        { path: 'Vault/Assets/My Photo.png', assetId },
        { path: 'Vault/Assets/unused.png' },
      ],
    });
    expect(result.ignored).toContain('.obsidian/workspace.md');
    expect(result.unreferencedAttachments).toContain('Vault/Assets/unused.png');
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item).toMatchObject({
      title: '导入文章', slug: 'runtime-import-new', directory: 'Vault/Notes', coverAssetId: assetId,
      customProperties: { mood: 'quiet' },
      resolvedAttachments: { '../Assets/My%20Photo.png': assetId },
    });
    expect(item.missingAttachments).toContain('missing.png');
    expect(item.customProperties).not.toHaveProperty('status');
    expect(item.customProperties).not.toHaveProperty('published');

    const commitResponse = await authorRequest(session, '/api/manage/import/commit', {
      method: 'POST', body: JSON.stringify({
        batchId: crypto.randomUUID(), repositoryId: lifeRepositoryId, categoryId: null,
        items: [{ ...item, action: 'new', preserveFirstPublishedAt: '2024-01-02T03:04:05+13:00' }],
      }),
    });
    expect(commitResponse.status).toBe(201);
    const imported = (await jsonBody<{ posts: PostDetail[] }>(commitResponse)).posts[0]!;
    expect(imported).toMatchObject({ status: 'draft', slug: 'runtime-import-new', coverAssetId: assetId, firstPublishedAt: '2024-01-01T14:04:05.000Z' });
    expect(imported.markdown).toContain(`media://${assetId}`);
    expect(imported.markdown).toContain('![[missing.png]]');
    const categoryPath = await env.CONTENT_DB.prepare(
      `WITH RECURSIVE chain(id,parent_id,name,depth) AS (
         SELECT id,parent_id,name,0 FROM categories WHERE id=?1
         UNION ALL SELECT c.id,c.parent_id,c.name,chain.depth+1 FROM categories c JOIN chain ON c.id=chain.parent_id
       ) SELECT name FROM chain ORDER BY depth DESC`,
    ).bind(imported.categoryId).all<{ name: string }>();
    expect(categoryPath.results.map((row) => row.name)).toEqual(['Vault', 'Notes']);
    expect((await env.CONTENT_DB.prepare("SELECT count(*) AS count FROM post_versions WHERE post_id=?1 AND kind='import' AND permanent=1").bind(imported.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('未签名的本站 ID 只作为候选，人工确认更新前留永久检查点且不改公开快照', async () => {
    const session = await login();
    const existing = await createSavedPost(session);
    expect((await authorRequest(session, `/api/manage/posts/${existing.id}/publish`, { method: 'POST' })).status).toBe(200);
    const result = await preview(session, {
      files: [{
        path: 'updated.md',
        content: `---\ntitle: 导入后的工作稿\nslug: runtime-import-existing\nysoseri_post_id: ${existing.id}\n---\n# 新工作稿\n\n尚未重新发布。`,
      }],
    });
    expect(result.items[0]?.duplicateCandidates[0]).toMatchObject({ postId: existing.id, reason: '本站 ID 签名无效，仅作候选' });
    const commitResponse = await authorRequest(session, '/api/manage/import/commit', {
      method: 'POST', body: JSON.stringify({
        batchId: crypto.randomUUID(), repositoryId: lifeRepositoryId, categoryId: null,
        items: [{ ...result.items[0]!, action: 'update', targetPostId: existing.id, preserveFirstPublishedAt: null }],
      }),
    });
    expect(commitResponse.status).toBe(201);
    const updated = (await jsonBody<{ posts: PostDetail[] }>(commitResponse)).posts[0]!;
    expect(updated.markdown).toContain('新工作稿');
    expect(updated.publicRevision).toBe(existing.revision);
    const publicPost = await workerRequest('/api/public/post?repository=life&slug=runtime-import-existing');
    expect(publicPost.status).toBe(200);
    expect((await publicPost.json<PostDetail>()).html).toContain('原公开稿');
    expect((await env.CONTENT_DB.prepare("SELECT count(*) AS count FROM post_versions WHERE post_id=?1 AND kind='import' AND permanent=1").bind(existing.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('本站导出签名可验证，原发布时间展示最终 UTC，附件大小写冲突不会被猜测', async () => {
    const session = await login();
    const existing = await createSavedPost(session, 'runtime-import-signed');
    expect((await authorRequest(session, `/api/manage/posts/${existing.id}/publish`, { method: 'POST' })).status).toBe(200);
    const exported = await authorRequest(session, `/api/manage/posts/${existing.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toContain('text/markdown');
    const markdown = await exported.text();
    expect(markdown).toContain(`ysoseri_post_id: ${existing.id}`);
    expect(markdown).toContain('ysoseri_export_signature:');

    const result = await preview(session, {
      files: [{ path: 'Notes/exported.md', content: `${markdown}\n\n![](../Assets/Photo.png)` }],
      attachments: [{ path: 'Assets/Photo.png' }, { path: 'assets/photo.png' }],
    });
    expect(result.items[0]).toMatchObject({
      exportedPostId: existing.id,
      exportedPostIdVerified: true,
      publishedTimeCandidate: { field: 'date', timezone: 'UTC', issue: null },
    });
    expect(result.items[0]?.publishedTimeCandidate?.parsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.items[0]?.duplicateCandidates[0]).toMatchObject({
      postId: existing.id, reason: '本站导出签名已验证',
    });
    expect(result.attachmentConflicts).toEqual([expect.objectContaining({ reason: 'case_collision' })]);
    expect(result.items[0]?.missingAttachments).toContain('../Assets/Photo.png');

    const tampered = await preview(session, {
      files: [{ path: 'tampered.md', content: markdown.replace(/ysoseri_export_signature: .+/, 'ysoseri_export_signature: invalid') }],
    });
    expect(tampered.items[0]).toMatchObject({ exportedPostId: existing.id, exportedPostIdVerified: false });
    expect(tampered.items[0]?.duplicateCandidates[0]?.reason).toBe('本站 ID 签名无效，仅作候选');
  });

  it('批量提交发生并发 CAS 冲突时回滚文章、分类、版本对象和本批新媒体', async () => {
    const session = await login();
    const existing = await createSavedPost(session, 'runtime-import-atomic-existing');
    const batchId = crypto.randomUUID();
    const assetId = await uploadPixel(session, batchId, 42);
    const result = await preview(session, {
      files: [
        {
          path: 'Atomic/Existing.md',
          content: `---\ntitle: 原子更新\nslug: runtime-import-atomic-existing\n---\n# 原子更新\n\n不应覆盖并发内容。`,
        },
        {
          path: 'Atomic/Nested/New.md',
          content: `---\ntitle: 原子新建\nslug: runtime-import-atomic-new\n---\n# 原子新建\n\n![](../../Assets/Photo.png)`,
        },
      ],
      attachments: [{ path: 'Assets/Photo.png', assetId }],
    });
    const beforeObjects = (await env.BLOG_ARCHIVE.list({ prefix: 'versions/' })).objects.map((object) => object.key).sort();
    const mediaObject = await env.CONTENT_DB.prepare('SELECT object_key FROM media_assets WHERE id=?1')
      .bind(assetId).first<{ object_key: string }>();
    const originalBatch = env.CONTENT_DB.batch.bind(env.CONTENT_DB);
    let sabotaged = false;
    const contentDb = new Proxy(env.CONTENT_DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!sabotaged) {
              sabotaged = true;
              await target.prepare('UPDATE posts SET revision=revision+1 WHERE id=?1').bind(existing.id).run();
            }
            return originalBatch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const testEnv = { ...env, CONTENT_DB: contentDb } as Env;
    const items = result.items.map((item) => ({
      ...item,
      action: item.path.endsWith('Existing.md') ? 'update' as const : 'new' as const,
      targetPostId: item.path.endsWith('Existing.md') ? existing.id : undefined,
      preserveFirstPublishedAt: null,
    }));
    await expect(commitImport(testEnv, createExecutionContext(), {
      batchId, repositoryId: lifeRepositoryId, categoryId: null, items,
    })).rejects.toThrow();

    const surviving = await env.CONTENT_DB.prepare('SELECT markdown,revision FROM posts WHERE id=?1')
      .bind(existing.id).first<{ markdown: string; revision: number }>();
    expect(surviving?.markdown).toContain('原公开稿');
    expect(surviving?.revision).toBe(existing.revision + 1);
    expect(await env.CONTENT_DB.prepare("SELECT id FROM posts WHERE slug='runtime-import-atomic-new'").first()).toBeNull();
    expect(await env.CONTENT_DB.prepare("SELECT id FROM categories WHERE name IN ('Atomic','Nested') LIMIT 1").first()).toBeNull();
    expect((await env.BLOG_ARCHIVE.list({ prefix: 'versions/' })).objects.map((object) => object.key).sort()).toEqual(beforeObjects);
    expect(await env.CONTENT_DB.prepare('SELECT id FROM media_assets WHERE id=?1').bind(assetId).first()).toBeNull();
    expect(await env.SITE_MEDIA.head(mediaObject!.object_key)).toBeNull();
  });
});
