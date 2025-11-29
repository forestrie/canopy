# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

## Scripts

- `pnpm --filter @canopy/api-e2e test:e2e`: Run all projects (local + remote).
- `pnpm --filter @canopy/api-e2e test:e2e:local`: Boot `wrangler dev` and exercise the local worker.
- `pnpm --filter @canopy/api-e2e test:e2e:remote`: Target a remote deployment defined by `CANOPY_E2E_BASE_URL`.

## Environment Variables

- `CANOPY_E2E_API_TOKEN`: Optional bearer token used for authorized scenarios. Defaults to `test-api` if not provided; adjust when pointing at real deployments—authorized specs skip while the placeholder is in use.
- `CANOPY_E2E_BASE_URL`: Remote base URL override (defaults to the dev worker URL).
- `CANOPY_E2E_LOCAL_PORT`: Overrides the port used when spawning `wrangler dev` (defaults to the port declared in `packages/apps/canopy-api/wrangler.jsonc`, currently `8789`).

## Test Layout

- Fixtures live in `tests/fixtures`.
- Specs live under `tests/` and focus on HTTP-level coverage.
- Worker-level unit and integration tests remain in `packages/apps/canopy-api/test`.
