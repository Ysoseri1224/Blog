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
  },
} as const;

export type MessageKey = keyof typeof messages.zh;
export function t(lang: InterfaceLanguage, key: MessageKey): string {
  return messages[lang][key];
}

