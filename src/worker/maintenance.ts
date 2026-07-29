export async function retryObjectDeletionQueue(env: Env): Promise<void> {
  const pending = await env.CONTENT_DB.prepare(
    'SELECT id,object_key FROM object_deletion_queue WHERE completed_at IS NULL ORDER BY created_at LIMIT 50',
  ).all<{ id: string; object_key: string }>();
  for (const item of pending.results) {
    try {
      await env.BLOG_ARCHIVE.delete(item.object_key);
      await env.CONTENT_DB.prepare(
        `UPDATE object_deletion_queue SET completed_at=?1,attempts=attempts+1,last_error=NULL
          WHERE id=?2 AND completed_at IS NULL`,
      ).bind(new Date().toISOString(), item.id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await env.CONTENT_DB.prepare(
        'UPDATE object_deletion_queue SET attempts=attempts+1,last_error=?1 WHERE id=?2 AND completed_at IS NULL',
      ).bind(message.slice(0, 500), item.id).run();
    }
  }
}

export async function pruneAutoVersions(env: Env): Promise<void> {
  const posts = await env.CONTENT_DB.prepare("SELECT DISTINCT post_id FROM post_versions WHERE kind='auto'").all<{ post_id: string }>();
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
  for (const post of posts.results) {
    const removable = await env.CONTENT_DB.prepare(
      `SELECT id,object_key FROM post_versions WHERE post_id=?1 AND kind='auto' AND permanent=0 AND created_at < ?2
       AND id NOT IN (SELECT id FROM post_versions WHERE post_id=?1 AND kind='auto' ORDER BY created_at DESC LIMIT 100)`,
    ).bind(post.post_id, cutoff).all<{ id: string; object_key: string }>();
    if (!removable.results.length) continue;
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const version of removable.results) {
      statements.push(env.CONTENT_DB.prepare(
        `INSERT OR IGNORE INTO object_deletion_queue (id,object_key,kind,created_at)
         SELECT ?1,object_key,'auto_version',?2 FROM post_versions WHERE id=?3 AND object_key=?4`,
      ).bind(crypto.randomUUID(), now, version.id, version.object_key));
      statements.push(env.CONTENT_DB.prepare('DELETE FROM post_versions WHERE id=?1 AND object_key=?2')
        .bind(version.id, version.object_key));
    }
    await env.CONTENT_DB.batch(statements);
  }
  await retryObjectDeletionQueue(env);
  await env.CONTENT_DB.prepare('DELETE FROM object_deletion_queue WHERE completed_at<?1')
    .bind(new Date(Date.now() - 30 * 86400_000).toISOString()).run();
  await env.CONTENT_DB.prepare('DELETE FROM sessions WHERE expires_at < ?1 OR (revoked_at IS NOT NULL AND revoked_at < ?2)')
    .bind(new Date().toISOString(), new Date(Date.now() - 30 * 86400_000).toISOString()).run();
}
