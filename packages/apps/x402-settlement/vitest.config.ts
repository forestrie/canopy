import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        singleWorker: true,
        // Isolated storage cannot pop a DO storage frame when a Durable Object
        // method throws, and ReceivablesDO's validation tests exercise exactly
        // that (vitest-pool-workers known issue: #isolated-storage). Tests
        // self-isolate by addressing a unique DO name per case instead.
        isolatedStorage: false,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          durableObjectsPersist: ".wrangler/state/v3/do",
        },
      },
    },
  },
});
