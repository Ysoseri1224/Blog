import type { InterfaceLanguage } from './types';

const messages = {
  zh: {
    backHome: '返回主站', files: '文件列表', search: '搜索', featured: '精选文章',
    newPost: '新建博客', newCategory: '新建分类', sort: '排序', reveal: '显示当前文件',
    collapseAll: '全部折叠', outline: '大纲', properties: '文章属性', backlinks: '反向链接',
    words: '词', characters: '字符', emptyRepository: '这个仓库还没有公开文章。',
    fileMissing: '文件不存在', fileMissingHint: '它可能尚未发布、已撤回，或不属于你可以进入的仓库。',
    manage: '管理', writing: '写作', media: '媒体库', repositories: '仓库设置', login: '进入写作空间',
    password: '站内密码', signIn: '验证并进入', signOut: '退出', saving: '正在同步', saved: '云端已保存',
    localSaved: '本地已保存', offline: '离线', saveFailed: '同步失败', source: '源码', live: '实时预览',
    publishPreview: '发布预览', publish: '发布', updatePublish: '更新发布', schedule: '定时发布', history: '版本历史',
    leftSidebar: '左侧栏', rightSidebar: '右侧栏', theme: '主题', tags: '标签', currentArticleTags: '当前文章标签',
    closeTab: '关闭标签', openTabOverview: '打开标签页概览', switchRepository: '切换仓库', switchLanguage: '切换到英文界面',
    searchPlaceholder: '输入关键词或 tag:…', noSearchResults: '没有匹配的公开文章。', noArticleTags: '当前文章没有标签。',
    repository: '仓库', category: '分类', language: '语言', firstPublished: '首次发布', lastUpdated: '最后更新', wordCount: '字数', repositoryRoot: '仓库根目录',
    lastModified: '最后修改', postUnit: '篇文章', postsUnit: '篇文章', categoryUnit: '个分类', categoriesUnit: '个分类', minuteUnit: '分钟',
    dismiss: '关闭提示', unableToLoad: '暂时无法载入', selectArticle: '选择一篇文章', readingProgress: '阅读进度',
    tabOverview: '标签页概览', openArticles: '打开的文章', closeOverview: '关闭概览', closeSidebar: '关闭侧栏', loadingArticle: '正在载入文章',
    enterManage: '进入管理', postUnavailable: '文章暂时无法打开，请稍后重试。', repositoryUnavailable: '仓库暂时无法打开，请稍后重试。', searchUnavailable: '搜索暂时不可用，请稍后重试。',
    unresolved: '未解析', articleEmbed: '文章嵌入', loadOnClick: '点击后加载', filteredMedia: '媒体地址未使用站内受控资源，已停止加载。',
    publicWorkspaceLoadFailed: '阅读工作区没有正确载入', publicWorkspaceLoadHint: '文章仍然保存在服务器；可以刷新页面重新建立阅读现场。',
    reload: '重新载入', backToBlog: '返回博客', resourcesLoadFailed: '页面资源没有正确载入，请刷新后重试。', dataLoadFailed: '页面数据没有正确载入。',
  },
  en: {
    backHome: 'Back home', files: 'Files', search: 'Search', featured: 'Featured',
    newPost: 'New post', newCategory: 'New folder', sort: 'Sort', reveal: 'Reveal current file',
    collapseAll: 'Collapse all', outline: 'Outline', properties: 'Properties', backlinks: 'Backlinks',
    words: 'words', characters: 'characters', emptyRepository: 'This repository has no public posts yet.',
    fileMissing: 'File not found', fileMissingHint: 'It may be unpublished, withdrawn, or outside a repository you can access.',
    manage: 'Manage', writing: 'Writing', media: 'Media', repositories: 'Repository settings', login: 'Enter the writing space',
    password: 'Site password', signIn: 'Verify and enter', signOut: 'Sign out', saving: 'Syncing', saved: 'Saved to cloud',
    localSaved: 'Saved locally', offline: 'Offline', saveFailed: 'Sync failed', source: 'Source', live: 'Live Preview',
    publishPreview: 'Publish preview', publish: 'Publish', updatePublish: 'Publish update', schedule: 'Schedule', history: 'Version history',
    leftSidebar: 'Left sidebar', rightSidebar: 'Right sidebar', theme: 'Theme', tags: 'Tags', currentArticleTags: 'Current article tags',
    closeTab: 'Close tab', openTabOverview: 'Open tab overview', switchRepository: 'Switch repository', switchLanguage: 'Switch to Chinese',
    searchPlaceholder: 'Keywords or tag:…', noSearchResults: 'No matching public posts.', noArticleTags: 'This article has no tags.',
    repository: 'Repository', category: 'Category', language: 'Language', firstPublished: 'First published', lastUpdated: 'Last updated', wordCount: 'Word count', repositoryRoot: 'Repository root',
    lastModified: 'Last modified', postUnit: 'post', postsUnit: 'posts', categoryUnit: 'category', categoriesUnit: 'categories', minuteUnit: 'min',
    dismiss: 'Dismiss', unableToLoad: 'Unable to load', selectArticle: 'Select an article', readingProgress: 'Reading progress',
    tabOverview: 'Tab overview', openArticles: 'Open articles', closeOverview: 'Close overview', closeSidebar: 'Close sidebar', loadingArticle: 'Loading article',
    enterManage: 'Enter management', postUnavailable: 'The article could not be opened. Please try again.', repositoryUnavailable: 'The repository could not be opened. Please try again.', searchUnavailable: 'Search is temporarily unavailable. Please try again.',
    unresolved: 'Unresolved', articleEmbed: 'Embedded article', loadOnClick: 'Click to load', filteredMedia: 'This media URL is not a managed site asset, so loading was blocked.',
    publicWorkspaceLoadFailed: 'The reading workspace did not load correctly', publicWorkspaceLoadHint: 'Your articles are still stored on the server. Reload the page to rebuild the reading workspace.',
    reload: 'Reload', backToBlog: 'Back to blog', resourcesLoadFailed: 'Page resources did not load correctly. Refresh and try again.', dataLoadFailed: 'Page data did not load correctly.',
  },
} as const;

export type MessageKey = keyof typeof messages.zh;
export function t(lang: InterfaceLanguage, key: MessageKey): string {
  return messages[lang][key];
}
