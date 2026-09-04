import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/worker/markdown';

describe('Markdown 中文文本与 directive 消歧', () => {
  it('不应把中文字段后的 ASCII 冒号识别为文本 directive', async () => {
    const result = await renderMarkdown('项目:Scenario 08\n作者:Leif\nAgent:行为\n\n普通段落。');

    expect(result.html).toContain('<p>项目:Scenario 08\n作者:Leif\nAgent:行为</p>');
    expect(result.html).not.toContain('<div></div>');
  });

  it('保留真正的 block directive 和代码中的原文', async () => {
    const result = await renderMarkdown('项目:Scenario\n\n```text\n项目:Scenario\n```\n\n::embed[来源]{url="https://example.com/video"}');

    expect(result.html).toContain('<p>项目:Scenario</p>');
    expect(result.html).toContain('项目:Scenario');
    expect(result.html).not.toContain('<div></div>');
  });
});
