import { describe, expect, it } from 'vitest';
import type { Category, PostDetail } from '../src/shared/types';
import { sha256Hex } from '../src/worker/crypto';
import { authorRequest, jsonBody, login, workerRequest } from './helpers';

const lifeRepositoryId = '11111111-1111-4111-8111-111111111111';

describe('无 JavaScript HTML 与 SEO 出口', () => {
  it('根路径保留公共工作区 URL，并在首屏输出真实仓库链接', async () => {
    const root = await workerRequest('/', { redirect: 'manual' });
    expect(root.status).toBe(200);
    expect(root.headers.get('location')).toBeNull();
    const html = await root.text();
    expect(html).toContain('window.__BLOG_BOOTSTRAP__');
    expect(html).toContain('<link rel="canonical" href="https://blog.ysoseri.us">');
    expect(html).toContain('href="/life/"');
  });

  it('输出递归分类、完整显示路径、快照元数据和可重新验证的出口', async () => {
    const session = await login();
    const mediaBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 83, 83, 82]);
    const mediaResponse = await authorRequest(session, '/api/manage/media', {
      method: 'PUT',
      headers: {
        'content-type': 'image/png', 'content-length': String(mediaBytes.byteLength),
        'x-file-name': 'rss-media.png', 'x-file-sha256': await sha256Hex(mediaBytes.buffer),
      },
      body: mediaBytes.buffer.slice(mediaBytes.byteOffset, mediaBytes.byteOffset + mediaBytes.byteLength) as ArrayBuffer,
    });
    const mediaId = (await jsonBody<{ asset: { id: string } }>(mediaResponse)).asset.id;
    const embedCreate = await authorRequest(session, '/api/manage/posts', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: null, title: 'SSR 嵌入目标', language: 'zh-CN' }),
    });
    const embedDraft = (await jsonBody<{ post: PostDetail }>(embedCreate)).post;
    const embedSave = await authorRequest(session, `/api/manage/posts/${embedDraft.id}`, {
      method: 'PUT', body: JSON.stringify({
        baseRevision: embedDraft.revision, title: 'SSR 嵌入目标', slug: 'runtime-ssr-embed-target', repositoryId: lifeRepositoryId,
        categoryId: null, language: 'zh-CN', summary: null, markdown: '# 被嵌入正文\n\n这是公开快照中的嵌入内容。',
        tags: [], featured: false, coverAssetId: null, customProperties: {},
      }),
    });
    const embedSaved = (await jsonBody<{ post: PostDetail }>(embedSave)).post;
    expect((await authorRequest(session, `/api/manage/posts/${embedSaved.id}/publish`, { method: 'POST' })).status).toBe(200);
    const parentResponse = await authorRequest(session, '/api/manage/categories', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, parentId: null, name: 'SSR 父分类' }),
    });
    const parent = (await jsonBody<{ category: Category }>(parentResponse)).category;
    const childResponse = await authorRequest(session, '/api/manage/categories', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, parentId: parent.id, name: 'SSR 子分类' }),
    });
    const child = (await jsonBody<{ category: Category }>(childResponse)).category;
    const createResponse = await authorRequest(session, '/api/manage/posts', {
      method: 'POST', body: JSON.stringify({ repositoryId: lifeRepositoryId, categoryId: child.id, title: 'SSR 边界文章', language: 'zh-CN' }),
    });
    const created = (await jsonBody<{ post: PostDetail }>(createResponse)).post;
    const saveResponse = await authorRequest(session, `/api/manage/posts/${created.id}`, {
      method: 'PUT', body: JSON.stringify({
        baseRevision: created.revision, title: 'SSR 边界文章', slug: 'runtime-ssr-seo', repositoryId: lifeRepositoryId,
        categoryId: child.id, language: 'zh-CN', summary: '确定的 SSR 摘要',
        markdown: `# 正文标题\n\n可抓取的完整正文。\n\n![[SSR 嵌入目标]]\n\n[[缺失目标]]\n\n![RSS 图片](media://${mediaId})\n\n::embed[来源视频]{url="https://www.youtube.com/watch?v=source-test"}\n\n<video controls src="https://tracker.example/video.mp4"></video>`,
        tags: ['ssr'], featured: false, coverAssetId: null, customProperties: {},
      }),
    });
    const saved = (await jsonBody<{ post: PostDetail }>(saveResponse)).post;
    expect((await authorRequest(session, `/api/manage/posts/${saved.id}/publish`, { method: 'POST' })).status).toBe(200);

    const articleResponse = await workerRequest('/life/runtime-ssr-seo');
    expect(articleResponse.status).toBe(200);
    const html = await articleResponse.text();
    expect(html).toContain('<li class="fallback-folder"><span>SSR 父分类</span>');
    expect(html).toContain('<li class="fallback-folder"><span>SSR 子分类</span>');
    expect(html.indexOf('SSR 父分类')).toBeLessThan(html.indexOf('SSR 子分类'));
    expect(html).toContain('<p class="display-path">生活碎片 / SSR 父分类 / SSR 子分类 / SSR 边界文章</p>');
    expect(html).toContain('<h1>SSR 边界文章</h1>');
    expect(html).toContain('可抓取的完整正文');
    expect(html).toContain('article-embed-expanded');
    expect(html).toContain('这是公开快照中的嵌入内容');
    expect(html).toContain('未解析');
    expect(html).toContain('文章嵌入');
    expect(html).toContain('class="embed-consent"');
    expect(html).toContain('YouTube · www.youtube.com · 点击后加载');
    expect(html).not.toContain('<a href="http://www.youtube.com">');
    expect(html).toContain('点击后加载');
    expect(html).toContain('媒体地址未使用站内受控资源，已停止加载');
    expect(html).not.toContain('tracker.example');
    expect(html).toContain('<link rel="canonical" href="https://blog.ysoseri.us/life/runtime-ssr-seo">');
    expect(html).toContain('<meta property="og:title" content="SSR 边界文章 · 生活碎片 · ysoseri.us">');
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).not.toContain('noindex,nofollow');

    const englishHtml = await (await workerRequest('/life/runtime-ssr-seo', { headers: { cookie: 'blog-lang=en' } })).text();
    expect(englishHtml).toContain('<html lang="en"');
    expect(englishHtml).toContain('Unresolved');
    expect(englishHtml).toContain('Embedded article');
    expect(englishHtml).toContain('Click to load');
    expect(englishHtml).toContain('This media URL is not a managed site asset, so loading was blocked.');
    expect(englishHtml).not.toContain('>未解析</small>');
    expect(englishHtml).not.toContain('>文章嵌入</span>');
    expect(englishHtml).not.toContain(' · 点击后加载</span>');
    expect(englishHtml).toContain('可抓取的完整正文');

    const trailingSlash = await workerRequest('/life/runtime-ssr-seo/', { redirect: 'manual' });
    expect(trailingSlash.status).toBe(301);
    expect(trailingSlash.headers.get('location')).toBe('https://blog.ysoseri.us/life/runtime-ssr-seo');
    const missingRepositorySlash = await workerRequest('/life', { redirect: 'manual' });
    expect(missingRepositorySlash.status).toBe(301);
    expect(missingRepositorySlash.headers.get('location')).toBe('https://blog.ysoseri.us/life/');

    const directoryHtml = await (await workerRequest('/life/')).text();
    expect(directoryHtml).toContain('href="/life/runtime-ssr-seo"');
    expect(directoryHtml).toContain('SSR 父分类');

    const sitemap = await workerRequest('/sitemap.xml');
    const sitemapEtag = sitemap.headers.get('etag');
    expect(await sitemap.text()).toContain('https://blog.ysoseri.us/life/runtime-ssr-seo');
    expect(sitemapEtag).toBeTruthy();
    expect((await workerRequest('/sitemap.xml', { headers: { 'if-none-match': sitemapEtag! } })).status).toBe(304);

    const feed = await workerRequest('/feed.xml');
    const feedEtag = feed.headers.get('etag');
    const feedXml = await feed.text();
    expect(feedXml).toContain('<title>SSR 边界文章</title>');
    expect(feedXml).toContain('可抓取的完整正文');
    expect(feedXml).toContain(`src="https://blog.ysoseri.us/api/public/media/${mediaId}"`);
    expect(feedXml).toContain('href="https://www.youtube.com/watch?v=source-test"');
    expect(feedXml).not.toContain('<iframe');
    expect(feedXml).not.toContain('tracker.example');
    expect((await workerRequest('/feed.xml', { headers: { 'if-none-match': feedEtag! } })).status).toBe(304);
  });
});
