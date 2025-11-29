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
          // Enable local R2_LEAVES and KV bindings for testing
          r2Buckets: ["R2_LEAVES"],
          kvNamespaces: ["RANGER_MMR_INDEX", "RANGER_MMR_MASSIFS"],
          // Persist data between test runs (optional)
          r2Persist: ".wrangler/state/v3/r2",
          kvPersist: ".wrangler/state/v3/kv",
        },
      },
    },
  },
});
