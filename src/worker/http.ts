import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'request_error') {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > 2_100_000) throw new HttpError(413, '请求内容过大', 'payload_too_large');
  try {
    const raw: unknown = await request.json();
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(400, error.issues.map((issue) => issue.message).join('；'), 'validation_error');
    }
    if (error instanceof SyntaxError) throw new HttpError(400, 'JSON 格式无效', 'invalid_json');
    throw error;
  }
}

export function methodNotAllowed(allow: string[]): Response {
  return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: allow.join(', ') } });
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) return decodeURIComponent(valueParts.join('='));
  }
  return null;
}

export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof HttpError) return json({ error: error.code, message: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ message: 'unhandled request error', error: message, path: new URL(request.url).pathname }));
  return json({ error: 'internal_error', message: '服务暂时不可用' }, { status: 500 });
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return headers;
}

