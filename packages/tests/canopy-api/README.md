# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

## Scripts

- `pnpm --filter @canopy/api-e2e test:e2e`: Run all projects (local + remote).
- `pnpm --filter @canopy/api-e2e test:e2e:local`: Boot `wrangler dev` and exercise the local worker.
- `pnpm --filter @canopy/api-e2e test:e2e:remote`: Target a remote deployment defined by `CANOPY_E2E_BASE_URL`.

### Running the grant-flow test (mint → register → poll → resolve → POST entry)

The grant-flow test is **skipped** when the API does not have bootstrap or queue configured. To run it:

- **Remote (full stack):** Run against a deployment that has delegation-signer, queue, and a consumer (e.g. ranger) so status eventually returns a receipt:
  ```bash
  CANOPY_E2E_BASE_URL=https://your-canopy-api.example.com pnpm run test:e2e:remote
  ```
  Or run only the grant-flow spec: `pnpm exec playwright test --project=remote -g "grant flow"`.

- **Local with bootstrap + queue:** Start the local API with bootstrap and queue env set (e.g. in `packages/apps/canopy-api/wrangler.jsonc` vars: `ROOT_LOG_ID`, `DELEGATION_SIGNER_URL`, `DELEGATION_SIGNER_BEARER_TOKEN`). The queue (DO) is already bound in wrangler. Then run `pnpm run test:e2e:local`. Mint and register can succeed; **poll** may still skip with "Poll timeout" unless a queue consumer (e.g. ranger) is running to produce the receipt.

## Environment Variables

- `CANOPY_E2E_API_TOKEN`: Optional bearer token used for authorized scenarios. Defaults to `test-api` if not provided; adjust when pointing at real deployments—authorized specs skip while the placeholder is in use.
- `CANOPY_E2E_BASE_URL`: Remote base URL override (defaults to the dev worker URL).
- `CANOPY_E2E_LOCAL_PORT`: Overrides the port used when spawning `wrangler dev` (defaults to the port declared in `packages/apps/canopy-api/wrangler.jsonc`, currently `8789`).

## Test Layout

- Fixtures live in `tests/fixtures`.
- Specs live under `tests/` and focus on HTTP-level coverage.
- Worker-level unit and integration tests remain in `packages/apps/canopy-api/test`.
