import { describe, expect, it } from 'vitest';
import { blockInsertion, mediaMarkdown } from '../src/client/manage/markdownBlocks';
import { splitMarkdownForRender } from '../src/client/manage/renderChunks';

describe('编辑器媒体块', () => {
  it('把图片隔离为完整 Markdown 块并把光标放到后续空行', () => {
    const document = '前文后文';
    const change = blockInsertion(document, 2, 2, '![图](media://00000000-0000-4000-8000-000000000000)');
    expect(`${document.slice(0, 2)}${change.insert}${document.slice(2)}`).toBe(
      '前文\n\n![图](media://00000000-0000-4000-8000-000000000000)\n\n后文',
    );
    expect(change.anchorOffset).toBe(change.insert.length);
  });

  it('转义图片替代文字，并为音视频生成对应受控标签', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(mediaMarkdown('图[一].png', id, 'image/png')).toContain('![图\\[一\\].png]');
    expect(mediaMarkdown('声音.m4a', id, 'audio/mp4')).toBe(`<audio controls src="media://${id}"></audio>`);
    expect(mediaMarkdown('片段.mp4', id, 'video/mp4')).toBe(`<video controls src="media://${id}"></video>`);
  });
});

describe('长文分片', () => {
  it('保持原文且不拆开围栏代码块', () => {
    const fenced = `\n\n\`\`\`text\n${'x'.repeat(6_000)}\n\`\`\`\n\n`;
    const markdown = `# 开始\n\n${'正文。'.repeat(1_500)}${fenced}## 结束\n\n${'尾声。'.repeat(1_500)}`;
    const chunks = splitMarkdownForRender(markdown);
    expect(chunks.join('')).toBe(markdown);
    expect(chunks.filter((chunk) => chunk.includes('```text'))).toHaveLength(1);
    expect(chunks.find((chunk) => chunk.includes('```text'))).toContain('\n```\n');
  });
});
