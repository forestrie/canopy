import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    inspector: {
      enabled: true,
      port: 9229, //,
      //waitForDebugger: true
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          // Enable local R2_LEAVES bindings for testing
          r2Buckets: ["R2_LEAVES"],
          // Persist data between test runs (optional)
          r2Persist: ".wrangler/state/v3/r2",
        },
      },
    },
  },
});
