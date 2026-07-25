import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * ReceivablesDO tests, isolated storage OFF.
 *
 * The pool cannot pop a Durable Object storage frame when a DO method throws,
 * and ReceivablesDO throws deliberately — its identity guard must be loud
 * rather than return a value a caller can ignore. Enabling isolation here
 * fails the run outright (vitest-pool-workers known issue, #isolated-storage).
 *
 * Confining that to this one project keeps automatic rollback for every other
 * test in the package. These tests self-isolate instead, by addressing a
 * unique Durable Object name per case — see `freshStub()`. Any test added here
 * must do the same.
 */
export default defineWorkersProject({
  test: {
    globals: true,
    name: "receivables",
    include: ["test/receivables.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
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
