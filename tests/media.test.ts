import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/worker/crypto';
import type { PostDetail } from '../src/shared/types';
import { authorRequest, jsonBody, login, workerRequest, type AuthSession } from './helpers';

interface AssetResponse {
  asset: { id: string; filename: string; contentType: string; size: number; createdAt: string };
  duplicate: boolean;
}

async function upload(session: AuthSession, bytes: Uint8Array, checksum: string, filename: string): Promise<Response> {
  return authorRequest(session, '/api/manage/media', {
    method: 'PUT',
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      'x-file-name': encodeURIComponent(filename),
      'x-file-sha256': checksum,
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
}

describe('媒体上传与字节服务', () => {
  it('按 SHA-256 去重，并正确响应 GET、HEAD 与 Range', async () => {
    const session = await login();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const checksum = await sha256Hex(bytes.buffer);
    const firstResponse = await upload(session, bytes, checksum, 'integration / pixel.png');
    expect(firstResponse.status).toBe(201);
    const first = await jsonBody<AssetResponse>(firstResponse);
    expect(first).toMatchObject({ duplicate: false, asset: { contentType: 'image/png', size: bytes.byteLength } });
    expect(first.asset.filename).toBe('integration - pixel.png');

    const duplicateResponse = await upload(session, bytes, checksum, 'same-bytes.png');
    expect(duplicateResponse.status).toBe(200);
    const duplicate = await jsonBody<AssetResponse>(duplicateResponse);
    expect(duplicate).toMatchObject({ duplicate: true, asset: { id: first.asset.id } });
    expect((await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM media_assets WHERE checksum=?1').bind(checksum).first<{ count: number }>())?.count).toBe(1);

    expect((await workerRequest(`/api/public/media/${first.asset.id}`)).status).toBe(404);

    const full = await authorRequest(session, `/api/public/media/${first.asset.id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const head = await authorRequest(session, `/api/public/media/${first.asset.id}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(head.headers.get('etag')).toBeTruthy();
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const partial = await authorRequest(session, `/api/public/media/${first.asset.id}`, { headers: { range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 2-5/${bytes.byteLength}`);
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([...bytes.slice(2, 6)]);

    const unsatisfiable = await authorRequest(session, `/api/public/media/${first.asset.id}`, { headers: { range: 'bytes=99-120' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${bytes.byteLength}`);

    const createdResponse = await authorRequest(session, '/api/manage/posts', {
      method: 'POST',
      body: JSON.stringify({
        repositoryId: '11111111-1111-4111-8111-111111111111', categoryId: null,
        title: '媒体快照边界', language: 'zh-CN',
      }),
    });
    const created = (await jsonBody<{ post: PostDetail }>(createdResponse)).post;
    const withMediaResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: created.revision, title: '媒体快照边界', slug: 'media-snapshot-boundary',
        repositoryId: created.repositoryId, categoryId: null, language: 'zh-CN', summary: null,
        markdown: `# 媒体快照边界\n\n![像素](media://${first.asset.id})`, tags: [], featured: false,
        coverAssetId: first.asset.id, customProperties: {},
      }),
    });
    const withMedia = (await jsonBody<{ post: PostDetail }>(withMediaResponse)).post;
    const roles = await env.CONTENT_DB.prepare('SELECT role FROM post_media WHERE post_id=?1 ORDER BY role')
      .bind(created.id).all<{ role: string }>();
    expect(roles.results.map((row) => row.role)).toEqual(['cover', 'inline']);
    expect((await workerRequest(`/api/public/media/${first.asset.id}`)).status).toBe(404);

    expect((await authorRequest(session, `/api/manage/posts/${created.id}/publish`, { method: 'POST' })).status).toBe(200);
    expect((await workerRequest(`/api/public/media/${first.asset.id}`)).status).toBe(200);

    const withoutMediaResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: withMedia.revision, title: '媒体快照边界', slug: 'media-snapshot-boundary',
        repositoryId: created.repositoryId, categoryId: null, language: 'zh-CN', summary: null,
        markdown: '# 媒体快照边界\n\n新的无媒体工作稿。', tags: [], featured: false,
        coverAssetId: null, customProperties: {},
      }),
    });
    expect(withoutMediaResponse.status).toBe(200);
    const withoutMedia = (await jsonBody<{ post: PostDetail }>(withoutMediaResponse)).post;
    expect((await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM post_media WHERE post_id=?1')
      .bind(created.id).first<{ count: number }>())?.count).toBe(0);
    expect((await workerRequest(`/api/public/media/${first.asset.id}`)).status).toBe(200);

    expect((await authorRequest(session, `/api/manage/posts/${created.id}/publish`, { method: 'POST' })).status).toBe(200);
    expect(withoutMedia.revision).toBe(2);
    expect((await workerRequest(`/api/public/media/${first.asset.id}`)).status).toBe(404);
  });
});
