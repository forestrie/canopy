import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        singleWorker: true,
        // Isolated storage cannot pop a Durable Object storage frame when a DO
        // method throws, and ReceivablesDO throws deliberately — the identity
        // guard MUST be loud rather than return an ignorable value. Verified:
        // re-enabling this fails the suite outright (vitest-pool-workers known
        // issue, #isolated-storage).
        //
        // Mitigation: every DO test addresses a UNIQUE object name, so cases
        // cannot observe each other's state. Any new DO test must do the same
        // — see freshStub() in test/receivables.test.ts.
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
