import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Category, InterfaceLanguage, PostDetail, PostSummary, PublicBootstrap, RepositoryWorkspace } from '../../shared/types';
import { t } from '../../shared/i18n';
import { ApiError, api } from '../api';
import { Icon } from '../components/Icon';
import { PageCurlCorner } from '../components/PageCurlCorner';
import { parsePublicPostResponse } from './publicPostContract';

type Activity = 'files' | 'search' | 'featured' | 'tags';
type RightTool = 'outline' | 'properties' | 'backlinks';
type SortMode = 'published-desc' | 'published-asc' | 'modified-desc' | 'modified-asc' | 'title-asc' | 'title-desc';
interface Tab { postId: string; slug: string; title: string; }
interface OpenIntent { ctrlKey: boolean; metaKey: boolean; button: number; }
interface StoredWorkspace { tabs: Tab[]; activePostId: string | null; activity: Activity; query: string; rightTool: RightTool; leftCollapsed: boolean; rightCollapsed: boolean; expanded: string[]; sort: SortMode; }
interface ReadingIssue { kind: 'not-found' | 'post-error' | 'repository-error'; }

const defaultStored: StoredWorkspace = { tabs: [], activePostId: null, activity: 'files', query: '', rightTool: 'outline', leftCollapsed: false, rightCollapsed: false, expanded: [], sort: 'published-desc' };

function readStored(repositoryId: string): StoredWorkspace {
  try {
    const all = JSON.parse(localStorage.getItem('blog-workspaces') ?? '{}') as Record<string, Partial<StoredWorkspace>>;
    return { ...defaultStored, ...all[repositoryId] };
  } catch { return defaultStored; }
}

function writeStored(repositoryId: string, value: StoredWorkspace): void {
  try {
    const all = JSON.parse(localStorage.getItem('blog-workspaces') ?? '{}') as Record<string, Partial<StoredWorkspace>>;
    all[repositoryId] = value;
    localStorage.setItem('blog-workspaces', JSON.stringify(all));
  } catch { /* 隐私模式下仍可继续阅读。 */ }
}

function sortPosts(posts: PostSummary[], mode: SortMode, lang: InterfaceLanguage): PostSummary[] {
  const collator = new Intl.Collator(lang === 'zh' ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
  return [...posts].sort((a, b) => {
    if (mode === 'title-asc' || mode === 'title-desc') return collator.compare(a.title, b.title) * (mode === 'title-asc' ? 1 : -1) || a.id.localeCompare(b.id);
    const modified = mode.startsWith('modified');
    const left = modified ? a.updatedAt : a.firstPublishedAt ?? '';
    const right = modified ? b.updatedAt : b.firstPublishedAt ?? '';
    return left.localeCompare(right) * (mode.endsWith('asc') ? 1 : -1) || a.id.localeCompare(b.id);
  });
}

function ToolbarButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className="icon-button" data-active={active || undefined} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

async function fetchPublicPost(repositoryKey: string, slug: string): Promise<PostDetail> {
  const response = await api<unknown>(`/api/public/post?repository=${encodeURIComponent(repositoryKey)}&slug=${encodeURIComponent(slug)}`);
  return parsePublicPostResponse(response);
}

function CategoryTree({ categories, posts, expanded, onToggle, onOpen, activePostId, lang, repositoryKey }: {
  categories: Category[]; posts: PostSummary[]; expanded: Set<string>; onToggle: (id: string) => void;
  onOpen: (post: PostSummary, event: ReactMouseEvent) => void; activePostId?: string; lang: InterfaceLanguage; repositoryKey: string;
}) {
  const children = new Map<string | null, Category[]>();
  for (const category of categories) children.set(category.parentId, [...(children.get(category.parentId) ?? []), category]);
  const postsByCategory = new Map<string | null, PostSummary[]>();
  for (const post of posts) postsByCategory.set(post.categoryId, [...(postsByCategory.get(post.categoryId) ?? []), post]);
  const collator = new Intl.Collator(lang === 'zh' ? 'zh-CN' : 'en', { numeric: true });
  const renderLevel = (parentId: string | null, depth: number): React.ReactNode => <>
    {(children.get(parentId) ?? []).sort((a, b) => collator.compare(a.name, b.name)).map((category) => {
      const open = expanded.has(category.id);
      const directChildren = children.get(category.id) ?? [];
      return <div className="tree-group" key={category.id}>
        <button className="tree-row folder-row" style={{ '--depth': depth } as React.CSSProperties} onClick={() => onToggle(category.id)} title={categorySummary(postsByCategory.get(category.id)?.length ?? 0, directChildren.length, lang)}>
          <Icon name="chevron" className={open ? 'rotated' : ''}/><Icon name="folder"/><span>{category.name}</span>
        </button>
        {open && <div>{renderLevel(category.id, depth + 1)}</div>}
      </div>;
    })}
    {(postsByCategory.get(parentId) ?? []).map((post) => <PostRow key={post.id} repositoryKey={repositoryKey} post={post} depth={depth} active={activePostId === post.id} lang={lang} onOpen={onOpen}/>) }
  </>;
  return <div className="file-tree">{renderLevel(null, 0)}</div>;
}

function PostRow({ post, repositoryKey, depth, active, lang, onOpen }: { post: PostSummary; repositoryKey: string; depth: number; active: boolean; lang: InterfaceLanguage; onOpen: (post: PostSummary, event: ReactMouseEvent) => void }) {
  return <a href={`/${repositoryKey}/${post.slug}`} className="tree-row file-row" data-active={active || undefined} style={{ '--depth': depth } as React.CSSProperties}
    onClick={(event) => { event.preventDefault(); onOpen(post, event); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onOpen(post, event); } }} title={`${t(lang, 'lastModified')}: ${new Date(post.updatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en')}`}>
    <Icon name="file"/><span>{post.title}</span>{post.firstPublishedAt && <time>{post.firstPublishedAt.slice(0, 10)}</time>}
  </a>;
}

function ReadingArticle({ post, repositoryName, categories, lang, onTag, onNavigate }: { post: PostDetail; repositoryName: string; categories:Category[]; lang: InterfaceLanguage; onTag:(tag:string)=>void; onNavigate:(href:string,event:MouseEvent)=>boolean }) {
  const articleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    localizeArticleSystemText(article, lang);
    const listeners: Array<() => void> = [];
    const ensureStylesheet = (id: string, href: string) => {
      if (document.getElementById(id)) return;
      const link = document.createElement('link'); link.id = id; link.rel = 'stylesheet'; link.href = href;
      document.head.appendChild(link);
    };
    if (post.html?.includes('class="katex')) ensureStylesheet('blog-katex-css', '/capabilities/katex.min.css');
    if (post.html?.includes('class="hljs')) ensureStylesheet('blog-highlight-css', '/capabilities/highlight-github.css');
    for (const button of article.querySelectorAll<HTMLAnchorElement>('.embed-consent')) {
      const click = (event: MouseEvent) => {
        event.preventDefault(); event.stopPropagation();
        const raw = button.dataset.url; const provider = button.dataset.provider;
        if (!raw || !provider) return;
        let src = '';
        try {
          const url = new URL(raw);
          if (provider === 'YouTube') {
            const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
            if (id) src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
          } else if (provider === 'Vimeo') src = `https://player.vimeo.com/video/${encodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? '')}`;
          else if (provider === 'Spotify') src = `https://open.spotify.com/embed${url.pathname}`;
          else if (provider === 'Bilibili') src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')}`;
        } catch { return; }
        if (!src) return;
        const frame = document.createElement('iframe'); frame.src = src; frame.loading = 'lazy'; frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.allow = 'fullscreen; encrypted-media; picture-in-picture'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation'); frame.title = button.textContent ?? provider; button.replaceWith(frame);
      };
      button.addEventListener('click', click); listeners.push(() => button.removeEventListener('click', click));
    }
    const navigate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!target || target.classList.contains('embed-consent') || target.hasAttribute('download') || target.target === '_blank') return;
      if (onNavigate(target.href, event)) event.preventDefault();
    };
    article.addEventListener('click', navigate); listeners.push(() => article.removeEventListener('click', navigate));
    const mermaidBlocks = [...article.querySelectorAll<HTMLElement>('code.language-mermaid')];
    if (mermaidBlocks.length) void import('mermaid').then(({ default: mermaid }) => { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral' }); return mermaid.run({ nodes: mermaidBlocks }); });
    return () => listeners.forEach((remove) => remove());
  }, [lang, onNavigate, post.html, post.id, post.publicRevision]);
  const path=categoryPath(post.categoryId,categories);
  return <article className="markdown-article" ref={articleRef}>
    <div className="display-path"><span>{repositoryName}</span>{path.map((name,index)=><span key={`${name}-${index}`}>/ {name}</span>)}<span>/</span><span>{post.title}</span></div>
    <h1 className="article-title">{post.title}</h1>
    <div className="article-meta"><time>{post.firstPublishedAt?.slice(0, 10)}</time><span>{post.readingMinutes} {t(lang, 'minuteUnit')}</span>{post.tags.map((tag) => <button className="tag-pill" key={tag} onClick={()=>onTag(tag)}>#{tag}</button>)}</div>
    <div className="markdown-body" dangerouslySetInnerHTML={{ __html: post.html ?? '' }}/>
  </article>;
}

export function PublicApp({ initial }: { initial: PublicBootstrap }) {
  const [lang, setLang] = useState(initial.lang);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [repositories] = useState(initial.repositories);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [post, setPost] = useState(initial.activePost);
  const [stored, setStored] = useState<StoredWorkspace>(() => initial.workspace ? { ...readStored(initial.workspace.repository.id), tabs: initial.activePost ? mergeTab(readStored(initial.workspace.repository.id).tabs, initial.activePost) : readStored(initial.workspace.repository.id).tabs, activePostId: initial.activePost?.id ?? null } : defaultStored);
  const [loading, setLoading] = useState(false);
  const [readingIssue, setReadingIssue] = useState<ReadingIssue | null>(() => initial.notFound ? { kind: 'not-found' } : null);
  const [searchResults, setSearchResults] = useState<Array<{ postId: string; snippet: string; score: number }>>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mobileLeft, setMobileLeft] = useState(false); const [mobileRight, setMobileRight] = useState(false);
  const [mobileTabs, setMobileTabs] = useState(false);
  const requestRef = useRef(0); const articleScrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLElement>(null); const scrollFrameRef = useRef(0);
  const [activeHeading, setActiveHeading] = useState('');

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('blog-theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; }, [lang]);
  useEffect(() => { if (workspace) writeStored(workspace.repository.id, stored); }, [workspace, stored]);
  useEffect(() => {
    if (stored.activity !== 'search' || !stored.query.trim() || !workspace) { setSearchResults([]); setSearchError(null); return; }
    setSearchError(null);
    const controller = new AbortController(); const timer = setTimeout(() => {
      void api<{ results: typeof searchResults }>(`/api/public/search?repository=${encodeURIComponent(workspace.repository.key)}&q=${encodeURIComponent(stored.query)}`, { signal: controller.signal }).then((data) => { setSearchResults(data.results); setSearchError(null); }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSearchResults([]); setSearchError(t(lang, 'searchUnavailable'));
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [lang, stored.activity, stored.query, workspace]);

  const updateStored = (patch: Partial<StoredWorkspace>) => setStored((current) => ({ ...current, ...patch }));
  const openPost = useCallback(async (summary: PostSummary, event?: OpenIntent, push = true) => {
    if (!workspace) return; const requestId = ++requestRef.current; setLoading(true);
    try {
      const nextPost = await fetchPublicPost(workspace.repository.key, summary.slug);
      if (requestId !== requestRef.current) return;
      const newTab = Boolean(event?.ctrlKey || event?.metaKey || event?.button === 1);
      setPost(nextPost);
      setStored((current) => ({ ...current, tabs: newTab ? mergeTab(current.tabs, nextPost) : replaceActiveTab(current.tabs, current.activePostId, nextPost), activePostId: nextPost.id }));
      setReadingIssue(null);
      if (push) history.pushState({ repository: workspace.repository.key, slug: summary.slug }, '', `/${workspace.repository.key}/${summary.slug}`);
      articleScrollRef.current?.scrollTo({ top: 0 });
      setMobileLeft(false);
    } catch (reason) {
      if (requestId !== requestRef.current) return;
      const notFound = reason instanceof ApiError && reason.status === 404;
      setReadingIssue({ kind: notFound ? 'not-found' : 'post-error' });
    } finally { if (requestId === requestRef.current) setLoading(false); }
  }, [workspace]);

  const switchRepository = useCallback(async (key: string, slug?: string, event?: OpenIntent, push = true) => {
    const currentRepositoryId = workspace?.repository.id; if (currentRepositoryId) writeStored(currentRepositoryId, stored);
    const requestId = ++requestRef.current; setLoading(true);
    try {
      const data = await api<RepositoryWorkspace>(`/api/public/workspace?repository=${encodeURIComponent(key)}`);
      const nextStored = readStored(data.repository.id);
      const target = slug ? data.posts.find((item) => item.slug === slug) : data.posts.find((item) => item.id === nextStored.activePostId) ?? sortPosts(data.posts, nextStored.sort, lang)[0];
      const nextPost = target ? await fetchPublicPost(data.repository.key, target.slug) : null;
      if (requestId !== requestRef.current) return;
      const newTab = Boolean(event?.ctrlKey || event?.metaKey || event?.button === 1);
      const committedStored = nextPost ? {
        ...nextStored,
        tabs: newTab ? mergeTab(nextStored.tabs, nextPost) : replaceActiveTab(nextStored.tabs, nextStored.activePostId, nextPost),
        activePostId: nextPost.id,
      } : { ...nextStored, activePostId: null };
      setWorkspace(data);
      setStored(committedStored);
      setPost(nextPost);
      setReadingIssue(slug && !target ? { kind: 'not-found' } : null);
      setMobileLeft(false);
      setMobileRight(false);
      if (push) {
        const path = slug ? `/${key}/${slug}` : target ? `/${key}/${target.slug}` : `/${key}/`;
        history.pushState({ repository: key, slug: target?.slug }, '', path);
      }
      articleScrollRef.current?.scrollTo({ top: 0 });
    } catch (reason) {
      if (requestId !== requestRef.current) return;
      const notFound = reason instanceof ApiError && reason.status === 404;
      setReadingIssue({ kind: notFound ? 'not-found' : 'repository-error' });
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [lang, stored, workspace?.repository.id]);

  const navigateArticleLink = useCallback((href: string, event: MouseEvent): boolean => {
    if (!workspace) return false;
    let target: URL;
    try { target = new URL(href, location.href); } catch { return false; }
    if (target.origin !== location.origin || target.pathname.startsWith('/manage') || target.pathname.startsWith('/api/')) return false;
    const parts = target.pathname.split('/').filter(Boolean); const repositoryKey = parts[0]; const slug = parts[1];
    if (!repositoryKey || !slug || parts.length !== 2 || !repositories.some((repository) => repository.key === repositoryKey)) return false;
    if (repositoryKey === workspace.repository.key) {
      const summary = workspace.posts.find((item) => item.slug === slug); if (!summary) return false;
      void openPost(summary, event); return true;
    }
    void switchRepository(repositoryKey, slug, event); return true;
  }, [openPost, repositories, switchRepository, workspace]);

  useEffect(() => {
    const pop = () => {
      const parts = location.pathname.split('/').filter(Boolean); if (!parts[0]) return;
      if (workspace?.repository.key !== parts[0]) void switchRepository(parts[0], parts[1], undefined, false);
      else if (parts[1]) {
        const target = workspace.posts.find((item) => item.slug === parts[1]);
        if (target) void openPost(target, undefined, false);
        else { setPost(null); setReadingIssue({ kind: 'not-found' }); }
      } else { setPost(null); setReadingIssue(null); }
    };
    addEventListener('popstate', pop); return () => removeEventListener('popstate', pop);
  }, [lang, openPost, switchRepository, workspace]);

  const posts = useMemo(() => workspace ? sortPosts(workspace.posts, stored.sort, lang) : [], [workspace, stored.sort, lang]);
  const expanded = useMemo(() => new Set(stored.expanded), [stored.expanded]);
  const outline = useMemo(() => extractOutline(post?.html ?? ''), [post?.html]);
  const activeTab = stored.tabs.find((tab) => tab.postId === stored.activePostId);
  const visibleResults = stored.query.trim() ? searchResults.map((result) => ({ ...result, post: workspace?.posts.find((item) => item.id === result.postId) })).filter((item): item is typeof item & { post: PostSummary } => Boolean(item.post)) : [];
  const onScroll = useCallback(() => {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const element = articleScrollRef.current; const indicator = progressRef.current;
      if (!element || !indicator) return;
      const max = element.scrollHeight - element.clientHeight;
      const value = max <= 0 ? 0 : Math.min(100, Math.max(0, element.scrollTop / max * 100));
      indicator.style.height = `${value}%`; indicator.parentElement?.setAttribute('title', `${Math.round(value)}%`); indicator.parentElement?.setAttribute('aria-valuenow', String(Math.round(value)));
    });
  }, []);
  useEffect(() => () => { if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current); }, []);
  useEffect(() => {
    setActiveHeading('');
    const root = articleScrollRef.current;
    if (!root || !post) return;
    let observer: IntersectionObserver | null = null;
    const frame = requestAnimationFrame(() => {
      const headings = [...root.querySelectorAll<HTMLElement>('.markdown-body h1[id],.markdown-body h2[id],.markdown-body h3[id],.markdown-body h4[id],.markdown-body h5[id],.markdown-body h6[id]')];
      if (!headings.length) return;
      const chooseCurrent = () => {
        const threshold = root.getBoundingClientRect().top + Math.min(120, root.clientHeight * .2);
        let current = headings[0]?.id ?? '';
        for (const heading of headings) { if (heading.getBoundingClientRect().top <= threshold) current = heading.id; else break; }
        setActiveHeading((previous) => previous === current ? previous : current);
      };
      observer = new IntersectionObserver(chooseCurrent, { root, rootMargin: '-12% 0px -72% 0px', threshold: [0, 1] });
      headings.forEach((heading) => observer?.observe(heading)); chooseCurrent();
    });
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [post, post?.html, post?.publicRevision]);
  const closeTab = (id: string) => {
    const index = stored.tabs.findIndex((tab) => tab.postId === id); const next = stored.tabs.filter((tab) => tab.postId !== id);
    const nextActive = id === stored.activePostId ? next[Math.max(0, index - 1)] ?? next[0] : next.find((tab) => tab.postId === stored.activePostId);
    updateStored({ tabs: next, activePostId: nextActive?.postId ?? null });
    if (!nextActive) { setPost(null); setReadingIssue(null); } else { const target = workspace?.posts.find((item) => item.id === nextActive.postId); if (target) void openPost(target); }
  };
  const toggleLang = () => { const next = lang === 'zh' ? 'en' : 'zh'; document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'; setLang(next); document.cookie = `blog-lang=${next}; Path=/; Max-Age=31536000; SameSite=Lax`; };
  const selectRightTool = (tool: RightTool) => {
    if (stored.rightTool === tool && !stored.rightCollapsed) { updateStored({ rightCollapsed: true }); setMobileRight(false); return; }
    updateStored({ rightTool: tool, rightCollapsed: false });
  };
  const activityTitle = stored.activity === 'files' ? t(lang, 'files') : stored.activity === 'search' ? t(lang, 'search') : stored.activity === 'featured' ? t(lang, 'featured') : t(lang, 'currentArticleTags');
  const issueMessage = readingIssue ? readingIssueText(readingIssue.kind, lang) : null;

  return <div className="app-shell" data-left-collapsed={stored.leftCollapsed || undefined} data-right-collapsed={stored.rightCollapsed || undefined}>
    <header className="top-chrome">
      <div className="top-left"><a className="home-link" href="https://ysoseri.us" aria-label={t(lang, 'backHome')}><Icon name="home"/><span>ysoseri.us</span></a><ToolbarButton label={t(lang, 'leftSidebar')} onClick={() => updateStored({ leftCollapsed: !stored.leftCollapsed })}><Icon name="panel-left"/></ToolbarButton></div>
      <div className="tabs" role="tablist">{stored.tabs.map((tab) => <div className="article-tab" role="tab" aria-selected={tab.postId === stored.activePostId} draggable key={tab.postId} onDragStart={(event)=>event.dataTransfer.setData('text/tab-id',tab.postId)} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.preventDefault();updateStored({tabs:reorderTabs(stored.tabs,event.dataTransfer.getData('text/tab-id'),tab.postId)});}} onClick={() => { const target = workspace?.posts.find((item) => item.id === tab.postId); if (target) void openPost(target); }}><Icon name="file"/><span>{tab.title}</span><button aria-label={`${t(lang, 'closeTab')}: ${tab.title}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.postId); }}><Icon name="close"/></button></div>)}</div>
      <div className="top-right"><ToolbarButton label={t(lang, 'rightSidebar')} onClick={() => updateStored({ rightCollapsed: !stored.rightCollapsed })}><Icon name="panel-right"/></ToolbarButton><ToolbarButton label={t(lang, 'theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Icon name="sun"/> : <Icon name="moon"/>}</ToolbarButton><button className="text-button" aria-label={t(lang, 'switchLanguage')} onClick={toggleLang}>{lang === 'zh' ? 'EN' : '中'}</button><ToolbarButton label={t(lang, 'tags')} onClick={() => { updateStored({ activity: 'tags' }); setMobileLeft(true); }}><Icon name="tag"/></ToolbarButton></div>
      <button className="mobile-menu left" aria-label={t(lang, 'leftSidebar')} onClick={() => { setMobileLeft(!mobileLeft); setMobileRight(false); setMobileTabs(false); }}><Icon name="menu"/></button><button className="mobile-title" aria-label={t(lang, 'openTabOverview')} onClick={() => { setMobileTabs(!mobileTabs); setMobileLeft(false); setMobileRight(false); }}>{post?.title ?? workspace?.repository.name ?? 'Blog'}</button><button className="mobile-menu right" aria-label={t(lang, 'rightSidebar')} onClick={() => { setMobileRight(!mobileRight); setMobileLeft(false); setMobileTabs(false); }}><Icon name="panel-right"/></button>
    </header>
    <aside className={`left-sidebar ${mobileLeft ? 'mobile-open' : ''}`}>
      <nav className="activity-bar"><ToolbarButton label={t(lang, 'files')} active={stored.activity === 'files'} onClick={() => updateStored({ activity: 'files' })}><Icon name="folder"/></ToolbarButton><ToolbarButton label={t(lang, 'search')} active={stored.activity === 'search'} onClick={() => updateStored({ activity: 'search' })}><Icon name="search"/></ToolbarButton><ToolbarButton label={t(lang, 'featured')} active={stored.activity === 'featured'} onClick={() => updateStored({ activity: 'featured' })}><Icon name="star"/></ToolbarButton></nav>
      <section className="left-panel">
        <div className="panel-heading"><strong>{activityTitle}</strong></div>
        {stored.activity === 'files' && <><div className="file-tools"><span className="sort-mode-label">{sortModeLabel(stored.sort, lang)}</span><ToolbarButton label={`${t(lang, 'sort')}: ${sortModeLabel(stored.sort, lang)}`} onClick={() => updateStored({ sort: nextSort(stored.sort) })}><Icon name="sort"/></ToolbarButton><ToolbarButton label={t(lang, 'reveal')} onClick={() => revealCategory(post?.categoryId, workspace?.categories ?? [], updateStored, expanded)}><Icon name="locate"/></ToolbarButton><ToolbarButton label={t(lang, 'collapseAll')} onClick={() => updateStored({ expanded: [] })}><Icon name="collapse"/></ToolbarButton></div><CategoryTree categories={workspace?.categories ?? []} posts={posts} expanded={expanded} activePostId={post?.id} lang={lang} repositoryKey={workspace?.repository.key??''} onToggle={(id) => updateStored({ expanded: expanded.has(id) ? [...expanded].filter((item) => item !== id) : [...expanded, id] })} onOpen={(item, event) => void openPost(item, event)}/></>}
        {stored.activity === 'search' && <div className="search-panel"><label className="search-input"><Icon name="search"/><input autoFocus value={stored.query} onChange={(event) => updateStored({ query: event.target.value })} placeholder={t(lang, 'searchPlaceholder')}/></label>{searchError && <p className="search-error" role="alert">{searchError}</p>}<div className="search-results">{visibleResults.map(({ post: item, snippet }) => <button key={item.id} onClick={() => void openPost(item)}><strong>{item.title}</strong><span dangerouslySetInnerHTML={{ __html: snippet }}/></button>)}{stored.query.trim() && !searchError && !visibleResults.length && <p className="panel-empty">{t(lang, 'noSearchResults')}</p>}</div></div>}
        {stored.activity === 'featured' && <div className="featured-list">{posts.filter((item) => item.featured).map((item) => <button key={item.id} onClick={() => void openPost(item)}><Icon name="star"/><span>{item.title}</span></button>)}</div>}
        {stored.activity === 'tags' && <div className="tag-overview">{post?.tags.map((tag) => <button key={tag} onClick={() => updateStored({ activity: 'search', query: `tag:${tag}` })}><Icon name="tag"/><span>#{tag}</span></button>)}{!post?.tags.length && <p className="panel-empty">{t(lang, 'noArticleTags')}</p>}</div>}
      </section>
      <div className="repository-switcher"><select value={workspace?.repository.key ?? ''} onChange={(event) => void switchRepository(event.target.value)} aria-label={t(lang, 'switchRepository')}>{repositories.map((repository) => <option value={repository.key} key={repository.id}>{repository.name}</option>)}</select><Icon name="chevron"/></div>
    </aside>
    <main className="center-pane">
      <div className="reading-scroll" ref={articleScrollRef} onScroll={onScroll} aria-busy={loading}>{loading && !post && <div className="reading-skeleton"><i/><i/><i/><i/></div>}{post && <ReadingArticle post={post} repositoryName={workspace?.repository.name ?? ''} categories={workspace?.categories??[]} lang={lang} onTag={(tag)=>{updateStored({activity:'search',query:`tag:${tag}`});setMobileLeft(true);}} onNavigate={navigateArticleLink}/>} {readingIssue && post && <div className="reading-notice" role="status"><Icon name="file"/><span>{issueMessage}</span><button onClick={() => setReadingIssue(null)} aria-label={t(lang, 'dismiss')}><Icon name="close"/></button></div>}{!loading && !post && <div className="empty-reading"><Icon name="file"/><h1>{readingIssue?.kind === 'not-found' ? t(lang, 'fileMissing') : readingIssue ? t(lang, 'unableToLoad') : workspace?.posts.length ? t(lang, 'selectArticle') : t(lang, 'emptyRepository')}</h1>{issueMessage && <p>{issueMessage}</p>}</div>}</div>
    </main>
    <aside className={`right-sidebar ${mobileRight ? 'mobile-open' : ''}`}>
      <nav className="right-tools"><ToolbarButton label={t(lang, 'outline')} active={stored.rightTool === 'outline' && !stored.rightCollapsed} onClick={() => selectRightTool('outline')}><Icon name="outline"/></ToolbarButton><ToolbarButton label={t(lang, 'properties')} active={stored.rightTool === 'properties' && !stored.rightCollapsed} onClick={() => selectRightTool('properties')}><Icon name="properties"/></ToolbarButton><ToolbarButton label={t(lang, 'backlinks')} active={stored.rightTool === 'backlinks' && !stored.rightCollapsed} onClick={() => selectRightTool('backlinks')}><Icon name="backlinks"/></ToolbarButton></nav>
      <section className="right-panel">{stored.rightTool === 'outline' && <><h2>{t(lang, 'outline')}</h2><nav className="outline-list">{outline.map((heading) => <a key={heading.id} href={`#${heading.id}`} data-active={heading.id === activeHeading || undefined} aria-current={heading.id === activeHeading ? 'location' : undefined} style={{ '--level': heading.level } as React.CSSProperties}>{heading.text}</a>)}</nav></>}{stored.rightTool === 'properties' && <><h2>{t(lang, 'properties')}</h2>{post && <dl className="property-list"><dt>{t(lang, 'repository')}</dt><dd>{workspace?.repository.name}</dd><dt>{t(lang, 'category')}</dt><dd>{categoryPath(post.categoryId,workspace?.categories??[]).join(' / ') || t(lang, 'repositoryRoot')}</dd><dt>{t(lang, 'language')}</dt><dd>{formatLanguage(post.language, lang)}</dd><dt>{t(lang, 'firstPublished')}</dt><dd>{post.firstPublishedAt?.slice(0,10)}</dd><dt>{t(lang, 'lastUpdated')}</dt><dd>{post.lastPublishedAt?.slice(0,10)}</dd><dt>{t(lang, 'tags')}</dt><dd>{post.tags.join(' · ') || '—'}</dd><dt>{t(lang, 'wordCount')}</dt><dd>{post.wordCount}</dd>{Object.entries(post.customProperties).map(([key,value]) => <><dt key={`${key}-k`}>{key}</dt><dd key={`${key}-v`}>{String(value)}</dd></>)}</dl>}</>}{stored.rightTool === 'backlinks' && <><h2>{t(lang, 'backlinks')} <small>{post?.backlinks.length ?? 0}</small></h2><div className="backlink-list">{post?.backlinks.map((link) => <a href={link.url} key={link.postId}><strong>{link.title}</strong><span>{link.repositoryName}</span></a>)}</div></>}</section>
      <div className="reading-progress" title="0%" role="progressbar" aria-label={t(lang, 'readingProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}><i ref={progressRef}/></div>
    </aside>
    <footer className="status-bar"><span>{post?.wordCount ?? 0} {t(lang, 'words')}</span><span>{post?.characterCount ?? 0} {t(lang, 'characters')}</span></footer>
    <PageCurlCorner lang={lang}/>
    {mobileTabs && <section className="mobile-tab-overview" aria-label={t(lang, 'tabOverview')}><header><strong>{t(lang, 'openArticles')}</strong><button aria-label={t(lang, 'closeOverview')} onClick={() => setMobileTabs(false)}><Icon name="close"/></button></header><div>{stored.tabs.map((tab) => <article key={tab.postId} data-active={tab.postId === stored.activePostId || undefined}><button onClick={() => { const target = workspace?.posts.find((item) => item.id === tab.postId); if (target) void openPost(target); setMobileTabs(false); }}><Icon name="file"/><span>{tab.title}</span></button><button aria-label={`${t(lang, 'closeTab')}: ${tab.title}`} onClick={() => closeTab(tab.postId)}><Icon name="close"/></button></article>)}</div></section>}
    {(mobileLeft || mobileRight || mobileTabs) && <button className="drawer-scrim" aria-label={t(lang, 'closeSidebar')} onClick={() => { setMobileLeft(false); setMobileRight(false); setMobileTabs(false); }}/>}<div className="sr-only" aria-live="polite">{loading ? t(lang, 'loadingArticle') : activeTab?.title}</div>
  </div>;
}

function mergeTab(tabs: Tab[], post: Pick<PostDetail, 'id' | 'slug' | 'title'>): Tab[] { return tabs.some((tab) => tab.postId === post.id) ? tabs.map((tab) => tab.postId === post.id ? { postId: post.id, slug: post.slug, title: post.title } : tab) : [...tabs, { postId: post.id, slug: post.slug, title: post.title }]; }
function replaceActiveTab(tabs: Tab[], activeId: string | null, post: Pick<PostDetail, 'id'|'slug'|'title'>): Tab[] { if (!tabs.length || !activeId) return mergeTab(tabs, post); return tabs.map((tab) => tab.postId === activeId ? { postId: post.id, slug: post.slug, title: post.title } : tab).filter((tab, index, all) => all.findIndex((item) => item.postId === tab.postId) === index); }
function reorderTabs(tabs:Tab[],sourceId:string,targetId:string):Tab[]{if(!sourceId||sourceId===targetId)return tabs;const source=tabs.find((tab)=>tab.postId===sourceId);if(!source)return tabs;const next=tabs.filter((tab)=>tab.postId!==sourceId);const targetIndex=next.findIndex((tab)=>tab.postId===targetId);next.splice(targetIndex<0?next.length:targetIndex,0,source);return next;}
function localizeArticleSystemText(article: HTMLElement, lang: InterfaceLanguage): void {
  article.querySelectorAll<HTMLElement>('.unresolved-link').forEach((link) => {
    const marker = link.querySelector<HTMLElement>('[data-ui="unresolved"], small');
    if (marker) { marker.textContent = t(lang, 'unresolved'); return; }
    for (const node of link.childNodes) if (node.nodeType === Node.TEXT_NODE && /(?:未解析|Unresolved)\s*$/.test(node.nodeValue ?? '')) node.nodeValue = (node.nodeValue ?? '').replace(/(?:未解析|Unresolved)\s*$/, t(lang, 'unresolved'));
  });
  article.querySelectorAll<HTMLElement>('.article-embed > header > span, .article-embed > span').forEach((node) => { node.textContent = t(lang, 'articleEmbed'); });
  article.querySelectorAll<HTMLElement>('.filtered-media').forEach((node) => { node.textContent = t(lang, 'filteredMedia'); });
  article.querySelectorAll<HTMLAnchorElement>('.embed-consent, a[data-provider][data-url]').forEach((link) => {
    const hint = link.querySelector<HTMLElement>('span');
    const provider = link.dataset.provider;
    const raw = link.dataset.url;
    if (!hint || !provider || !raw) return;
    try { hint.textContent = `${provider} · ${new URL(raw).hostname} · ${t(lang, 'loadOnClick')}`; } catch { /* 无效地址仍保留发布快照中的安全文本。 */ }
  });
}
function nextSort(mode: SortMode): SortMode { const modes: SortMode[] = ['published-desc','published-asc','modified-desc','modified-asc','title-asc','title-desc']; return modes[(modes.indexOf(mode)+1)%modes.length] ?? 'published-desc'; }
function sortModeLabel(mode: SortMode, lang: InterfaceLanguage): string { const labels: Record<SortMode, [string, string]> = { 'published-desc':['首次发布 ↓','Published ↓'], 'published-asc':['首次发布 ↑','Published ↑'], 'modified-desc':['最后修改 ↓','Modified ↓'], 'modified-asc':['最后修改 ↑','Modified ↑'], 'title-asc':['标题 A–Z','Title A–Z'], 'title-desc':['标题 Z–A','Title Z–A'] }; return labels[mode][lang === 'zh' ? 0 : 1]; }
function categorySummary(postCount: number, categoryCount: number, lang: InterfaceLanguage): string {
  const postUnit = t(lang, postCount === 1 ? 'postUnit' : 'postsUnit');
  const categoryUnit = t(lang, categoryCount === 1 ? 'categoryUnit' : 'categoriesUnit');
  return lang === 'zh' ? `${postCount} ${postUnit}，${categoryCount} ${categoryUnit}` : `${postCount} ${postUnit}, ${categoryCount} ${categoryUnit}`;
}
function formatLanguage(code: string, lang: InterfaceLanguage): string {
  try {
    const name = new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'language', fallback: 'code' }).of(code);
    return name && name !== code ? `${name} · ${code}` : code;
  } catch { return code; }
}
function readingIssueText(kind: ReadingIssue['kind'], lang: InterfaceLanguage): string {
  if (kind === 'not-found') return t(lang, 'fileMissingHint');
  return t(lang, kind === 'repository-error' ? 'repositoryUnavailable' : 'postUnavailable');
}
function revealCategory(categoryId: string | null | undefined, categories: Category[], update: (patch: Partial<StoredWorkspace>) => void, current: Set<string>) { const byId = new Map(categories.map((category) => [category.id, category])); let id = categoryId; const next = new Set(current); while (id) { next.add(id); id = byId.get(id)?.parentId ?? null; } update({ expanded: [...next] }); }
function categoryPath(categoryId:string|null,categories:Category[]):string[]{const byId=new Map(categories.map((category)=>[category.id,category]));const result:string[]=[];const seen=new Set<string>();let id=categoryId;while(id&&!seen.has(id)){seen.add(id);const category=byId.get(id);if(!category)break;result.unshift(category.name);id=category.parentId;}return result;}
function extractOutline(html: string): Array<{ id: string; text: string; level: number }> { if (!html) return []; const template = document.createElement('template'); template.innerHTML = html; return [...template.content.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6')].map((heading) => ({ id: heading.id, text: heading.textContent ?? '', level: Number(heading.tagName.slice(1)) })); }
