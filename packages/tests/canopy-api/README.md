# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

Tests run against a **deployed** worker URL. They do **not** start wrangler or emulate delegation-signer / univocity locally.

## Prerequisites

From the **repo root**, run:

```bash
task test:e2e:preflight
```

That installs Playwright/Chromium and runs **`task vars:doppler:{{ENV}}`** so **repo-root `.env`**
(gitignored) is hydrated from Doppler (default **`ENV=dev`**). See **`taskfiles/e2e-setup.md`**.

## Scripts

- `pnpm --filter @canopy/api-e2e exec playwright test` — all tests (**`dev`** project)
- `pnpm --filter @canopy/api-e2e test:e2e` — same as above (`--project=dev`)

### Grant flow (mint → register → poll → resolve → POST entry)

Requires a **fully wired** deployment: bootstrap mint, sequencing queue, a consumer that
drains it, and any univocity / DO configuration the worker expects. Poll timeouts or
non-201/303/200 responses are **test failures** — fix the environment or increase
`GRANT_FLOW_POLL_*` in `tests/utils/grant-flow-poll.ts` only if the stack is correct but slow.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env` only**. If the file is missing,
Playwright throws before loading tests.

Relevant keys:

- **`CANOPY_BASE_URL`**: Worker origin (required)
- **`SCRAPI_API_KEY`**: Bearer for authorized scenarios (**required** with **`CANOPY_BASE_URL`**)

## Test layout

| File                       | Area                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `api.spec.ts`              | Cross-cutting HTTP (e.g. CORS OPTIONS).                                   |
| `observability.spec.ts`    | `/api/health`, `/.well-known/scitt-configuration` (metrics endpoint TBD). |
| `grants-bootstrap.spec.ts` | `POST /api/grants/bootstrap` (ES256 / KS256).                             |
| `grants.spec.ts`           | Register-grant, receipt poll, `POST /logs/.../entries` (Forestrie-Grant). |

- Fixtures: `tests/fixtures`.
- Shared e2e utils: `tests/utils/` (`grant-flow-poll.ts`, `grant-completion.ts`, `problem-details.ts`).
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
