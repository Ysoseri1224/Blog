import { constantTimeEqual, hashPassword, sha256Hex, randomToken, verifyPassword } from './crypto';
import { getCookie, HttpError } from './http';

const sessionCookie = '__Host-blog_session';

interface SessionRow {
  id: string;
  csrf_token: string;
  expires_at: string;
  revoked_at: string | null;
  reauthenticated_until: string | null;
}

export interface AuthorSession {
  id: string;
  csrfToken: string;
  expiresAt: string;
  reauthenticatedUntil: string | null;
}

function expiryCookie(date: Date): string {
  return `${sessionCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Expires=${date.toUTCString()}`;
}

function sessionCookieHeader(token: string, days: number): string {
  return `${sessionCookie}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${days * 86400}`;
}

async function requestFingerprint(request: Request): Promise<{ ipHash: string; userAgentHash: string; attemptKey: string }> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const userAgent = request.headers.get('user-agent') ?? '';
  const [ipHash, userAgentHash] = await Promise.all([sha256Hex(ip), sha256Hex(userAgent)]);
  return { ipHash, userAgentHash, attemptKey: await sha256Hex(`${ip}|${userAgent.slice(0, 120)}`) };
}

async function passwordHash(env: Env): Promise<string | null> {
  const configured = await env.CONTENT_DB.prepare("SELECT value_json FROM settings WHERE key='auth_password_hash'").first<{ value_json: string }>();
  if (!configured) return env.AUTH_PASSWORD_HASH || null;
  try { const value = JSON.parse(configured.value_json) as unknown; return typeof value === 'string' ? value : null; } catch { return null; }
}

async function verifyPasswordWithThrottle(request: Request, env: Env, password: string): Promise<{ fingerprint: Awaited<ReturnType<typeof requestFingerprint>>; now: Date }> {
  const encodedHash = await passwordHash(env);
  if (!encodedHash) throw new HttpError(503, '作者密码尚未配置', 'auth_not_configured');
  const fingerprint = await requestFingerprint(request); const now = new Date();
  const attempt = await env.CONTENT_DB.prepare('SELECT failures, blocked_until FROM auth_attempts WHERE key_hash = ?1')
    .bind(fingerprint.attemptKey).first<{ failures: number; blocked_until: string | null }>();
  if (attempt?.blocked_until && attempt.blocked_until > now.toISOString()) throw new HttpError(429, '验证失败，请稍后再试', 'login_throttled');
  if (!(await verifyPassword(password, encodedHash))) {
    const failures = (attempt?.failures ?? 0) + 1;
    const delaySeconds = failures < 5 ? 0 : Math.min(3600, 30 * (2 ** Math.min(7, failures - 5)));
    const blockedUntil = delaySeconds ? new Date(now.getTime() + delaySeconds * 1000).toISOString() : null;
    await env.CONTENT_DB.prepare(
      `INSERT INTO auth_attempts (key_hash, failures, first_failure_at, last_failure_at, blocked_until)
       VALUES (?1, ?2, ?3, ?3, ?4)
       ON CONFLICT(key_hash) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at, blocked_until = excluded.blocked_until`,
    ).bind(fingerprint.attemptKey, failures, now.toISOString(), blockedUntil).run();
    throw new HttpError(401, '密码不正确', 'invalid_credentials');
  }
  await env.CONTENT_DB.prepare('DELETE FROM auth_attempts WHERE key_hash = ?1').bind(fingerprint.attemptKey).run();
  return { fingerprint, now };
}

export async function getSession(request: Request, env: Env, touch = false): Promise<AuthorSession | null> {
  const token = getCookie(request, sessionCookie);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.CONTENT_DB.prepare(
    `SELECT id, csrf_token, expires_at, revoked_at, reauthenticated_until
       FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
  ).bind(tokenHash, new Date().toISOString()).first<SessionRow>();
  if (!row) return null;
  if (touch) {
    await env.CONTENT_DB.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), row.id).run();
  }
  return { id: row.id, csrfToken: row.csrf_token, expiresAt: row.expires_at, reauthenticatedUntil: row.reauthenticated_until };
}

export async function requireSession(request: Request, env: Env, options: { csrf?: boolean; stepUp?: boolean } = {}): Promise<AuthorSession> {
  const session = await getSession(request, env, true);
  if (!session) throw new HttpError(401, '请先验证身份', 'unauthorized');
  if (options.csrf) {
    const origin = request.headers.get('origin');
    const requestOrigin = new URL(request.url).origin;
    if (origin && origin !== env.SITE_ORIGIN && origin !== requestOrigin) throw new HttpError(403, '请求来源无效', 'invalid_origin');
    const provided = request.headers.get('x-csrf-token') ?? '';
    const [actualHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(session.csrfToken)]);
    const actual = Uint8Array.from(actualHash.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
    const expected = Uint8Array.from(expectedHash.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
    if (!constantTimeEqual(actual, expected)) throw new HttpError(403, '安全校验已失效，请刷新页面', 'invalid_csrf');
  }
  if (options.stepUp && (!session.reauthenticatedUntil || session.reauthenticatedUntil <= new Date().toISOString())) {
    throw new HttpError(403, '此操作需要再次验证密码', 'reauth_required');
  }
  return session;
}

export async function login(request: Request, env: Env, password: string): Promise<{ cookie: string; csrfToken: string; expiresAt: string }> {
  const { fingerprint, now } = await verifyPasswordWithThrottle(request, env, password);
  const days = Number.parseInt(env.SESSION_DAYS, 10) || 30;
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(now.getTime() + days * 86400_000).toISOString();
  await env.CONTENT_DB.prepare(
      `INSERT INTO sessions (id, token_hash, csrf_token, created_at, expires_at, last_seen_at, user_agent_hash, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7)`,
    ).bind(crypto.randomUUID(), tokenHash, csrfToken, now.toISOString(), expiresAt, fingerprint.userAgentHash, fingerprint.ipHash).run();
  return { cookie: sessionCookieHeader(token, days), csrfToken, expiresAt };
}

export async function logout(request: Request, env: Env): Promise<string> {
  const token = getCookie(request, sessionCookie);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.CONTENT_DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL')
      .bind(new Date().toISOString(), tokenHash).run();
  }
  return expiryCookie(new Date(0));
}

export async function reauthenticate(request: Request, env: Env, password: string): Promise<string> {
  const session = await requireSession(request, env, { csrf: true });
  await verifyPasswordWithThrottle(request, env, password);
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  await env.CONTENT_DB.prepare('UPDATE sessions SET reauthenticated_until = ?1 WHERE id = ?2').bind(until, session.id).run();
  return until;
}

export async function changePassword(request: Request, env: Env, currentPassword: string, newPassword: string): Promise<void> {
  await reauthenticate(request, env, currentPassword);
  const encodedHash = await hashPassword(newPassword); const now = new Date().toISOString();
  await env.CONTENT_DB.batch([
    env.CONTENT_DB.prepare(
      `INSERT INTO settings (key,value_json,updated_at) VALUES ('auth_password_hash',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    ).bind(JSON.stringify(encodedHash), now),
    env.CONTENT_DB.prepare('UPDATE sessions SET revoked_at=?1,reauthenticated_until=NULL WHERE revoked_at IS NULL').bind(now),
  ]);
}
