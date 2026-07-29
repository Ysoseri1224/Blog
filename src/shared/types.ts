export type Visibility = 'public' | 'unlisted' | 'private';
export type PostStatus = 'draft' | 'scheduled' | 'published' | 'withdrawn';
export type InterfaceLanguage = 'zh' | 'en';

export interface Repository {
  id: string;
  name: string;
  key: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  repositoryId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostSummary {
  id: string;
  repositoryId: string;
  categoryId: string | null;
  title: string;
  slug: string;
  summary: string | null;
  language: string;
  status: PostStatus;
  featured: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  scheduledLocal: string | null;
  scheduledTimezone: string | null;
  scheduledUtc: string | null;
  wordCount: number;
  characterCount: number;
  readingMinutes: number;
  revision: number;
  publicRevision: number | null;
}

export interface PostDetail extends PostSummary {
  markdown: string;
  html: string | null;
  coverAssetId: string | null;
  customProperties: Record<string, unknown>;
  forwardLinks: Array<{ postId: string; title: string; url: string }>;
  backlinks: Array<{ postId: string; title: string; url: string; repositoryName: string }>;
}

export interface RepositoryWorkspace {
  repository: Repository;
  categories: Category[];
  posts: PostSummary[];
}

export interface PublicBootstrap {
  kind: 'public';
  lang: InterfaceLanguage;
  repositories: Repository[];
  workspace: RepositoryWorkspace | null;
  activePost: PostDetail | null;
  canonical: string;
  authenticated: boolean;
  notFound?: boolean;
}

export interface ManageBootstrap {
  kind: 'manage';
  lang: InterfaceLanguage;
  authenticated: boolean;
  csrfToken: string | null;
  repositories: Repository[];
  workspace: RepositoryWorkspace | null;
  activePost: PostDetail | null;
  directPostId?: string;
}

export type AppBootstrap = PublicBootstrap | ManageBootstrap;

declare global {
  interface Window {
    __BLOG_BOOTSTRAP__?: AppBootstrap;
  }
}

