import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { authorHeaders, jsonBody, login, testPassword, workerRequest } from './helpers';

describe('作者鉴权', () => {
  it('拒绝错误密码并建立可撤销的 30 天会话', async () => {
    const rejected = await workerRequest('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(rejected.status).toBe(401);

    const session = await login();
    const current = await workerRequest('/api/auth/session', { headers: authorHeaders(session) });
    const body = await jsonBody<{ authenticated: boolean; expiresAt: string }>(current);
    expect(body.authenticated).toBe(true);
    const lifetimeDays = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(lifetimeDays).toBeGreaterThan(29.9);
    expect(lifetimeDays).toBeLessThanOrEqual(30.01);

    const logout = await workerRequest('/api/auth/logout', {
      method: 'POST',
      headers: authorHeaders(session, true),
    });
    expect(logout.status).toBe(200);
    const after = await workerRequest('/api/auth/session', { headers: authorHeaders(session) });
    expect(await jsonBody<{ authenticated: boolean }>(after)).toMatchObject({ authenticated: false });
    const active = await env.CONTENT_DB.prepare('SELECT count(*) AS count FROM sessions WHERE revoked_at IS NULL').first<{ count: number }>();
    expect(active?.count).toBe(0);
  });

  it('所有作者写接口同时要求会话、同源和 CSRF', async () => {
    const anonymous = await workerRequest('/api/manage/posts', { method: 'POST', body: '{}' });
    expect(anonymous.status).toBe(401);

    const session = await login(testPassword);
    const noCsrf = await workerRequest('/api/manage/posts', {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noCsrf.status).toBe(403);

    const foreignOrigin = authorHeaders(session, true);
    foreignOrigin.set('origin', 'https://attacker.example');
    const crossSite = await workerRequest('/api/manage/posts', { method: 'POST', headers: foreignOrigin, body: '{}' });
    expect(crossSite.status).toBe(403);
  });

  it('再次验证也执行限速，不能借已窃取会话无限猜测密码', async () => {
    const session = await login();
    const headers = authorHeaders(session, true); headers.set('cf-connecting-ip', '198.51.100.42');
    for (let index = 0; index < 5; index += 1) {
      const response = await workerRequest('/api/auth/reauth', { method: 'POST', headers, body: JSON.stringify({ password: `wrong-${index}` }) });
      expect(response.status).toBe(401);
    }
    const throttled = await workerRequest('/api/auth/reauth', { method: 'POST', headers, body: JSON.stringify({ password: 'still-wrong' }) });
    expect(throttled.status).toBe(429);
  });

  it('修改站内密码会撤销全部旧会话，并只接受新的安全摘要', async () => {
    const first = await login(); const second = await login(); const newPassword = 'new-blog-password-2026';
    const changed = await workerRequest('/api/auth/password', {
      method: 'PUT', headers: authorHeaders(first, true), body: JSON.stringify({ currentPassword: testPassword, newPassword }),
    });
    expect(changed.status).toBe(200);
    for (const session of [first, second]) {
      const current = await workerRequest('/api/auth/session', { headers: authorHeaders(session) });
      expect(await jsonBody<{ authenticated: boolean }>(current)).toMatchObject({ authenticated: false });
    }
    const oldPassword = await workerRequest('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: testPassword }) });
    expect(oldPassword.status).toBe(401);
    await expect(login(newPassword)).resolves.toMatchObject({ cookie: expect.stringContaining('__Host-blog_session=') });
    const stored = await env.CONTENT_DB.prepare("SELECT value_json FROM settings WHERE key='auth_password_hash'").first<{ value_json: string }>();
    expect(JSON.parse(stored?.value_json ?? 'null')).toMatch(/^pbkdf2\$210000\$/);
  });
});
