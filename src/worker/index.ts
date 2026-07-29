import type { InterfaceLanguage, ManageBootstrap, PostDetail, PublicBootstrap, Repository, RepositoryWorkspace } from '../shared/types';
import { handleApi } from './api';
import { getSession } from './auth';
import { getManagePost, getPublicPostByPath, getRepositoryByKey, getWorkspace, listRepositories, resolveRedirect } from './data';
import { errorResponse } from './http';
import { pruneAutoVersions, retryObjectDeletionQueue } from './maintenance';
import { retryDeletionJobs } from './management';
import { publishDuePosts } from './publishing';
import { processOutbox, reconcileSearchIndexes } from './search';
import { renderDocument, renderFeed, renderRobots, renderSitemap } from './seo';
import { startDailyBackup } from './backup';
import { cleanupAbandonedImportMedia } from './importer';

export { BlogBackupWorkflow } from './backup';

function interfaceLanguage(request: Request): InterfaceLanguage {
  const cookie = request.headers.get('cookie') ?? '';
  if (/(?:^|;\s*)blog-lang=en(?:;|$)/.test(cookie)) return 'en';
  return 'zh';
}

async function publicPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const isRoot = parts.length === 0;
  const lang = interfaceLanguage(request);
  const publicRepositories = await listRepositories(env, false);
  let repositories = publicRepositories;
  let repository: Repository | null = null;
  let workspace: RepositoryWorkspace | null = null;
  let activePost: PostDetail | null = null;
  let notFound = false;
  let status = 200;
  if (parts.length === 0) {
    repository = publicRepositories[0] ?? null;
    workspace = repository ? await getWorkspace(env, repository, false) : null;
  } else if (parts.length <= 2) {
    repository = await getRepositoryByKey(env, parts[0] ?? '', false);
    if (repository && !repositories.some((item) => item.id === repository?.id)) repositories = [...repositories, repository];
    workspace = repository ? await getWorkspace(env, repository, false) : null;
    if (repository && parts.length === 2 && parts[1]) activePost = await getPublicPostByPath(env, repository.key, parts[1]);
    if (!repository || (parts.length === 2 && !activePost)) {
      const [redirect, tombstone] = await Promise.all([
        resolveRedirect(env, url.pathname),
        env.CONTENT_DB.prepare('SELECT path,deleted_at FROM deleted_urls WHERE path=?1')
          .bind(url.pathname).first<{ path: string; deleted_at: string }>(),
      ]);
      if (redirect && (!tombstone || redirect.createdAt > tombstone.deleted_at)) {
        return Response.redirect(redirect.location, 301);
      }
      notFound = true;
      status = tombstone ? 410 : 404;
    }
  } else {
    notFound = true;
    status = 404;
  }
  if (!notFound && repository && !isRoot) {
    const canonicalPath = activePost ? `/${repository.key}/${activePost.slug}` : `/${repository.key}/`;
    if (url.pathname !== canonicalPath) return Response.redirect(new URL(canonicalPath, env.SITE_ORIGIN).toString(), 301);
  } else if (!notFound && !repository && !isRoot) {
    return Response.redirect(new URL('/', env.SITE_ORIGIN).toString(), 301);
  }
  const canonical = isRoot
    ? env.SITE_ORIGIN
    : activePost && repository
      ? `${env.SITE_ORIGIN}/${repository.key}/${activePost.slug}`
      : repository
        ? `${env.SITE_ORIGIN}/${repository.key}/`
        : env.SITE_ORIGIN;
  const bootstrap: PublicBootstrap = { kind: 'public', lang, repositories, workspace, activePost, canonical, authenticated: false, notFound };
  const snapshotMeta = activePost
    ? await env.CONTENT_DB.prepare(
      `SELECT s.cover_url,s.description FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id WHERE p.id=?1`,
    ).bind(activePost.id).first<{ cover_url: string | null; description: string }>()
    : null;
  return renderDocument(request, env, {
    bootstrap, repositories, workspace, post: activePost, notFound, status,
    title: isRoot
      ? 'Blog · ysoseri.us'
      : activePost && repository
        ? `${activePost.title} · ${repository.name} · ysoseri.us`
        : repository
          ? `${repository.name} · Blog · ysoseri.us`
          : 'Blog · ysoseri.us',
    description: snapshotMeta?.description ?? (notFound ? '文件不存在' : 'ysoseri 的个人写作空间'),
    canonical, image: snapshotMeta?.cover_url, noindex: notFound || repository?.visibility === 'unlisted',
  });
}

async function managePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const session = await getSession(request, env);
  let repositories: Repository[] = [];
  let workspace: RepositoryWorkspace | null = null;
  let activePost: PostDetail | null = null;
  const directPostId = parts[1] === 'posts' ? parts[2] : undefined;
  if (session) {
    repositories = await listRepositories(env, true);
    activePost = directPostId ? await getManagePost(env, directPostId) : null;
    const repository = activePost
      ? repositories.find((item) => item.id === activePost?.repositoryId) ?? null
      : repositories[0] ?? null;
    workspace = repository ? await getWorkspace(env, repository, true) : null;
  }
  const bootstrap: ManageBootstrap = {
    kind: 'manage', lang: interfaceLanguage(request), authenticated: Boolean(session), csrfToken: session?.csrfToken ?? null,
    repositories, workspace, activePost, directPostId,
  };
  return renderDocument(request, env, {
    bootstrap, title: '管理 · Blog · ysoseri.us', description: 'Blog 作者管理工作区', canonical: `${env.SITE_ORIGIN}/manage`, noindex: true,
  });
}

function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') || pathname.startsWith('/fonts/') || pathname.startsWith('/capabilities/') || pathname === '/favicon.svg' || pathname === '/manifest.webmanifest';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (isStaticAsset(url.pathname)) return env.ASSETS.fetch(request);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, ctx);
      if (url.pathname === '/feed.xml') return await renderFeed(request, env);
      const repositoryFeed = url.pathname.match(/^\/([a-z0-9-]+)\/feed\.xml$/);
      if (repositoryFeed?.[1]) return await renderFeed(request, env, repositoryFeed[1]);
      if (url.pathname === '/sitemap.xml') return await renderSitemap(request, env);
      if (url.pathname === '/robots.txt') return renderRobots(env);
      if (url.pathname === '/manage' || url.pathname.startsWith('/manage/')) return await managePage(request, env);
      return await publicPage(request, env);
    } catch (error) {
      return errorResponse(error, request);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tasks = [publishDuePosts(env, ctx), processOutbox(env), retryDeletionJobs(env), retryObjectDeletionQueue(env), cleanupAbandonedImportMedia(env)];
    if (controller.cron === '0 3 * * *') tasks.push(pruneAutoVersions(env), reconcileSearchIndexes(env), startDailyBackup(env, controller.scheduledTime));
    ctx.waitUntil(Promise.all(tasks).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
