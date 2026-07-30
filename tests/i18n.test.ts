import { describe, expect, it } from 'vitest';
import { t, type MessageKey } from '../src/shared/i18n';

describe('公开阅读界面语言', () => {
  it('英文模式覆盖属性、Chrome、状态和辅助技术文案', () => {
    const expected: Partial<Record<MessageKey, string>> = {
      repository: 'Repository',
      category: 'Category',
      language: 'Language',
      firstPublished: 'First published',
      lastUpdated: 'Last updated',
      tags: 'Tags',
      wordCount: 'Word count',
      repositoryRoot: 'Repository root',
      leftSidebar: 'Left sidebar',
      rightSidebar: 'Right sidebar',
      closeTab: 'Close tab',
      switchRepository: 'Switch repository',
      readingProgress: 'Reading progress',
      enterManage: 'Enter management',
      loadingArticle: 'Loading article',
      unresolved: 'Unresolved',
      articleEmbed: 'Embedded article',
      loadOnClick: 'Click to load',
    };
    for (const [key, value] of Object.entries(expected) as Array<[MessageKey, string]>) expect(t('en', key)).toBe(value);
  });

  it('中文模式保留对应中文界面文案', () => {
    expect(t('zh', 'repositoryRoot')).toBe('仓库根目录');
    expect(t('zh', 'firstPublished')).toBe('首次发布');
    expect(t('zh', 'enterManage')).toBe('进入管理');
  });
});
