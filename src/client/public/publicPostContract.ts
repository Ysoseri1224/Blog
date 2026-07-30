import type { PostDetail } from '../../shared/types';

const postStatuses = new Set(['draft', 'scheduled', 'published', 'withdrawn']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isLink(value: unknown, backlink: boolean): boolean {
  if (!isRecord(value)) return false;
  return typeof value.postId === 'string'
    && typeof value.title === 'string'
    && typeof value.url === 'string'
    && (!backlink || typeof value.repositoryName === 'string');
}

/**
 * 公共文章接口有意返回扁平 PostDetail。这里在进入 React 状态前校验响应，
 * 防止服务端契约漂移再次让整个阅读工作区在渲染阶段崩溃。
 */
function isPostDetail(value: unknown): value is PostDetail {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.repositoryId === 'string'
    && isNullableString(value.categoryId)
    && typeof value.title === 'string'
    && typeof value.slug === 'string'
    && isNullableString(value.summary)
    && typeof value.language === 'string'
    && typeof value.status === 'string'
    && postStatuses.has(value.status)
    && typeof value.featured === 'boolean'
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && isNullableString(value.firstPublishedAt)
    && isNullableString(value.lastPublishedAt)
    && isNullableString(value.scheduledLocal)
    && isNullableString(value.scheduledTimezone)
    && isNullableString(value.scheduledUtc)
    && typeof value.wordCount === 'number'
    && typeof value.characterCount === 'number'
    && typeof value.readingMinutes === 'number'
    && typeof value.revision === 'number'
    && (typeof value.publicRevision === 'number' || value.publicRevision === null)
    && typeof value.markdown === 'string'
    && isNullableString(value.html)
    && isNullableString(value.coverAssetId)
    && isRecord(value.customProperties)
    && Array.isArray(value.forwardLinks)
    && value.forwardLinks.every((link) => isLink(link, false))
    && Array.isArray(value.backlinks)
    && value.backlinks.every((link) => isLink(link, true));
}

export function parsePublicPostResponse(value: unknown): PostDetail {
  if (!isPostDetail(value)) {
    throw new Error('公共文章接口返回了不完整的数据');
  }
  return value;
}
