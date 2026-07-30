import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { sha256Hex } from './crypto';

interface BackupParams { scheduledTime: number; }
interface BackupPart { key: string; checksum: string; bytes: number; table?: string; rows?: number; }
interface BackupPreparation { generatedAt: string; prefix: string; schemaVersion: string; tables: Array<{ name: string; count: number }>; schemaSql: string; indexSql: string; fingerprint: string; }

const schemaTables = [
  'repositories','categories','posts','tags','post_tags','post_links','post_versions','public_snapshots','redirects',
  'sessions','auth_attempts','outbox','media_assets','post_media','public_snapshot_media','settings','public_post_links','deleted_urls','deletion_jobs','backup_clock','operation_assertions','object_deletion_queue','d1_migrations',
] as const;
const transientTables = new Set(['sessions','auth_attempts','outbox','deletion_jobs','operation_assertions','object_deletion_queue']);
const pageSize = 10;

function backupRetentionDays(env: Env): number {
  const days = Number(env.BACKUP_RETENTION_DAYS);
  if (!Number.isInteger(days) || days <= 0) throw new Error('BACKUP_RETENTION_DAYS 必须是正整数');
  return days;
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer) return `X'${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  if (ArrayBuffer.isView(value)) return `X'${[...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertSql(table: string, rows: Record<string, unknown>[]): string {
  return rows.map((row) => {
    const columns = Object.keys(row);
    return `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(',')});`;
  }).join('\n');
}

async function contentFingerprint(env: Env): Promise<string> {
  const row = await env.CONTENT_DB.prepare(
    `SELECT
      (SELECT generation FROM backup_clock WHERE id=1) AS generation,
      (SELECT count(*) || ':' || COALESCE(sum(revision),0) || ':' || COALESCE(max(updated_at),'') FROM posts) AS posts,
      (SELECT count(*) || ':' || COALESCE(max(updated_at),'') FROM repositories) AS repositories,
      (SELECT count(*) || ':' || COALESCE(max(updated_at),'') FROM categories) AS categories,
      (SELECT count(*) FROM post_versions) AS versions,(SELECT count(*) FROM public_snapshots) AS snapshots,
      (SELECT count(*) FROM tags) AS tags,(SELECT count(*) FROM post_tags) AS post_tags,(SELECT count(*) FROM post_links) AS post_links,
      (SELECT count(*) FROM public_post_links) AS public_links,(SELECT count(*) FROM redirects) AS redirects,
      (SELECT count(*) FROM media_assets) AS media,(SELECT count(*) FROM settings) AS settings,(SELECT count(*) FROM deleted_urls) AS tombstones`,
  ).first<Record<string, unknown>>();
  return sha256Hex(JSON.stringify(row ?? {}));
}

async function prepareBackup(env: Env, scheduledTime: number, attempt: number): Promise<BackupPreparation> {
  const generatedAt = new Date(scheduledTime).toISOString();
  const prefix = `daily/${generatedAt.slice(0, 10)}/${generatedAt.replaceAll(':', '-')}-attempt-${attempt}`;
  const schema = await env.CONTENT_DB.prepare(
    `SELECT type,name,tbl_name,sql FROM sqlite_schema
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`,
  ).all<{ type: string; name: string; tbl_name: string; sql: string }>();
  const actualTables = schema.results.filter((item) => item.type === 'table').map((item) => item.name);
  const unknown = actualTables.filter((name) => !(schemaTables as readonly string[]).includes(name));
  const missing = schemaTables.filter((name) => !actualTables.includes(name));
  if (unknown.length || missing.length) throw new Error(`备份 schema 与代码不一致；unknown=${unknown.join(',')} missing=${missing.join(',')}`);
  const tables: Array<{ name: string; count: number }> = [];
  for (const name of schemaTables) {
    if (transientTables.has(name)) continue;
    const count = await env.CONTENT_DB.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(name)}`).first<{ count: number }>();
    tables.push({ name, count: count?.count ?? 0 });
  }
  const tableSql = schema.results.filter((item) => item.type === 'table').map((item) => `${item.sql};`).join('\n');
  const indexSql = schema.results.filter((item) => item.type !== 'table').map((item) => `${item.sql};`).join('\n');
  const schemaVersion = await env.CONTENT_DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first<{ name: string }>();
  return {
    generatedAt, prefix, schemaVersion: schemaVersion?.name ?? 'unknown', tables,
    schemaSql: `BEGIN TRANSACTION;\nPRAGMA defer_foreign_keys=ON;\n${tableSql}\n`,
    indexSql: `${indexSql}\nCOMMIT;\nPRAGMA defer_foreign_keys=OFF;\n`, fingerprint: await contentFingerprint(env),
  };
}

async function putPart(env: Env, key: string, body: string, metadata: Record<string, string> = {}): Promise<BackupPart> {
  const checksum = await sha256Hex(body);
  await env.BLOG_BACKUPS.put(key, body, {
    httpMetadata: { contentType: key.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/sql; charset=utf-8' },
    customMetadata: { checksum, ...metadata },
  });
  return { key, checksum, bytes: new TextEncoder().encode(body).byteLength };
}

async function objectReferencePart(env: Env, prefix: string): Promise<BackupPart> {
  const [versions, snapshots, media] = await Promise.all([
    env.CONTENT_DB.prepare('SELECT object_key FROM post_versions ORDER BY object_key').all<{ object_key: string }>(),
    env.CONTENT_DB.prepare('SELECT id,object_key,cover_url FROM public_snapshots ORDER BY object_key').all<{ id: string; object_key: string; cover_url: string | null }>(),
    env.CONTENT_DB.prepare('SELECT object_key FROM media_assets WHERE deleted_at IS NULL ORDER BY object_key').all<{ object_key: string }>(),
  ]);
  const body = JSON.stringify({
    blogArchive: [
      ...versions.results.map((item) => item.object_key),
      ...snapshots.results.flatMap((item) => item.cover_url?.endsWith(`/api/public/og/${item.id}.svg`)
        ? [item.object_key, `og/${item.id}.svg`]
        : [item.object_key]),
    ],
    siteMedia: media.results.map((item) => item.object_key),
  }, null, 2);
  return putPart(env, `${prefix}/object-references.json`, body, { kind: 'object-references' });
}

export async function runBackupWorkflow(env: Env, scheduledTime: number, step: WorkflowStep): Promise<unknown> {
    const retentionDays = backupRetentionDays(env);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const prepared = await step.do(`attempt ${attempt}: prepare`, { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        () => prepareBackup(env, scheduledTime, attempt));
      const parts: BackupPart[] = [];
      let partNumber = 0;
      const schemaKey = `${prepared.prefix}/${String(partNumber).padStart(5, '0')}-schema.sql`; partNumber += 1;
      parts.push(await step.do(`attempt ${attempt}: schema`, () => putPart(env, schemaKey, prepared.schemaSql, { kind: 'schema' })));
      for (const table of prepared.tables) {
        const pages = Math.ceil(table.count / pageSize);
        for (let page = 0; page < pages; page += 1) {
          const key = `${prepared.prefix}/${String(partNumber).padStart(5, '0')}-${table.name}-${page + 1}.sql`; partNumber += 1;
          const part = await step.do(`attempt ${attempt}: ${table.name} page ${page + 1}`, { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
            const rows = await env.CONTENT_DB.prepare(`SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY rowid LIMIT ?1 OFFSET ?2`)
              .bind(pageSize, page * pageSize).all<Record<string, unknown>>();
            const result = await putPart(env, key, `${insertSql(table.name, rows.results)}\n`, { kind: 'data', table: table.name, page: String(page + 1) });
            return { ...result, table: table.name, rows: rows.results.length };
          });
          parts.push(part);
        }
      }
      const indexesKey = `${prepared.prefix}/${String(partNumber).padStart(5, '0')}-indexes.sql`;
      parts.push(await step.do(`attempt ${attempt}: indexes`, () => putPart(env, indexesKey, prepared.indexSql, { kind: 'indexes' })));
      parts.push(await step.do(`attempt ${attempt}: object references`, () => objectReferencePart(env, prepared.prefix)));
      const verified = await step.do(`attempt ${attempt}: verify`, async () => (await contentFingerprint(env)) === prepared.fingerprint);
      if (!verified) {
        await step.do(`attempt ${attempt}: discard changed snapshot`, async () => { await env.BLOG_BACKUPS.delete(parts.map((part) => part.key)); return true; });
        continue;
      }
      const manifestBody = JSON.stringify({
        format: 'ysoseri-blog-sql-parts-v1', generatedAt: prepared.generatedAt, completedAt: new Date().toISOString(),
        source: 'blog-content', schemaVersion: prepared.schemaVersion, fingerprint: prepared.fingerprint,
        retentionDays,
        tables: prepared.tables, excludedTransientTables: [...transientTables], parts,
        partsChecksum: await sha256Hex(JSON.stringify(parts.map((part) => part.checksum))),
        restore: 'Concatenate SQL parts in manifest order, import into a new D1 database, verify counts and R2 references, then rebuild blog-search.',
      }, null, 2);
      const manifest = await step.do(`attempt ${attempt}: manifest`, () => putPart(env, `${prepared.prefix}/manifest.json`, manifestBody, {
        kind: 'manifest', schemaVersion: prepared.schemaVersion, retentionDays: String(retentionDays),
      }));
      return { manifest: manifest.key, parts: parts.length, fingerprint: prepared.fingerprint };
    }
    throw new Error('内容在三次备份窗口中持续变化；未生成可能不一致的备份');
}

export class BlogBackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: Readonly<WorkflowEvent<BackupParams>>, step: WorkflowStep): Promise<unknown> {
    return runBackupWorkflow(this.env, event.payload.scheduledTime, step);
  }
}

export async function startDailyBackup(env: Env, scheduledTime: number): Promise<void> {
  const id = `daily-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  try {
    await env.BLOG_BACKUP_WORKFLOW.create({ id, params: { scheduledTime }, retention: { successRetention: '30 days', errorRetention: '30 days' } });
  } catch (error) {
    if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return;
    throw error;
  }
}
