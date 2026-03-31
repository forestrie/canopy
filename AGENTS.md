# AGENTS.md

## Cursor Cloud specific instructions

Canopy is a SCITT/SCRAPI transparency log built as a pnpm monorepo of Cloudflare Workers. See `README.md` for full prerequisites and setup.

### Services overview

| Package | Port | Purpose |
|---------|------|---------|
| `@canopy/api` | 8789 | Main SCRAPI HTTP API |
| `@canopy/forestrie-ingress` | 8791 | SequencingQueue Durable Object host |
| `@canopy/x402-settlement` | 8792 | x402 payment settlement worker |
| `@canopy/delegation-signer` | 8791 | COSE delegation signing (Custodian raw-sign or GCP KMS) |

### Key commands

- **Install**: `pnpm install`
- **Unit tests**: `pnpm -r test` (uses Vitest + `@cloudflare/vitest-pool-workers`; no external services needed)
- **Format check**: `pnpm check` (Prettier)
- **Type check**: `pnpm -r --filter './packages/**' typecheck` (includes `pnpm --filter @canopy/api-e2e typecheck` when that script is present)
- **Dev server (canopy-api)**: `pnpm --filter @canopy/api dev` (wrangler dev on port 8789)
- **E2E tests**: In CI, workflows export vars and run Playwright directly. **Locally**, prefer `task test:e2e:doppler` (or hydrate `.env` via `task test:e2e:preflight` then `pnpm test:e2e`). Do not add Doppler to `@canopy/api-e2e` package scripts — see `.cursor/rules/e2e-local-doppler.mdc` and `taskfiles/e2e-setup.md`.
- **Build (dry-run)**: `pnpm -r build`

### Gotchas

- There is no `lint` script in any package. Linting is done via `pnpm check` (Prettier) and `pnpm -r --filter './packages/**' typecheck` (TypeScript).
- Unit tests for worker packages (`canopy-api`, `forestrie-ingress`, `delegation-signer`, `x402-settlement`) run inside Miniflare via `@cloudflare/vitest-pool-workers`. R2 buckets and Durable Objects are emulated locally — no Cloudflare account needed.
- `canopy-api` uses a test-specific wrangler config (`wrangler.test.jsonc`) that omits cross-worker DO bindings. Tests requiring DO interaction are skipped in unit tests and covered by E2E tests.
- When running `pnpm --filter @canopy/api dev` alone, endpoints that call cross-worker Durable Objects (e.g. `POST /logs/{logId}/grants`, `POST /logs/{logId}/entries`) return 500 because the forestrie-ingress worker is not running. Start both workers for full integration: `pnpm --filter @canopy/api dev` and `pnpm --filter @canopy/forestrie-ingress dev` in separate terminals.
- **SequencingQueue (forestrie-ingress) on api-dev**: Ranger pulls `https://api-dev.forestrie.dev/canopy/ingress-queue/queue/pull`. A historical bug recycled `nextSeq` without considering `dead_letters`, which could cause `UNIQUE constraint failed: dead_letters.seq` on `pull` until storage was cleared; **fix** is in `SequencingQueue.initializeFromStorage()` (max `seq` over `queue_entries` **and** `dead_letters`). **Dev-only emergency reset** (wipes all shard SQLite/KV for the queue): set Worker secret `INGRESS_RESET_TOKEN`, then `POST https://api-dev.forestrie.dev/canopy/ingress-queue/queue/admin/reset-storage?shard=all` with header `X-Forestrie-Ingress-Reset: <token>`. Only exposed when `NODE_ENV` is `dev` on **forestrie-ingress**; production returns 404 for that path. See `packages/apps/forestrie-ingress/src/handlers/admin-reset-storage.ts`.
- **`@canopy/api-e2e` TypeScript**: `packages/tests/canopy-api/tsconfig.json` uses `module: "ES2022"` and `moduleResolution: "bundler"` (the package is `"type": "module"`) so `import.meta` in `playwright.config.ts` typechecks and specs can import `@canopy/api` `src` helpers (e.g. transparent-statement assembly) without a `commonjs`/`import.meta` mismatch. Use `pnpm --filter @canopy/api-e2e typecheck` to verify tests and config locally.
- **Bootstrap grant Playwright (`packages/tests/canopy-api`, `--project=dev`)**: Tests that use the fixed **`DEFAULT_ROOT_LOG_ID`** assume that root log is still on the **bootstrap** branch (no MMRS / uninitialized in storage). After Ranger sequences real grants for that log on api-dev, `POST /logs/{logId}/grants` takes the **receipt-based inclusion** path and returns **403** (“header **396**” / SCITT receipt) for a Custodian-only mint — that is **expected**, not a queue outage. The **random `logId`** test (including **second** `POST /logs/{logId}/grants` with a completed Forestrie-Grant after resolve-receipt) exercises bootstrap + sequencing + receipt auth; run that case for healthy queue verification, or use a fresh root log ID in dev MMRS.
- API responses use CBOR encoding (not JSON), except for `/api/health` and `/.well-known/scitt-configuration` which return JSON.
- pnpm 10 skips dependency build scripts by default. The unit tests and dev server work without running those build scripts (workerd, esbuild, etc. are handled by wrangler internally).
