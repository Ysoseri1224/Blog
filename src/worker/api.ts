import { z } from 'zod';
import { categoryCreateSchema, loginSchema, postCreateSchema, postSaveSchema, repositoryCreateSchema, repositoryUpdateSchema, scheduleSchema, slugSchema } from '../shared/schemas';
import type { ManageBootstrap } from '../shared/types';
import { changePassword, getSession, login, logout, reauthenticate, requireSession } from './auth';
import { getManagePost, getPublicPostByPath, getRepositoryById, getRepositoryByKey, getWorkspace, listRecentPublicPosts, listRepositories } from './data';
import { HttpError, json, methodNotAllowed, parseJson } from './http';
import { commitImport, exportPostMarkdown, previewImport } from './importer';
import { createCategory, createRepository, deleteCategory, deletePostPermanently, deleteRepository, updateCategory, updateRepository } from './management';
import { listMedia, serveMedia, serveOg, uploadMedia } from './media';
import { renderMarkdown } from './markdown';
import { resolveWikiTargets } from './linking';
import { createManualVersion, createPost, getVersion, listVersions, publishPost, restoreVersion, savePost, schedulePost, withdrawPost } from './publishing';
import { searchPosts } from './search';

const reauthSchema = z.object({ password: z.string().min(1).max(512) });
const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(512), newPassword: z.string().min(10).max(512) });
const categoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), parentId: z.string().uuid().nullable().optional() }).refine((value) => Object.keys(value).length > 0);
const previewSchema = z.object({ markdown: z.string().max(2_000_000) });
const restoreSchema = z.object({ versionId: z.string().uuid(), baseRevision: z.number().int().nonnegative() });
const deleteRepositorySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), targetRepositoryId: z.string().uuid() }), z.object({ action: z.literal('delete') }),
]);
const importPreviewSchema = z.object({
  repositoryId: z.string().uuid(), categoryId: z.string().uuid().nullable().optional(),
  files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(2_000_000) })).max(100),
  attachments: z.array(z.object({ path: z.string().min(1).max(500), assetId: z.string().uuid().optional() })).max(500),
});
const importItemSchema = z.object({
  key: z.string().uuid(), path: z.string().min(1).max(500), directory: z.string().max(500), title: z.string().min(1).max(240),
  slug: slugSchema, language: z.string().min(2).max(35), summary: z.string().max(2000).nullable(), tags: z.array(z.string().min(1).max(80)).max(80),
  coverAssetId: z.string().uuid().nullable(), customProperties: z.record(z.string(), z.unknown()), markdown: z.string().max(2_000_000),
  missingAttachments: z.array(z.string().max(500)).max(500), resolvedAttachments: z.record(z.string(), z.string().uuid()),
  attachmentMatches: z.record(z.string(), z.string().max(500)),
  duplicateCandidates: z.array(z.object({ postId: z.string().uuid(), title: z.string(), reason: z.string() })).max(20),
  exportedPostId: z.string().nullable(), exportSignature: z.string().nullable(), exportedPostIdVerified: z.boolean(),
  publishedTimeCandidate: z.object({
    field: z.enum(['date','published']), raw: z.string(), parsedAt: z.string().datetime().nullable(),
    timezone: z.string().nullable(), issue: z.string().nullable(),
  }).nullable(), slugConflict: z.boolean(),
});
const importCommitSchema = z.object({
  batchId: z.string().uuid(), repositoryId: z.string().uuid(), categoryId: z.string().uuid().nullable().optional(),
  items: z.array(importItemSchema.and(z.object({ action: z.enum(['new','update','skip']), targetPostId: z.string().uuid().optional(), preserveFirstPublishedAt: z.string().datetime({ offset: true }).nullable().optional() }))).max(100),
});

async function manageBootstrap(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const repositories = await listRepositories(env, true);
  const requested = url.searchParams.get('repository');
  const repository = requested ? await getRepositoryById(env, requested) : repositories[0] ?? null;
  const workspace = repository ? await getWorkspace(env, repository, true) : null;
  const postId = url.searchParams.get('post');
  const activePost = postId ? await getManagePost(env, postId) : null;
  const bootstrap: ManageBootstrap = { kind: 'manage', lang: 'zh', authenticated: true, csrfToken: session.csrfToken, repositories, workspace, activePost };
  return json(bootstrap);
}

async function authApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/auth/session') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const session = await getSession(request, env);
    return json({ authenticated: Boolean(session), csrfToken: session?.csrfToken ?? null, expiresAt: session?.expiresAt ?? null });
  }
  if (path === '/api/auth/login') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const input = await parseJson(request, loginSchema);
    const session = await login(request, env, input.password);
    return json({ authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { headers: { 'set-cookie': session.cookie } });
  }
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireSession(request, env, { csrf: true });
    return json({ authenticated: false }, { headers: { 'set-cookie': await logout(request, env) } });
  }
  if (path === '/api/auth/reauth') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const input = await parseJson(request, reauthSchema);
    return json({ reauthenticatedUntil: await reauthenticate(request, env, input.password) });
  }
  if (path === '/api/auth/password') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    const input = await parseJson(request, passwordChangeSchema);
    await changePassword(request, env, input.currentPassword, input.newPassword);
    return json({ changed: true, authenticated: false }, { headers: { 'set-cookie': await logout(request, env) } });
  }
  throw new HttpError(404, '接口不存在', 'api_not_found');
}

async function publicApi(request: Request, env: Env, path: string): Promise<Response> {
  const mediaMatch = path.match(/^\/api\/public\/media\/([0-9a-f-]{36})$/i);
  if (mediaMatch?.[1]) {
    if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed(['GET', 'HEAD']);
    return serveMedia(request, env, mediaMatch[1]);
  }
  const ogMatch = path.match(/^\/api\/public\/og\/([0-9a-f-]{36}|default)\.svg$/i);
  if (ogMatch?.[1]) return serveOg(request, env, ogMatch[1]);
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(request.url);
  if (path === '/api/public/workspace') {
    const key = url.searchParams.get('repository');
    if (!key) throw new HttpError(400, '缺少仓库 key', 'missing_repository');
    const repository = await getRepositoryByKey(env, key, false);
    if (!repository) throw new HttpError(404, '仓库不存在', 'repository_not_found');
    return json(await getWorkspace(env, repository, false));
  }
  if (path === '/api/public/post') {
    const repository = url.searchParams.get('repository');
    const slug = url.searchParams.get('slug');
    if (!repository || !slug) throw new HttpError(400, '缺少文章路径', 'missing_post_path');
    const post = await getPublicPostByPath(env, repository, slug);
    if (!post) throw new HttpError(404, '文件不存在', 'post_not_found');
    return json(post);
  }
  if (path === '/api/public/search') {
    const repositoryKey = url.searchParams.get('repository') ?? '';
    const query = url.searchParams.get('q') ?? '';
    const repository = await getRepositoryByKey(env, repositoryKey, false);
    if (!repository) throw new HttpError(404, '仓库不存在', 'repository_not_found');
    return json({ results: await searchPosts(env, repository.id, query, false) });
  }
  if (path === '/api/public/recent') {
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '1', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(6, requestedLimit)) : 1;
    const response = json({ posts: await listRecentPublicPosts(env, limit) });
    response.headers.set('access-control-allow-origin', '*');
    response.headers.set('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return response;
  }
  throw new HttpError(404, '接口不存在', 'api_not_found');
}

async function manageApi(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const needsCsrf = !['GET', 'HEAD'].includes(request.method);
  await requireSession(request, env, { csrf: needsCsrf });
  const url = new URL(request.url);
  if (path === '/api/manage/bootstrap') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return manageBootstrap(request, env);
  }
  if (path === '/api/manage/search') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const repositoryId = url.searchParams.get('repository') ?? '';
    if (!(await getRepositoryById(env, repositoryId))) throw new HttpError(404, '仓库不存在', 'repository_not_found');
    return json({ results: await searchPosts(env, repositoryId, url.searchParams.get('q') ?? '', true) });
  }
  if (path === '/api/manage/preview') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const input = await parseJson(request, previewSchema);
    return json(await renderMarkdown(input.markdown, { wikiTargets: await resolveWikiTargets(env, input.markdown, false) }));
  }
  if (path === '/api/manage/import/preview') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return json(await previewImport(env, await parseJson(request, importPreviewSchema)));
  }
  if (path === '/api/manage/import/commit') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return json(await commitImport(env, ctx, await parseJson(request, importCommitSchema)), { status: 201 });
  }
  if (path === '/api/manage/media') {
    if (request.method === 'GET') return listMedia(env, url.searchParams.get('q') ?? '');
    if (request.method === 'PUT') return uploadMedia(request, env);
    return methodNotAllowed(['GET', 'PUT']);
  }
  if (path === '/api/manage/repositories') {
    if (request.method === 'GET') return json({ repositories: await listRepositories(env, true) });
    if (request.method === 'POST') return json({ repository: await createRepository(env, await parseJson(request, repositoryCreateSchema)) }, { status: 201 });
    return methodNotAllowed(['GET', 'POST']);
  }
  const repositoryMatch = path.match(/^\/api\/manage\/repositories\/([0-9a-f-]{36})$/i);
  if (repositoryMatch?.[1]) {
    if (request.method === 'PATCH') return json({ repository: await updateRepository(env, ctx, repositoryMatch[1], await parseJson(request, repositoryUpdateSchema)) });
    if (request.method === 'DELETE') {
      await requireSession(request, env, { csrf: true, stepUp: true });
      await deleteRepository(env, ctx, repositoryMatch[1], await parseJson(request, deleteRepositorySchema));
      return json({ deleted: true });
    }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }
  if (path === '/api/manage/categories') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return json({ category: await createCategory(env, await parseJson(request, categoryCreateSchema)) }, { status: 201 });
  }
  const categoryMatch = path.match(/^\/api\/manage\/categories\/([0-9a-f-]{36})$/i);
  if (categoryMatch?.[1]) {
    if (request.method === 'PATCH') return json({ category: await updateCategory(env, categoryMatch[1], await parseJson(request, categoryUpdateSchema)) });
    if (request.method === 'DELETE') { await deleteCategory(env, categoryMatch[1]); return json({ deleted: true }); }
    return methodNotAllowed(['PATCH', 'DELETE']);
  }
  if (path === '/api/manage/posts') {
    if (request.method === 'POST') return json({ post: await createPost(env, await parseJson(request, postCreateSchema)) }, { status: 201 });
    return methodNotAllowed(['POST']);
  }
  const postMatch = path.match(/^\/api\/manage\/posts\/([0-9a-f-]{36})$/i);
  if (postMatch?.[1]) {
    if (request.method === 'GET') {
      const post = await getManagePost(env, postMatch[1]);
      if (!post) throw new HttpError(404, '文章不存在', 'post_not_found');
      return json({ post });
    }
    if (request.method === 'PUT') return json({ post: await savePost(env, ctx, postMatch[1], await parseJson(request, postSaveSchema)) });
    if (request.method === 'DELETE') {
      await requireSession(request, env, { csrf: true, stepUp: true });
      await deletePostPermanently(env, postMatch[1]);
      return json({ deleted: true });
    }
    return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  }
  const actionMatch = path.match(/^\/api\/manage\/posts\/([0-9a-f-]{36})\/(publish|schedule|withdraw|versions|restore|export)$/i);
  if (actionMatch?.[1] && actionMatch[2]) {
    const [, postId, action] = actionMatch;
    if (action === 'publish' && request.method === 'POST') return json({ post: await publishPost(env, ctx, postId) });
    if (action === 'schedule' && request.method === 'POST') return json({ post: await schedulePost(env, postId, await parseJson(request, scheduleSchema)) });
    if (action === 'withdraw' && request.method === 'POST') {
      await requireSession(request, env, { csrf: true, stepUp: true });
      return json({ post: await withdrawPost(env, postId) });
    }
    if (action === 'versions' && request.method === 'GET') return json({ versions: await listVersions(env, postId) });
    if (action === 'versions' && request.method === 'POST') return json({ versionId: await createManualVersion(env, postId) }, { status: 201 });
    if (action === 'export' && request.method === 'GET') {
      const exported = await exportPostMarkdown(env, postId);
      return new Response(exported.body, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${exported.filename}"`,
          'cache-control': 'no-store',
        },
      });
    }
    if (action === 'restore' && request.method === 'POST') {
      const input = await parseJson(request, restoreSchema);
      return json({ post: await restoreVersion(env, ctx, postId, input.versionId, input.baseRevision) });
    }
    return methodNotAllowed(action === 'versions' ? ['GET', 'POST'] : action === 'export' ? ['GET'] : ['POST']);
  }
  const versionMatch = path.match(/^\/api\/manage\/posts\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/i);
  if (versionMatch?.[1] && versionMatch[2]) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json({ version: await getVersion(env, versionMatch[1], versionMatch[2]) });
  }
  throw new HttpError(404, '接口不存在', 'api_not_found');
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  if (path.startsWith('/api/auth/')) return authApi(request, env, path);
  if (path.startsWith('/api/public/')) return publicApi(request, env, path);
  if (path.startsWith('/api/manage/')) return manageApi(request, env, ctx, path);
  throw new HttpError(404, '接口不存在', 'api_not_found');
}
