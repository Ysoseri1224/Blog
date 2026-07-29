import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await Promise.all([
    applyD1Migrations(env.CONTENT_DB, env.TEST_CONTENT_MIGRATIONS),
    applyD1Migrations(env.SEARCH_DB, env.TEST_SEARCH_MIGRATIONS),
  ]);
});
