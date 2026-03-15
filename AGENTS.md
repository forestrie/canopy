# AGENTS.md

## Cursor Cloud specific instructions

Canopy is a SCITT/SCRAPI transparency log built as a pnpm monorepo of Cloudflare Workers. See `README.md` for full prerequisites and setup.

### Services overview

| Package | Port | Purpose |
|---------|------|---------|
| `@canopy/api` | 8789 | Main SCRAPI HTTP API |
| `@canopy/forestrie-ingress` | 8791 | SequencingQueue Durable Object host |
| `@canopy/x402-settlement` | 8792 | x402 payment settlement worker |
| `@canopy/delegation-signer` | 8791 | COSE delegation signing (GCP KMS) |

### Key commands

- **Install**: `pnpm install`
- **Unit tests**: `pnpm -r test` (uses Vitest + `@cloudflare/vitest-pool-workers`; no external services needed)
- **Format check**: `pnpm check` (Prettier)
- **Type check**: `pnpm -r --filter './packages/**' typecheck`
- **Dev server (canopy-api)**: `pnpm --filter @canopy/api dev` (wrangler dev on port 8789)
- **E2E tests (local)**: `pnpm test:e2e:local` (starts wrangler dev automatically via Playwright `webServer`)
- **Build (dry-run)**: `pnpm -r build`

### Gotchas

- There is no `lint` script in any package. Linting is done via `pnpm check` (Prettier) and `pnpm -r --filter './packages/**' typecheck` (TypeScript).
- Unit tests for worker packages (`canopy-api`, `forestrie-ingress`, `delegation-signer`, `x402-settlement`) run inside Miniflare via `@cloudflare/vitest-pool-workers`. R2 buckets and Durable Objects are emulated locally — no Cloudflare account needed.
- `canopy-api` uses a test-specific wrangler config (`wrangler.test.jsonc`) that omits cross-worker DO bindings. Tests requiring DO interaction are skipped in unit tests and covered by E2E tests.
- When running `pnpm --filter @canopy/api dev` alone, endpoints that call cross-worker Durable Objects (e.g. `POST /logs/{logId}/grants`, `POST /logs/{logId}/entries`) return 500 because the forestrie-ingress worker is not running. Start both workers for full integration: `pnpm --filter @canopy/api dev` and `pnpm --filter @canopy/forestrie-ingress dev` in separate terminals.
- API responses use CBOR encoding (not JSON), except for `/api/health` and `/.well-known/scitt-configuration` which return JSON.
- pnpm 10 skips dependency build scripts by default. The unit tests and dev server work without running those build scripts (workerd, esbuild, etc. are handled by wrangler internally).
