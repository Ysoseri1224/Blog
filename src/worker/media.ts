import { HttpError, json } from './http';
import { getSession } from './auth';

const allowedTypes = /^(image\/(?:jpeg|png|gif|webp|avif)|audio\/(?:mpeg|mp4|ogg|wav|webm)|video\/(?:mp4|webm|quicktime))$/i;
const maxBytes = 100 * 1024 * 1024;

function safeFilename(value: string): string {
  return Array.from(value.normalize('NFKC'), (character) => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? '-' : character).join('').replace(/\s+/g, ' ').trim().slice(0, 180) || 'media';
}

function validByteRange(value: string, size: number): boolean {
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return false;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return false;
  if (!startText) {
    const suffixLength = Number(endText);
    return Number.isSafeInteger(suffixLength) && suffixLength > 0;
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return false;
  if (!endText) return true;
  const end = Number(endText);
  return Number.isSafeInteger(end) && end >= start;
}

export async function uploadMedia(request: Request, env: Env): Promise<Response> {
  if (!request.body) throw new HttpError(400, '没有收到媒体内容', 'missing_media_body');
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes) {
    throw new HttpError(413, '单个媒体文件必须小于 100 MB', 'media_too_large');
  }
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!allowedTypes.test(contentType)) throw new HttpError(415, '暂不支持这种媒体格式', 'unsupported_media_type');
  const filename = safeFilename(decodeURIComponent(request.headers.get('x-file-name') ?? 'media'));
  const checksum = request.headers.get('x-file-sha256')?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new HttpError(400, '上传前需要计算 SHA-256', 'missing_media_checksum');
  const importBatchId = request.headers.get('x-import-batch-id');
  if (importBatchId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(importBatchId)) {
    throw new HttpError(400, '导入批次 ID 无效', 'invalid_import_batch');
  }
  const duplicate = await env.CONTENT_DB.prepare(
    'SELECT id,filename,content_type,size,created_at FROM media_assets WHERE checksum=?1 AND deleted_at IS NULL LIMIT 1',
  ).bind(checksum).first<{ id: string; filename: string; content_type: string; size: number; created_at: string }>();
  if (duplicate) return json({ asset: { id: duplicate.id, filename: duplicate.filename, contentType: duplicate.content_type, size: duplicate.size, createdAt: duplicate.created_at }, duplicate: true });
  const id = crypto.randomUUID();
  const objectKey = `media/${id}/${encodeURIComponent(filename)}`;
  const createdAt = new Date().toISOString();
  await env.SITE_MEDIA.put(objectKey, request.body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { assetId: id, filename, checksum },
    sha256: checksum,
  });
  try {
    await env.CONTENT_DB.prepare(
      `INSERT INTO media_assets (id,object_key,filename,content_type,size,checksum,created_at,import_batch_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(id, objectKey, filename, contentType, contentLength, checksum, createdAt, importBatchId).run();
  } catch (error) {
    await env.SITE_MEDIA.delete(objectKey);
    throw error;
  }
  return json({ asset: { id, filename, contentType, size: contentLength, createdAt }, duplicate: false }, { status: 201 });
}

export async function listMedia(env: Env, query: string): Promise<Response> {
  const result = query
    ? await env.CONTENT_DB.prepare(
      `SELECT id,filename,content_type,size,created_at FROM media_assets
        WHERE deleted_at IS NULL AND filename LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT 80`,
    ).bind(`%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`).all<{ id: string; filename: string; content_type: string; size: number; created_at: string }>()
    : await env.CONTENT_DB.prepare(
      'SELECT id,filename,content_type,size,created_at FROM media_assets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 80',
    ).all<{ id: string; filename: string; content_type: string; size: number; created_at: string }>();
  return json({ assets: result.results.map((row) => ({ id: row.id, filename: row.filename, contentType: row.content_type, size: row.size, createdAt: row.created_at, url: `/api/public/media/${row.id}` })) });
}

export async function serveMedia(request: Request, env: Env, assetId: string): Promise<Response> {
  const authenticated = Boolean(await getSession(request, env));
  const asset = await env.CONTENT_DB.prepare(
    `SELECT m.object_key,m.content_type FROM media_assets m
      WHERE m.id=?1 AND m.deleted_at IS NULL AND (
        ?2=1 OR EXISTS (
          SELECT 1 FROM public_snapshot_media sm
          JOIN public_snapshots s ON s.id=sm.snapshot_id
          JOIN posts p ON p.public_snapshot_id=s.id AND p.public_visible=1 AND p.deleted_at IS NULL
          JOIN repositories r ON r.id=s.repository_id AND r.visibility!='private'
          WHERE sm.asset_id=m.id
        )
      )`,
  ).bind(assetId, authenticated ? 1 : 0).first<{ object_key: string; content_type: string }>();
  if (!asset) return new Response('Not found', { status: 404 });
  const rangeHeader = request.headers.get('range');
  const object = rangeHeader
    ? await env.SITE_MEDIA.get(asset.object_key, { range: request.headers })
    : await env.SITE_MEDIA.get(asset.object_key);
  if (!object || !('body' in object)) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('accept-ranges', 'bytes');
  if (rangeHeader && !validByteRange(rangeHeader, object.size)) {
    headers.set('content-range', `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  const rangeOffset = object.range && 'offset' in object.range ? object.range.offset : undefined;
  const rangeLength = object.range && 'length' in object.range ? object.range.length : undefined;
  if (typeof rangeOffset === 'number' && typeof rangeLength === 'number') {
    headers.set('content-range', `bytes ${rangeOffset}-${rangeOffset + rangeLength - 1}/${object.size}`);
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status: rangeHeader ? 206 : 200, headers });
}

export async function serveOg(request: Request, env: Env, snapshotId: string): Promise<Response> {
  if (snapshotId === 'default') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#f5f0e8"/><filter id="n"><feTurbulence baseFrequency=".75" numOctaves="3"/><feColorMatrix type="saturate" values="0"/></filter><rect width="1200" height="630" filter="url(#n)" opacity=".025"/><text x="88" y="294" fill="#2a221a" font-family="Georgia,serif" font-size="76">Blog · ysoseri.us</text><text x="91" y="354" fill="#b8522e" font-family="sans-serif" font-size="28">一座可被阅读的写作空间</text></svg>';
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
  }
  const authenticated = Boolean(await getSession(request, env));
  if (!authenticated) {
    const visible = await env.CONTENT_DB.prepare(
      `SELECT 1 AS visible FROM posts p
       JOIN public_snapshots s ON s.id=p.public_snapshot_id
       JOIN repositories r ON r.id=s.repository_id
       WHERE s.id=?1 AND p.public_visible=1 AND p.deleted_at IS NULL AND r.visibility!='private'`,
    ).bind(snapshotId).first<{ visible: number }>();
    if (!visible) return new Response('Not found', { status: 404 });
  }
  const object = await env.BLOG_ARCHIVE.get(`og/${snapshotId}.svg`);
  if (!object || !('body' in object)) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable', etag: object.httpEtag } });
}
