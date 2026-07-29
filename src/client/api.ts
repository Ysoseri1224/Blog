export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}, csrfToken?: string | null): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({ error: 'invalid_response', message: '服务返回了无法读取的结果' })) as { error?: string; message?: string } & T;
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'request_failed', data.message ?? '请求失败');
  return data;
}

