import { extractWikiTargets } from './markdown';

export async function resolveWikiTargets(
  env: Env,
  markdown: string,
  publicOnly: boolean,
): Promise<Map<string, { url: string; title: string; html?: string } | null>> {
  const mapped = new Map<string, { url: string; title: string; html?: string } | null>();
  for (const target of extractWikiTargets(markdown)) {
    const result = publicOnly
      ? await env.CONTENT_DB.prepare(
        `SELECT s.title,s.public_repository_key AS url_key,s.public_slug AS slug,s.object_key
           FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id
           JOIN repositories r ON r.id=s.repository_id
          WHERE s.title=?1 AND p.public_visible=1 AND r.visibility!='private' LIMIT 2`,
      ).bind(target).all<{ title: string; url_key: string; slug: string; object_key: string }>()
      : await env.CONTENT_DB.prepare(
        `SELECT p.title,r.url_key,p.slug FROM posts p JOIN repositories r ON r.id=p.repository_id
          WHERE p.title=?1 AND p.deleted_at IS NULL LIMIT 2`,
      ).bind(target).all<{ title: string; url_key: string; slug: string }>();
    if (result.results.length !== 1 || !result.results[0]) {
      mapped.set(target, null);
      continue;
    }
    const row = result.results[0];
    if (!publicOnly || !('object_key' in row) || typeof row.object_key !== 'string') {
      mapped.set(target, { title: row.title, url: `/${row.url_key}/${row.slug}` });
      continue;
    }
    const object = await env.BLOG_ARCHIVE.get(row.object_key);
    const snapshot = object ? await object.json<{ html?: string }>() : null;
    mapped.set(target, { title: row.title, url: `/${row.url_key}/${row.slug}`, html: snapshot?.html });
  }
  return mapped;
}

export async function resolveLinkTargets(
  env: Env,
  links: string[],
  publicOnly = false,
): Promise<Array<{ postId: string; url: string }>> {
  const targets: Array<{ postId: string; url: string }> = [];
  for (const raw of links) {
    let url: URL;
    try { url = new URL(raw, env.SITE_ORIGIN); } catch { continue; }
    if (url.origin !== env.SITE_ORIGIN) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) continue;
    const row = publicOnly
      ? await env.CONTENT_DB.prepare(
        `SELECT p.id,s.public_repository_key AS url_key,s.public_slug AS slug
           FROM posts p JOIN public_snapshots s ON s.id=p.public_snapshot_id
           JOIN repositories r ON r.id=s.repository_id
          WHERE s.public_repository_key=?1 AND s.public_slug=?2 AND p.public_visible=1
            AND p.deleted_at IS NULL AND r.visibility!='private'`,
      ).bind(parts[0], parts[1]).first<{ id: string; url_key: string; slug: string }>()
      : await env.CONTENT_DB.prepare(
        `SELECT p.id,r.url_key,p.slug FROM posts p JOIN repositories r ON r.id=p.repository_id
          WHERE r.url_key=?1 AND p.slug=?2 AND p.deleted_at IS NULL`,
      ).bind(parts[0], parts[1]).first<{ id: string; url_key: string; slug: string }>();
    if (row) targets.push({ postId: row.id, url: `/${row.url_key}/${row.slug}` });
  }
  return targets;
}
