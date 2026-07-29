export interface CommandDefinition {
  id: string;
  title: string;
  category: string;
  defaultKeys: string[];
}

export const commandDefinitions: CommandDefinition[] = [
  { id: 'save', title: '保存工作稿', category: '文件', defaultKeys: ['Mod+S'] },
  { id: 'new-post', title: '新建文章', category: '文件', defaultKeys: ['Mod+Alt+N'] },
  { id: 'new-category', title: '新建分类', category: '文件', defaultKeys: ['Mod+Alt+Shift+N'] },
  { id: 'preview', title: '发布预览', category: '模式', defaultKeys: ['Mod+Shift+P'] },
  { id: 'toggle-source', title: 'Live Preview / 源码', category: '模式', defaultKeys: ['Mod+E'] },
  { id: 'publish', title: '打开发布确认', category: '发布', defaultKeys: ['Mod+Alt+P'] },
  { id: 'bold', title: '粗体', category: 'Markdown', defaultKeys: ['Mod+B'] },
  { id: 'italic', title: '斜体', category: 'Markdown', defaultKeys: ['Mod+I'] },
  { id: 'link', title: '链接', category: 'Markdown', defaultKeys: ['Mod+K'] },
  { id: 'heading', title: '二级标题', category: 'Markdown', defaultKeys: ['Mod+Alt+2'] },
  { id: 'quote', title: '引用', category: 'Markdown', defaultKeys: ['Mod+Shift+.'] },
  { id: 'code', title: '行内代码', category: 'Markdown', defaultKeys: ['Mod+Shift+C'] },
  { id: 'bullet-list', title: '无序列表', category: 'Markdown', defaultKeys: ['Mod+Alt+L'] },
  { id: 'numbered-list', title: '有序列表', category: 'Markdown', defaultKeys: ['Mod+Alt+O'] },
  { id: 'task-list', title: '任务列表', category: 'Markdown', defaultKeys: ['Mod+Alt+X'] },
  { id: 'indent', title: '增加缩进', category: '编辑', defaultKeys: ['Mod+]'] },
  { id: 'outdent', title: '减少缩进', category: '编辑', defaultKeys: ['Mod+['] },
  { id: 'undo', title: '撤销编辑', category: '编辑', defaultKeys: ['Mod+Z'] },
  { id: 'redo', title: '重做编辑', category: '编辑', defaultKeys: ['Mod+Shift+Z', 'Mod+Y'] },
  { id: 'find', title: '当前文章查找', category: '编辑', defaultKeys: ['Mod+F'] },
  { id: 'replace', title: '当前文章查找与替换', category: '编辑', defaultKeys: ['Mod+Alt+F'] },
  { id: 'select-structure', title: '选择当前 Markdown 结构', category: '编辑', defaultKeys: ['Mod+Shift+A'] },
  { id: 'history', title: '版本历史', category: '导航', defaultKeys: ['Mod+Alt+H'] },
  { id: 'repository-search', title: '搜索当前仓库文章', category: '导航', defaultKeys: ['Mod+Shift+F'] },
  { id: 'previous-tab', title: '切换到上一个文章标签', category: '导航', defaultKeys: ['Mod+Alt+ArrowUp'] },
  { id: 'next-tab', title: '切换到下一个文章标签', category: '导航', defaultKeys: ['Mod+Alt+ArrowDown'] },
  { id: 'close-tab', title: '关闭当前文章标签', category: '导航', defaultKeys: ['Mod+Alt+W'] },
  { id: 'toggle-sidebar', title: '折叠 / 展开文章列表', category: '导航', defaultKeys: ['Mod+Shift+B'] },
  { id: 'toggle-properties', title: '折叠 / 展开文章属性', category: '导航', defaultKeys: ['Mod+Alt+B'] },
  { id: 'help', title: '快捷键列表', category: '帮助', defaultKeys: ['Mod+/'] },
];

const browserReserved = new Set([
  'mod+l', 'mod+t', 'mod+w', 'mod+n', 'mod+r', 'mod+u', 'mod+j',
  'mod+shift+t', 'mod+shift+n', 'mod+shift+w', 'mod+shift+delete',
]);

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function bindingSignature(binding: string): string {
  return binding.trim().toLocaleLowerCase();
}

export function platformKey(binding: string, mac = isMacPlatform()): string {
  return binding.replace('Mod', mac ? '⌘' : 'Ctrl').replaceAll('Alt', mac ? '⌥' : 'Alt').replaceAll('Shift', mac ? '⇧' : 'Shift').replaceAll('Meta', '⌘');
}

function normalizedEventKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toLocaleUpperCase();
  return key;
}

export function capturedBinding(event: KeyboardEvent, mac = isMacPlatform()): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return null;
  const parts: string[] = [];
  if ((mac && event.metaKey) || (!mac && event.ctrlKey)) parts.push('Mod');
  if (mac && event.ctrlKey) parts.push('Ctrl');
  if (!mac && event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normalizedEventKey(event.key));
  return parts.join('+');
}

export function matchesKey(event: KeyboardEvent, binding: string, mac = isMacPlatform()): boolean {
  const parts = binding.toLocaleLowerCase().split('+');
  const key = parts.at(-1);
  const expectsCtrl = parts.includes('ctrl') || (!mac && parts.includes('mod'));
  const expectsMeta = parts.includes('meta') || (mac && parts.includes('mod'));
  const expectedKey = key === 'space' ? ' ' : key;
  return event.key.toLocaleLowerCase() === expectedKey
    && event.ctrlKey === expectsCtrl
    && event.metaKey === expectsMeta
    && event.altKey === parts.includes('alt')
    && event.shiftKey === parts.includes('shift');
}

export function bindingProblem(binding: string, commandId: string, active: Array<{ id: string; keys: string[] }>): string | null {
  const signature = bindingSignature(binding);
  const hasModifier = signature.split('+').slice(0, -1).some((part) => ['mod', 'ctrl', 'meta', 'alt'].includes(part));
  const isFunctionKey = /^f(?:[1-9]|1[0-2])$/.test(signature);
  if (!hasModifier && !isFunctionKey) return '为避免打断输入，快捷键需要修饰键或 F1–F12。';
  if (browserReserved.has(signature)) return '这是浏览器保留组合键，不能覆盖。';
  const conflict = active.find((command) => command.id !== commandId && command.keys.some((key) => bindingSignature(key) === signature));
  return conflict ? '这个组合键已被其他命令使用。' : null;
}

export function loadShortcutOverrides(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem('blog-shortcuts') ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter(([, keys]) => Array.isArray(keys) && keys.every((key) => typeof key === 'string')) as Array<[string, string[]]>);
  } catch {
    return {};
  }
}
