import type { AppBootstrap, PostDetail, Repository, RepositoryWorkspace } from '../shared/types';
import { sha256Hex } from './crypto';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function categoryPath(workspace: RepositoryWorkspace, categoryId: string | null): string[] {
  const byId = new Map(workspace.categories.map((category) => [category.id, category]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current = categoryId ? byId.get(categoryId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function fallbackTree(workspace: RepositoryWorkspace | null): string {
  if (!workspace) return '';
  const postLink = (post: RepositoryWorkspace['posts'][number]) => `<li class="fallback-file"><a href="/${escapeHtml(workspace.repository.key)}/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a>${post.firstPublishedAt ? `<time datetime="${escapeHtml(post.firstPublishedAt)}">${escapeHtml(post.firstPublishedAt.slice(0, 10))}</time>` : ''}</li>`;
  const children = new Map<string | null, typeof workspace.categories>();
  for (const category of workspace.categories) children.set(category.parentId, [...(children.get(category.parentId) ?? []), category]);
  const renderCategories = (parentId: string | null, ancestors: Set<string>): string => (children.get(parentId) ?? []).map((category) => {
    if (ancestors.has(category.id)) return '';
    const next = new Set(ancestors).add(category.id);
    const nested = renderCategories(category.id, next);
    const posts = workspace.posts.filter((post) => post.categoryId === category.id).map(postLink).join('');
    return `<li class="fallback-folder"><span>${escapeHtml(category.name)}</span><ul>${nested}${posts}</ul></li>`;
  }).join('');
  const rootPosts = workspace.posts.filter((post) => post.categoryId === null).map(postLink).join('');
  return `${renderCategories(null, new Set())}${rootPosts}`;
}

function publicFallback(repositories: Repository[], workspace: RepositoryWorkspace | null, post: PostDetail | null, notFound: boolean): string {
  const repositoryLinks = repositories.map((repository) => `<a href="/${escapeHtml(repository.key)}/">${escapeHtml(repository.name)}</a>`).join('');
  const tree = fallbackTree(workspace);
  const displayPath = post && workspace ? [workspace.repository.name, ...categoryPath(workspace, post.categoryId), post.title].join(' / ') : '';
  const article = post
    ? `<article class="markdown-body"><p class="display-path">${escapeHtml(displayPath)}</p><h1>${escapeHtml(post.title)}</h1>${post.html ?? ''}</article>`
    : `<section class="empty-reading"><h1>${notFound ? '文件不存在' : escapeHtml(workspace?.repository.name ?? 'Blog')}</h1><p>${notFound ? '它可能尚未发布、已撤回，或不属于你可以进入的仓库。' : '这里还没有公开文章。'}</p></section>`;
  return `<div class="app-shell server-fallback"><header class="top-chrome"><a href="https://ysoseri.us">ysoseri.us</a><nav>${repositoryLinks}</nav></header><aside class="left-sidebar"><h2>${escapeHtml(workspace?.repository.name ?? 'Blog')}</h2><ul>${tree}</ul></aside><main class="reading-pane">${article}</main></div>`;
}

function manageFallback(authenticated: boolean): string {
  if (!authenticated) return '<main class="auth-page"><section class="auth-card"><p>blog · ysoseri.us</p><h1>进入写作空间</h1><form><label>站内密码<input type="password" autocomplete="current-password" /></label><button type="submit">验证并进入</button></form></section></main>';
  return '<main class="manage-loading"><p>正在恢复写作现场…</p></main>';
}

interface DocumentOptions {
  bootstrap: AppBootstrap;
  title: string;
  description: string;
  canonical: string;
  repositories?: Repository[];
  workspace?: RepositoryWorkspace | null;
  post?: PostDetail | null;
  noindex?: boolean;
  notFound?: boolean;
  status?: number;
  image?: string | null;
}

export async function renderDocument(request: Request, env: Env, options: DocumentOptions): Promise<Response> {
  // Static Assets applies its HTML routing rules to binding requests too.
  // Fetching `/index.html` is therefore a redirect, while `/` resolves the
  // built shell directly and keeps server-rendered routes on their canonical URL.
  const shellUrl = new URL('/', request.url);
  const shellResponse = await env.ASSETS.fetch(new Request(shellUrl, request));
  if (!shellResponse.ok) return new Response('UI assets are not built. Run npm run build.', { status: 503 });
  let html = await shellResponse.text();
  const fallback = options.bootstrap.kind === 'manage'
    ? manageFallback(options.bootstrap.authenticated)
    : publicFallback(options.repositories ?? [], options.workspace ?? null, options.post ?? null, options.notFound ?? false);
  const image = options.image ?? `${env.SITE_ORIGIN}/api/public/og/default.svg`;
  const authenticatedManage = options.bootstrap.kind === 'manage' && options.bootstrap.authenticated;
  const needsKatex = authenticatedManage || Boolean(options.post?.html?.includes('class="katex'));
  const needsHighlight = authenticatedManage || Boolean(options.post?.html?.includes('class="hljs'));
  const head = [
    needsKatex ? '<link id="blog-katex-css" rel="stylesheet" href="/capabilities/katex.min.css">' : '',
    needsHighlight ? '<link id="blog-highlight-css" rel="stylesheet" href="/capabilities/highlight-github.css">' : '',
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    `<link rel="canonical" href="${escapeHtml(options.canonical)}">`,
    options.noindex ? '<meta name="robots" content="noindex,nofollow">' : '',
    `<meta property="og:type" content="${options.post ? 'article' : 'website'}">`,
    `<meta property="og:title" content="${escapeHtml(options.title)}">`,
    `<meta property="og:description" content="${escapeHtml(options.description)}">`,
    `<meta property="og:url" content="${escapeHtml(options.canonical)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    options.post ? `<script type="application/ld+json">${safeJson({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: options.post.title, datePublished: options.post.firstPublishedAt, dateModified: options.post.lastPublishedAt, mainEntityOfPage: options.canonical, image })}</script>` : '',
  ].join('');
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(options.title)}</title>`);
  html = html.replace('</head>', `${head}</head>`);
  html = html.replace(
    /<div id="root">[\s\S]*<\/div>\s*<\/body>/,
    `<div id="root">${fallback}</div><script>window.__BLOG_BOOTSTRAP__=${safeJson(options.bootstrap)}</script></body>`,
  );
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://player.bilibili.com https://open.spotify.com; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  headers.set('cache-control', options.bootstrap.kind === 'manage' ? 'no-store' : 'public, max-age=0, must-revalidate');
  return new Response(html, { status: options.status ?? 200, headers });
}

interface FeedRow {
  title: string; description: string; canonical_url: string; published_at: string; first_published_at: string; object_key: string;
}

function absolutePublicHtml(html: string, origin: string): string {
  return html.replace(/\b(src|href)="\/(?!\/)/g, `$1="${origin}/`);
}

export async function renderFeed(request: Request, env: Env, repositoryKey?: string): Promise<Response> {
  const rows = repositoryKey
    ? await env.CONTENT_DB.prepare(
      `SELECT s.title,s.description,s.canonical_url,s.published_at,s.first_published_at,s.object_key
       FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id JOIN repositories r ON r.id=s.repository_id
       WHERE p.public_visible=1 AND r.visibility='public' AND s.public_repository_key=?1 ORDER BY s.published_at DESC LIMIT 100`,
    ).bind(repositoryKey).all<FeedRow>()
    : await env.CONTENT_DB.prepare(
      `SELECT s.title,s.description,s.canonical_url,s.published_at,s.first_published_at,s.object_key
       FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id JOIN repositories r ON r.id=s.repository_id
       WHERE p.public_visible=1 AND r.visibility='public' ORDER BY s.published_at DESC LIMIT 100`,
    ).all<FeedRow>();
  const items: string[] = [];
  for (const row of rows.results) {
    const object = await env.BLOG_ARCHIVE.get(row.object_key);
    if (!object) continue;
    const snapshot = await object.json<{ html: string }>();
    const safeHtml = absolutePublicHtml(snapshot.html, env.SITE_ORIGIN).replaceAll(']]>', ']]&gt;');
    items.push(`<item><title>${escapeHtml(row.title)}</title><link>${escapeHtml(row.canonical_url)}</link><guid isPermaLink="true">${escapeHtml(row.canonical_url)}</guid><pubDate>${new Date(row.first_published_at).toUTCString()}</pubDate><description><![CDATA[${safeHtml}]]></description></item>`);
  }
  const title = repositoryKey ? `ysoseri Blog · ${repositoryKey}` : 'ysoseri Blog';
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeHtml(title)}</title><link>${env.SITE_ORIGIN}</link><description>ysoseri 的公开写作</description>${items.join('')}</channel></rss>`;
  return conditionalText(request, xml, 'application/rss+xml; charset=utf-8');
}

export async function renderSitemap(request: Request, env: Env): Promise<Response> {
  const rows = await env.CONTENT_DB.prepare(
    `SELECT s.canonical_url,s.published_at FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id
     JOIN repositories r ON r.id=s.repository_id WHERE p.public_visible=1 AND r.visibility='public' ORDER BY s.published_at DESC`,
  ).all<{ canonical_url: string; published_at: string }>();
  const repositories = await env.CONTENT_DB.prepare("SELECT url_key,updated_at FROM repositories WHERE visibility='public'").all<{ url_key: string; updated_at: string }>();
  const urls = [`<url><loc>${env.SITE_ORIGIN}/</loc></url>`, ...repositories.results.map((row) => `<url><loc>${env.SITE_ORIGIN}/${escapeHtml(row.url_key)}/</loc><lastmod>${row.updated_at.slice(0, 10)}</lastmod></url>`), ...rows.results.map((row) => `<url><loc>${escapeHtml(row.canonical_url)}</loc><lastmod>${row.published_at.slice(0, 10)}</lastmod></url>`)].join('');
  return conditionalText(request, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'application/xml; charset=utf-8');
}

async function conditionalText(request: Request, body: string, contentType: string): Promise<Response> {
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { headers: { 'content-type': contentType, 'cache-control': 'public, max-age=0, must-revalidate', etag } });
}

export function renderRobots(env: Env): Response {
  return new Response(`User-agent: *\nDisallow: /manage\nDisallow: /api/manage\nDisallow: /api/auth\nSitemap: ${env.SITE_ORIGIN}/sitemap.xml\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
