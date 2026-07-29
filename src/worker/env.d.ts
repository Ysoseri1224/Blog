// Wrangler 能从配置生成普通绑定；Secret 不写入配置，因此仅在这里补充 Secret 的类型。
declare global {
  interface Env {
    AUTH_PASSWORD_HASH: string;
    IMPORT_EXPORT_SIGNING_KEY: string;
  }

  namespace Cloudflare {
    interface Env {
      AUTH_PASSWORD_HASH: string;
      IMPORT_EXPORT_SIGNING_KEY: string;
    }
  }
}

export {};
