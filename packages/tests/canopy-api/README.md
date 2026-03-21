# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

## Scripts

- `pnpm --filter @canopy/api-e2e exec playwright test`: All projects (**local** + **remote**) — same as **`task test:e2e`** at repo root.
- `pnpm --filter @canopy/api-e2e test:e2e`: **Remote** project only (`--project=remote`).
- `pnpm --filter @canopy/api-e2e test:e2e:local`: **Local** project only.
- `pnpm --filter @canopy/api-e2e test:e2e:remote`: Alias for `test:e2e`.

### Running the grant-flow test (mint → register → poll → resolve → POST entry)

The grant-flow test is **skipped** when the API does not have bootstrap or queue configured. To run it:

- **Remote (full stack):** Run against a deployment that has delegation-signer, queue, and a consumer (e.g. ranger) so status eventually returns a receipt:
  ```bash
  CANOPY_E2E_BASE_URL=https://your-canopy-api.example.com pnpm run test:e2e:remote
  ```
  Or run only the grant flow spec: `pnpm exec playwright test --project=remote -g "Forestrie-Grant flow"`.

- **Local with bootstrap + queue:** Start the local API with bootstrap and queue env set (e.g. in `packages/apps/canopy-api/wrangler.jsonc` vars: `ROOT_LOG_ID`, `DELEGATION_SIGNER_URL`, `DELEGATION_SIGNER_BEARER_TOKEN`). The queue (DO) is already bound in wrangler. Then run `pnpm run test:e2e:local`. Mint and register can succeed; **poll** may still skip with "Poll timeout" unless a queue consumer (e.g. ranger) is running to produce the receipt.

- **Local with test-key delegation-signer (no GCP KMS):** Start the delegation-signer in test-key mode, then point canopy-api at it. No GCP credentials needed. From repo root:
  1. Start delegation-signer: `task wrangler:dev:delegation-signer` (runs on port 8791; copies `.dev.vars.example` to `.dev.vars` if missing).
  2. Configure canopy-api with e.g. `DELEGATION_SIGNER_URL=http://localhost:8791`, `DELEGATION_SIGNER_BEARER_TOKEN=test`, `ROOT_LOG_ID=<64 hex or UUID>` (via wrangler vars or `.dev.vars` in canopy-api).
  3. Start canopy-api: `task wrangler:dev`.
  4. Run `pnpm run test:e2e:local` or `BASE_URL=http://localhost:8788 pnpm run verify:grant-flow`. Poll will still time out unless a queue consumer is running; mint and register will succeed.

## Environment Variables

- `CANOPY_E2E_API_TOKEN`: Optional bearer token used for authorized scenarios. Defaults to `test-api` if not provided; adjust when pointing at real deployments—authorized specs skip while the placeholder is in use.
- `CANOPY_E2E_BASE_URL`: Remote base URL override (defaults to the dev worker URL).
- `CANOPY_E2E_LOCAL_PORT`: Overrides the port used when spawning `wrangler dev` (defaults to the port declared in `packages/apps/canopy-api/wrangler.jsonc`, currently `8789`).
- `CANOPY_E2E_DISABLE_WEBSERVER`: Set to `true` to skip starting canopy-api for runs that only hit a remote base URL (normally auto when `--project=remote`).

## Test layout

| File | Area |
|------|------|
| `api.spec.ts` | Cross-cutting HTTP (e.g. CORS OPTIONS). |
| `observability.spec.ts` | `/api/health`, `/.well-known/scitt-configuration` (metrics endpoint TBD). |
| `grants-bootstrap.spec.ts` | `POST /api/grants/bootstrap` (ES256 / KS256). |
| `grants.spec.ts` | Register-grant, receipt poll, `POST /logs/.../entries` (Forestrie-Grant). |

- Fixtures: `tests/fixtures`.
- Shared e2e utils: `tests/utils/` (`bootstrap-availability.ts`, `grant-flow-poll.ts`, `grant-completion.ts`, `problem-details.ts`).
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
