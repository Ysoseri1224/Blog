export interface BlockInsertion {
  insert: string;
  anchorOffset: number;
}

function escapedAlt(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').trim();
}

export function mediaMarkdown(filename: string, assetId: string, contentType: string): string {
  const label = escapedAlt(filename) || 'media';
  if (contentType.startsWith('audio/')) return `<audio controls src="media://${assetId}"></audio>`;
  if (contentType.startsWith('video/')) return `<video controls src="media://${assetId}"></video>`;
  return `![${label}](media://${assetId})`;
}

export function blockInsertion(document: string, from: number, to: number, block: string): BlockInsertion {
  const before = document.slice(0, from);
  const after = document.slice(to);
  const leading = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trailing = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = `${leading}${block.trim()}${trailing}`;
  return { insert, anchorOffset: insert.length };
}
