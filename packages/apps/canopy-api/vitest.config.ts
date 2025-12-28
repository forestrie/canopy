import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    inspector: {
      enabled: true,
      port: 9229,
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          // Use test-specific config without cross-worker DO bindings
          configPath: "./wrangler.test.jsonc",
        },
        miniflare: {
          // Enable local R2 bucket bindings for testing.
          r2Buckets: ["R2_MMRS"],
          // Persist data between test runs (optional)
          r2Persist: ".wrangler/state/v3/r2",
          durableObjectsPersist: ".wrangler/state/v3/do",
        },
      },
    },
  },
});
