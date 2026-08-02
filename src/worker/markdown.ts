import { defaultSchema, type Schema } from 'hast-util-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Element, Root, RootContent } from 'hast';

export interface MarkdownResult {
  html: string;
  text: string;
  description: string;
  headings: Array<{ depth: number; text: string; id: string }>;
  links: string[];
  wordCount: number;
  characterCount: number;
  readingMinutes: number;
}

interface MarkdownOptions {
  wikiTargets?: ReadonlyMap<string, { url: string; title: string; html?: string } | null>;
  headingPrefix?: string;
  syntaxHighlight?: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function slugify(value: string): string {
  const slug = value.toLocaleLowerCase().trim().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').replace(/[\s_-]+/g, '-').replace(/^-|-$/g, '');
  return slug || `section-${Array.from(value).length}`;
}

function normalizeWikiLinks(markdown: string, targets: ReadonlyMap<string, { url: string; title: string; html?: string } | null>): string {
  let inFence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return line;
    return line.replace(/(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_match, embed: string, targetRaw: string, headingRaw: string | undefined, labelRaw: string | undefined) => {
      const target = targetRaw.trim();
      const resolved = targets.get(target) ?? null;
      const label = (labelRaw || resolved?.title || target).trim();
      if (!resolved) return `<span class="unresolved-link" data-target="${escapeHtml(target)}">${escapeHtml(label)} <span data-ui="unresolved">未解析</span></span>`;
      const url = `${resolved.url}${headingRaw ? `#${encodeURIComponent(slugify(headingRaw))}` : ''}`;
      if (embed) return resolved.html
        ? `<aside class="article-embed article-embed-expanded"><header><a href="${escapeHtml(url)}">${escapeHtml(label)}</a><span data-ui="article-embed">文章嵌入</span></header><section class="embedded-markdown">${resolved.html}</section></aside>`
        : `<aside class="article-embed"><a href="${escapeHtml(url)}">${escapeHtml(label)}</a><span data-ui="article-embed">文章嵌入</span></aside>`;
      return `[${label.replaceAll(']', '\\]')}](${url})`;
    });
  }).join('\n');
}

function normalizeCallouts(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^>\s*\[!([\w-]+)\]([+-])?\s*(.*)$/i);
    if (!match) {
      output.push(lines[index] ?? '');
      continue;
    }
    const [, type = 'note', fold = '', title = type] = match;
    const body: string[] = [];
    while (index + 1 < lines.length && /^>/.test(lines[index + 1] ?? '')) {
      index += 1;
      body.push((lines[index] ?? '').replace(/^>\s?/, ''));
    }
    const open = fold !== '-';
    output.push(`<details class="callout callout-${escapeHtml(type.toLowerCase())}"${open ? ' open' : ''}><summary>${escapeHtml(title || type)}</summary>\n\n${body.join('\n')}\n\n</details>`);
  }
  return output.join('\n');
}

const providerHosts = new Map([
  ['www.youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['www.bilibili.com', 'Bilibili'],
  ['vimeo.com', 'Vimeo'], ['open.spotify.com', 'Spotify'],
]);

function normalizeEmbeds(markdown: string): string {
  return markdown.replace(/^::embed\[([^\]]*)\]\{url="([^"]+)"\}\s*$/gm, (_match, labelRaw: string, urlRaw: string) => {
    try {
      const url = new URL(urlRaw);
      const provider = providerHosts.get(url.hostname);
      if (!provider || url.protocol !== 'https:') return `[${labelRaw || url.hostname}](${url.toString()})`;
      return `<a class="embed-consent" href="${escapeHtml(url.toString())}" data-provider="${provider}" data-url="${escapeHtml(url.toString())}"><strong>${escapeHtml(labelRaw || provider)}</strong><span data-ui="embed-consent-hint">${escapeHtml(provider)} · 点击后加载</span></a>`;
    } catch {
      return escapeHtml(labelRaw || urlRaw);
    }
  });
}

function preprocess(markdown: string, options: MarkdownOptions): string {
  const mediaResolved = markdown.replace(/media:\/\/([0-9a-f-]{36})/gi, '/api/public/media/$1');
  return normalizeEmbeds(normalizeCallouts(normalizeWikiLinks(mediaResolved, options.wikiTargets ?? new Map()))).replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}

const schema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []), 'audio', 'video', 'source', 'details', 'summary', 'kbd', 'mark', 'abbr', 'figure', 'figcaption', 'button', 'aside', 'span',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'id', 'title', 'ariaLabel', 'ariaHidden', 'role', 'dataUi'],
    a: [...(defaultSchema.attributes?.a ?? []).filter((attribute) => !(Array.isArray(attribute) && attribute[0] === 'className')), 'className', 'target', 'rel', 'dataProvider', 'dataUrl'],
    button: ['type', 'className', 'dataProvider', 'dataUrl', 'ariaLabel'],
    span: ['className', 'dataTarget', 'dataUi', 'ariaHidden'],
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/]],
    audio: ['controls', 'preload', 'src'],
    video: ['controls', 'preload', 'src', 'poster', 'width', 'height'],
    source: ['src', 'type'],
    details: ['open', 'className'],
    aside: ['className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
};

function restoreEmbedConsentHints() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'a' || typeof node.properties.dataProvider !== 'string' || typeof node.properties.dataUrl !== 'string') return;
      const hint = node.children.find((child): child is Element => child.type === 'element' && child.tagName === 'span' && child.properties.dataUi === 'embed-consent-hint');
      if (!hint) return;
      try {
        const hostname = new URL(node.properties.dataUrl).hostname;
        hint.children = [{ type: 'text', value: `${node.properties.dataProvider} · ${hostname} · 点击后加载` }];
      } catch { /* 非法 URL 会在后续清洗中保留为普通安全链接。 */ }
    });
  };
}

function trustedMediaUrl(value: unknown): boolean {
  return typeof value === 'string' && /^\/api\/public\/media\/[0-9a-f-]{36}$/i.test(value);
}

function restrictRawMediaUrls() {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (!parent || index === undefined || !['audio', 'video'].includes(node.tagName)) return;
      const directSource = node.properties.src;
      const unsafeDirect = directSource !== undefined && !trustedMediaUrl(directSource);
      const poster = node.properties.poster;
      const unsafePoster = poster !== undefined && !trustedMediaUrl(poster);
      const children = node.children.filter((child) => {
        if (child.type !== 'element' || child.tagName !== 'source') return true;
        return trustedMediaUrl(child.properties.src);
      });
      const removedSource = children.length !== node.children.length;
      if (unsafeDirect || unsafePoster || (removedSource && !trustedMediaUrl(directSource) && !children.some((child) => child.type === 'element' && child.tagName === 'source'))) {
        const replacement: Element = {
          type: 'element', tagName: 'span', properties: { className: ['filtered-media'], dataUi: 'filtered-media' },
          children: [{ type: 'text', value: '媒体地址未使用站内受控资源，已停止加载。' }],
        };
        parent.children[index] = replacement as RootContent;
        return;
      }
      node.children = children;
      if (unsafePoster) delete node.properties.poster;
    });
  };
}

function prefixHeadingIds(prefix: string) {
  return (tree: Root): void => {
    if (!prefix) return;
    visit(tree, 'element', (node: Element) => {
      if (/^h[1-6]$/.test(node.tagName) && typeof node.properties.id === 'string') {
        node.properties.id = `${prefix}${node.properties.id}`;
      }
    });
  };
}

export async function renderMarkdown(markdown: string, options: MarkdownOptions = {}): Promise<MarkdownResult> {
  const normalized = preprocess(markdown, options);
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(restoreEmbedConsentHints)
    .use(restrictRawMediaUrls)
    .use(rehypeSanitize, schema)
    .use(rehypeSlug)
    .use(prefixHeadingIds, options.headingPrefix ?? '')
    .use(rehypeKatex);
  if (options.syntaxHighlight !== false) processor.use(rehypeHighlight, { detect: false });
  const file = await processor
    .use(rehypeStringify)
    .process(normalized);
  const text = stripMarkdown(markdown);
  const characterCount = Array.from(text.replace(/\s/g, '')).length;
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  const latinCount = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{Letter}\p{Number}]+(?:['’-][\p{Letter}\p{Number}]+)*/gu) ?? []).length;
  const wordCount = cjkCount + latinCount;
  const headings = extractHeadings(markdown).map((heading) => ({
    ...heading,
    id: `${options.headingPrefix ?? ''}${heading.id}`,
  }));
  return {
    html: String(file), text, description: text.slice(0, 180), headings,
    links: extractLinks(markdown), wordCount, characterCount, readingMinutes: Math.max(1, Math.ceil(wordCount / 260)),
  };
}

export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?(?:\[([^\]]*)\]\([^)]*\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\])/g, '$1 $3 $2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~=`|()-]|\[|\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractHeadings(markdown: string): Array<{ depth: number; text: string; id: string }> {
  const seen = new Map<string, number>();
  const headings: Array<{ depth: number; text: string; id: string }> = [];
  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*$/gm)) {
    const text = stripMarkdown(match[2] ?? '');
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ depth: (match[1] ?? '').length, text, id: count ? `${base}-${count + 1}` : base });
  }
  return headings;
}

export function extractLinks(markdown: string): string[] {
  const urls = new Set<string>();
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g)) if (match[1]) urls.add(match[1]);
  return [...urls];
}

export function extractWikiTargets(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) if (match[1]) targets.add(match[1].trim());
  return [...targets];
}
