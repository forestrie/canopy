import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Default project: isolated storage ON, so writes roll back between tests.
 *
 * `test/receivables.test.ts` is excluded and runs as its own project — see
 * `vitest.receivables.config.ts` for why.
 */
export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    exclude: ["**/node_modules/**", "test/receivables*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
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
