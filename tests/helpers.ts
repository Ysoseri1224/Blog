import { SELF } from 'cloudflare:test';

export const origin = 'https://blog.ysoseri.us';
export const testPassword = 'blog-test-password';

export interface AuthSession {
  cookie: string;
  csrf: string;
}

export async function workerRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${origin}${path}`, init);
}

export async function login(password = testPassword): Promise<AuthSession> {
  const response = await workerRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`);
  const body = await response.json<{ csrfToken: string }>();
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('登录响应缺少 session cookie');
  return { cookie, csrf: body.csrfToken };
}

export function authorHeaders(session: AuthSession, mutate = false): Headers {
  const headers = new Headers({ cookie: session.cookie, origin });
  if (mutate) {
    headers.set('content-type', 'application/json');
    headers.set('x-csrf-token', session.csrf);
  }
  return headers;
}

export async function authorRequest(session: AuthSession, path: string, init: RequestInit = {}): Promise<Response> {
  const mutate = !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
  const headers = authorHeaders(session, mutate);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return workerRequest(path, { ...init, headers });
}

export async function jsonBody<T>(response: Response): Promise<T> {
  return response.json<T>();
}
