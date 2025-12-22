import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    inspector: {
      enabled: true,
      port: 9231,
    },
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
      },
    },
  },
});



