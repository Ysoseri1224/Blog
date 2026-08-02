import type { MarkdownResult } from './markdown';
import { renderMarkdown } from './markdown';
import { toBase64Url } from './crypto';
import { HttpError } from './http';

export interface SignedRenderChunk {
  source: string;
  prefix: string;
  result: MarkdownResult;
  signature: string;
}

export interface RenderArtifactPlan {
  key: string;
  payload: string;
}

interface StoredRenderArtifact {
  postId: string;
  revision: number;
  rendered: MarkdownResult;
  createdAt: string;
}

const encoder = new TextEncoder();
const renderContext = 'ysoseri-blog-render-chunk:v1';
export const renderArtifactThreshold = 20_000;

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch { return null; }
}

async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.IMPORT_EXPORT_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function signedBytes(chunk: Omit<SignedRenderChunk, 'signature'>): Uint8Array<ArrayBuffer> {
  const { source, prefix, result } = chunk;
  return encoder.encode(JSON.stringify([
    renderContext,
    source,
    prefix,
    result.html,
    result.text,
    result.description,
    result.headings.map((heading) => [heading.depth, heading.text, heading.id]),
    result.links,
    result.wordCount,
    result.characterCount,
    result.readingMinutes,
  ]));
}

export async function renderSignedChunk(
  env: Env,
  source: string,
  prefix: string,
  wikiTargets: ReadonlyMap<string, { url: string; title: string; html?: string } | null> = new Map(),
): Promise<SignedRenderChunk> {
  const result = await renderMarkdown(source, {
    wikiTargets,
    headingPrefix: prefix,
    syntaxHighlight: false,
  });
  const unsigned = { source, prefix, result };
  const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), signedBytes(unsigned))));
  return { ...unsigned, signature };
}

export async function combineSignedChunks(
  env: Env,
  markdown: string,
  chunks: SignedRenderChunk[],
): Promise<MarkdownResult | null> {
  if (!chunks.length) return null;
  if (chunks.map((chunk) => chunk.source).join('') !== markdown) {
    throw new HttpError(400, '分片渲染内容与导入正文不一致', 'render_chunks_source_mismatch');
  }
  const key = await signingKey(env);
  const verified = await Promise.all(chunks.map(async (chunk) => {
    const signature = fromBase64Url(chunk.signature);
    return Boolean(signature && await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      signedBytes({ source: chunk.source, prefix: chunk.prefix, result: chunk.result }),
    ));
  }));
  if (verified.some((valid) => !valid)) {
    throw new HttpError(400, '分片渲染签名无效', 'render_chunk_signature_invalid');
  }
  const text = chunks.map((chunk) => chunk.result.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const wordCount = chunks.reduce((total, chunk) => total + chunk.result.wordCount, 0);
  return {
    html: chunks.map((chunk) => chunk.result.html).join('\n'),
    text,
    description: text.slice(0, 180),
    headings: chunks.flatMap((chunk) => chunk.result.headings),
    links: [...new Set(chunks.flatMap((chunk) => chunk.result.links))],
    wordCount,
    characterCount: chunks.reduce((total, chunk) => total + chunk.result.characterCount, 0),
    readingMinutes: Math.max(1, Math.ceil(wordCount / 260)),
  };
}

export function renderArtifactKey(postId: string, revision: number): string {
  return `render-artifacts/${postId}/${revision}.json`;
}

export function makeRenderArtifact(
  postId: string,
  revision: number,
  rendered: MarkdownResult,
): RenderArtifactPlan {
  const key = renderArtifactKey(postId, revision);
  const payload: StoredRenderArtifact = {
    postId,
    revision,
    rendered,
    createdAt: new Date().toISOString(),
  };
  return { key, payload: JSON.stringify(payload) };
}

export async function loadRenderArtifact(
  env: Env,
  postId: string,
  revision: number,
): Promise<MarkdownResult | null> {
  const object = await env.BLOG_ARCHIVE.get(renderArtifactKey(postId, revision));
  if (!object) return null;
  const artifact = await object.json<StoredRenderArtifact>();
  if (artifact.postId !== postId || artifact.revision !== revision) return null;
  return artifact.rendered;
}
