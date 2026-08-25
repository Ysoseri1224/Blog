export const renderArtifactThreshold = 20_000;
const renderChunkTarget = 4_000;
const renderChunkLimit = 40_000;

export function splitMarkdownForRender(markdown: string): string[] {
  const chunks: string[] = [];
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let current = '';
  let fence: string | null = null;
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };
  for (const line of lines) {
    if (!fence && current.length >= renderChunkTarget && /^#{1,6}\s/.test(line)) flush();
    current += line;
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match?.[1]) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
    }
    if (!fence && current.length >= renderChunkTarget && /^\s*$/.test(line)) flush();
    if (current.length > renderChunkLimit) throw new Error('单个 Markdown 结构块超过分片渲染上限');
  }
  flush();
  if (chunks.join('') !== markdown) throw new Error('Markdown 分片未保持原文');
  return chunks;
}
