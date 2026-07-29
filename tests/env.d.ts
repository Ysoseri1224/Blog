import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_CONTENT_MIGRATIONS: D1Migration[];
      TEST_SEARCH_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
