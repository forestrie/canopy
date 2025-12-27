import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    inspector: {
      enabled: true,
      port: 9230,
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          // R2 buckets and Durable Objects are loaded from wrangler.jsonc
          // Persist data between test runs (optional)
          r2Persist: ".wrangler/state/v3/r2",
          durableObjectsPersist: ".wrangler/state/v3/do",
        },
      },
    },
  },
});
