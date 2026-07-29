import { pbkdf2Sync } from 'node:crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const testPassword = 'blog-test-password';
const iterations = 100_000;
const salt = Buffer.from('ysoseri-blog-tests', 'utf8');
const passwordHash = pbkdf2Sync(testPassword, salt, iterations, 32, 'sha256');
const encodedPassword = `pbkdf2$${iterations}$${salt.toString('hex')}$${passwordHash.toString('hex')}`;

export default defineConfig(async () => {
  const [contentMigrations, searchMigrations] = await Promise.all([
    readD1Migrations('./migrations/content'),
    readD1Migrations('./migrations/search'),
  ]);

  return {
    plugins: [cloudflareTest({
      main: './src/worker/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          AUTH_PASSWORD_HASH: encodedPassword,
          IMPORT_EXPORT_SIGNING_KEY: 'blog-test-export-signing-key-with-at-least-32-bytes',
          TEST_CONTENT_MIGRATIONS: contentMigrations,
          TEST_SEARCH_MIGRATIONS: searchMigrations,
        },
      },
    })],
    test: {
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 20_000,
      hookTimeout: 20_000,
    },
  };
});
