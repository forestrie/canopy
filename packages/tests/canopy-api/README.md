# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

Tests run against a **deployed** worker URL. They do **not** start wrangler, Custodian, or Univocity locally.

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

### Bootstrap grant (mint + register-grant)

`tests/grants-bootstrap.spec.ts` exercises **Custodian-backed** bootstrap mint and **register-grant on the bootstrap branch** (303 See Other with a registration-status `Location`).

That requires a suitably configured deployment: **`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**, sequencing queue bindings, `bootstrapEnv` + `queueEnv`, and Univocity reporting the target root log as **not** initialized. If the log is already initialized or the queue is missing, register-grant will not return 303 for this flow—fix the environment or use a fresh `rootLogId` in the spec.

Receipt polling, completed transparent statements, and `POST /logs/.../entries` are **not** covered here (removed as stale vs Plan 0014 Custodian wire format); use Worker Vitest (`packages/apps/canopy-api/test`) or perf scripts for deeper grant lifecycle checks.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env`** (after `task vars:doppler:dev`) **and** the process environment. If `.env` is missing locally, Playwright throws (unless `CI` is set).

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. `https://api-dev.example.com` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/test.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**Bootstrap grant e2e** (`grants-bootstrap.spec.ts`):

- Requires the **deployed** worker to implement Plan 0014 bootstrap mint (**`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** on the Worker). If mint returns **503** with a “not configured” problem detail, those tests are **skipped** with a message (so `task test:e2e` still passes while a shared dev worker is behind `main`).
- Set **`E2E_REQUIRE_BOOTSTRAP=1`** to **fail** the run when bootstrap mint is unavailable (use in CI once the target deployment is Custodian-backed).
- Responses mentioning **`DELEGATION_SIGNER_*`** mean the live worker is an **older build** than this repository; redeploy canopy-api from current `main`.

Other keys:

- **`SCRAPI_API_KEY`**: Bearer for authorized fixtures (optional for current specs that use `unauthorizedRequest` only).

## Test layout

| File                       | Area                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `api.spec.ts`              | Cross-cutting HTTP (e.g. CORS OPTIONS).                              |
| `observability.spec.ts`    | `/api/health`, `/.well-known/scitt-configuration` (metrics TBD).     |
| `grants-bootstrap.spec.ts` | Bootstrap mint + register-grant (Custodian-profile Forestrie-Grant). |

- Fixtures: `tests/fixtures`.
- Shared e2e utils: `tests/utils/problem-details.ts`, `tests/utils/bootstrap-e2e-guard.ts`.
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
