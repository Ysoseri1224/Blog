import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { runBackupWorkflow } from '../src/worker/backup';
import { retryObjectDeletionQueue } from '../src/worker/maintenance';

describe('备份 generation 与可靠对象清理', () => {
  it('备份期间内容变化会丢弃整次快照并从新的 generation 重试', async () => {
    const scheduledTime = Date.UTC(2026, 6, 29, 3, 0, 0);
    let changed = false;
    const step = {
      async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
        const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => Promise<T>;
        if (name === 'attempt 1: verify' && !changed) {
          changed = true;
          await env.CONTENT_DB.prepare(
            "UPDATE repositories SET name=name || ' · backup-race',updated_at=?1 WHERE id='11111111-1111-4111-8111-111111111111'",
          ).bind(new Date().toISOString()).run();
        }
        return callback();
      },
    };
    const result = await runBackupWorkflow(env, scheduledTime, step as never) as {
      manifest: string; parts: number; fingerprint: string;
    };
    expect(changed).toBe(true);
    expect(result.manifest).toContain('-attempt-2/manifest.json');
    expect(result.parts).toBeGreaterThan(2);
    const firstAttempt = await env.BLOG_BACKUPS.list({ prefix: 'daily/2026-07-29/2026-07-29T03-00-00.000Z-attempt-1/' });
    expect(firstAttempt.objects).toHaveLength(0);
    const manifest = await env.BLOG_BACKUPS.get(result.manifest);
    expect(manifest).not.toBeNull();
    const body = await manifest!.json<{
      format: string; fingerprint: string; parts: Array<{ key: string; checksum: string }>;
      excludedTransientTables: string[]; retentionDays: number;
    }>();
    expect(body).toMatchObject({ format: 'ysoseri-blog-sql-parts-v1', fingerprint: result.fingerprint, retentionDays: 90 });
    expect(body.excludedTransientTables).toEqual(expect.arrayContaining(['operation_assertions', 'object_deletion_queue']));
    for (const part of body.parts) expect(await env.BLOG_BACKUPS.head(part.key)).not.toBeNull();
  });

  it('R2 删除失败时保留队列并记录错误，重试成功后才完成任务', async () => {
    const key = `versions/retry-test/${crypto.randomUUID()}.json`;
    const queueId = crypto.randomUUID();
    await env.BLOG_ARCHIVE.put(key, '{}');
    await env.CONTENT_DB.prepare(
      `INSERT INTO object_deletion_queue (id,object_key,kind,created_at)
       VALUES (?1,?2,'auto_version',?3)`,
    ).bind(queueId, key, new Date().toISOString()).run();
    const archive = new Proxy(env.BLOG_ARCHIVE, {
      get(target, property) {
        if (property === 'delete') return async () => { throw new Error('simulated R2 outage'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await retryObjectDeletionQueue({ ...env, BLOG_ARCHIVE: archive } as Env);
    expect(await env.BLOG_ARCHIVE.head(key)).not.toBeNull();
    expect(await env.CONTENT_DB.prepare(
      'SELECT attempts,last_error,completed_at FROM object_deletion_queue WHERE id=?1',
    ).bind(queueId).first()).toMatchObject({ attempts: 1, last_error: 'simulated R2 outage', completed_at: null });

    await retryObjectDeletionQueue(env);
    expect(await env.BLOG_ARCHIVE.head(key)).toBeNull();
    expect(await env.CONTENT_DB.prepare(
      'SELECT attempts,last_error,completed_at FROM object_deletion_queue WHERE id=?1',
    ).bind(queueId).first()).toMatchObject({ attempts: 2, last_error: null });
  });
});
