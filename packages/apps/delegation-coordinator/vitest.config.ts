import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    inspector: {
      enabled: true,
      port: 9232,
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        // DO sqlite can leave .sqlite-shm during teardown; shared storage is fine here.
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
