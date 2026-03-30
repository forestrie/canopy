# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

Tests run against a **deployed** worker URL. They do **not** start wrangler or Custodian locally.

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

That requires a suitably configured deployment: **`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**, **`R2_MMRS`**, sequencing queue bindings, `bootstrapEnv` + `queueEnv`, and **no** first massif object for the target log in MMRS (same key layout as resolve-receipt). If that massif already exists or the queue is missing, register-grant will not return 303 for this flow—fix the environment or use a fresh `rootLogId` in the spec.

A third test (**poll query-registration-status → SCITT receipt**, assert **mmrIndex 0**) runs a fresh UUID root log, mint + register (HTTP 201 / 303 only), then polls with an arithmetic delay ladder (`sequencingBackoff` in `tests/utils/arithmetic-backoff-poll.ts`). That path needs **forestrie-ingress** (or equivalent) processing the same SequencingQueue so MMRS is written—see repo **`AGENTS.md`**. If you only have **canopy-api-dev** without ingress, set **`E2E_SKIP_SEQUENCING_POLL=1`** to skip that test.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env`** (after `task vars:doppler:dev`) **and** the process environment. If `.env` is missing locally, Playwright throws (unless `CI` is set).

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. `https://api-dev.example.com` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/test.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**Bootstrap grant e2e** (`grants-bootstrap.spec.ts`):

- Requires the **deployed** worker to implement Plan 0014 bootstrap mint (**`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** on the Worker). If mint returns **503** with a “not configured” problem detail, those tests are **skipped** with a message (so `task test:e2e` still passes while a shared dev worker is behind `main`).
- Set **`E2E_REQUIRE_BOOTSTRAP=1`** to **fail** the run when bootstrap mint is unavailable (use in CI once the target deployment is Custodian-backed).
- **`E2E_SKIP_SEQUENCING_POLL=1`**: skip only the registration-status polling / receipt test when ingress is not running against the same dev stack.
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
