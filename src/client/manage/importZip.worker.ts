import { strFromU8, unzipSync } from 'fflate';

interface ZipMessage { buffer: ArrayBuffer }
interface ZipAttachment { path: string; buffer: ArrayBuffer }

self.onmessage = (event: MessageEvent<ZipMessage>) => {
  try {
    const archive = unzipSync(new Uint8Array(event.data.buffer));
    const documents: Array<{ path: string; content: string }> = [];
    const attachments: ZipAttachment[] = [];
    const transfers: Transferable[] = [];
    for (const [path, bytes] of Object.entries(archive)) {
      if (path.endsWith('/') || path.split('/').includes('.obsidian')) continue;
      if (/\.md$/i.test(path)) documents.push({ path, content: strFromU8(bytes) });
      else {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        attachments.push({ path, buffer });
        transfers.push(buffer);
      }
    }
    self.postMessage({ documents, attachments }, { transfer: transfers });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'ZIP 解压失败' });
  }
};

export {};
