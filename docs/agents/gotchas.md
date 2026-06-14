# Operational gotchas (Canopy)

Extended notes beyond [AGENTS.md](../../AGENTS.md) critical gotchas.

## Vitest / Miniflare

- Worker unit tests use `@cloudflare/vitest-pool-workers`; R2 and DOs emulated locally.
- `wrangler.test.jsonc` sets `NODE_ENV=test` and omits cross-worker DO bindings.
- **`NODE_ENV === "test"`** skips deployment checks (`CUSTODIAN_URL`, queue,
  `CUSTODIAN_APP_TOKEN`); real workers need those or routes return **503**.
- Playwright e2e uses dev/prod-like `NODE_ENV`, not `test`.

## Local wrangler dev

- Copy `packages/apps/canopy-api/.dev.vars.bootstrap-example` → `.dev.vars`.
- Without `CUSTODIAN_APP_TOKEN`, non-pool routes return **503** CBOR before health.
- Two `wrangler dev` processes default to inspector **9229**; use
  `--inspector-port 9230` on the second worker.

## SequencingQueue (forestrie-ingress)

- Ranger pulls `{RANGER_INGRESS_QUEUE_URL}/queue/pull` (per slot:
  `https://ingress.{slot}.{DNS_SUB}.{DNS_APEX}/canopy/ingress-queue`).
- Per-slot script: `forestrie-ingress-{DNS_SUB}-{a|b}`; custom domain on
  `ingress.{slot}.{DNS_SUB}.*`.
- Historical bug recycled `nextSeq` without `dead_letters` max — fixed in
  `SequencingQueue.initializeFromStorage()`.
- **Dev-only reset**: `INGRESS_RESET_TOKEN` + `POST …/queue/admin/reset-storage?shard=all`
  with header `X-Forestrie-Ingress-Reset` (404 in production).

## Bootstrap grant Playwright (system project)

- Mint is runner-side: Custodian `POST /api/keys` + ES256 sign, curator genesis.
- Worker verifies against genesis and grantData (no `:bootstrap` alias).
- Fresh UUID per test for MMRS-cold bootstrap branch.
- Polling/receipt tests require forestrie-ingress on the same stack.

## TypeScript (api-e2e)

- `packages/tests/canopy-api/tsconfig.json` uses `module: ES2022`,
  `moduleResolution: bundler` for `import.meta` in Playwright config.

## pnpm 10

- Skips dependency build scripts by default; wrangler handles workerd/esbuild internally.
