# Canopy API End-to-End Tests

This package houses the Playwright API-mode tests for the Canopy Worker. It depends on `@canopy/api` but keeps the runtime isolated so Cloudflare build and deploy scripts remain unchanged.

Tests run against a **deployed** worker URL. They do **not** start wrangler or Custodian locally.

## Playwright projects and layout

Specs live under `tests/` in three tiers (each tier is a Playwright **project** with `testMatch` on that folder):

| Project         | Directory             | Role                                                                                                              |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **integration** | `tests/integration/`  | Read-only / surface checks against **Canopy** only (CORS, health, SCRAPI discovery).                              |
| **system**      | `tests/system/`       | Full deployed stack: SCRAPI grants, sequencing, receipts (needs **forestrie-ingress**, MMRS, Custodian mint env). |
| **custodian**   | `tests/custodian/`    | Direct **Custodian** HTTP (`/v1/api/…`), not the SCRAPI grant path.                                               |
| **prod**        | (same files, filters) | Release checks: **excludes** mutating `tests/system/*` specs via `testIgnore` in `playwright.config.ts`.          |

Shared code: `tests/utils/`, `tests/fixtures/`. Imports use TypeScript path aliases (see `tsconfig.json`):

- `@e2e-utils/*` → `./tests/utils/*`
- `@e2e-fixtures/*` → `./tests/fixtures/*`
- `@e2e-canopy-api-src/*` → `../../apps/canopy-api/src/*` (only when not exported from `@canopy/api`)

## Prerequisites

From the **repo root**, run:

```bash
task test:e2e:preflight
```

That installs Playwright/Chromium and runs **`task vars:doppler:{{ENV}}`** so **repo-root `.env`**
(gitignored) is hydrated from Doppler (default **`ENV=dev`**). See **`taskfiles/e2e-setup.md`**.

## Scripts

- **Default (integration → system → custodian):** `pnpm --filter @canopy/api-e2e test:e2e` or root `pnpm test:e2e`.
- **Single tier:** `pnpm --filter @canopy/api-e2e test:e2e:integration` | `test:e2e:system` | `test:e2e:custodian` | `test:e2e:prod`.
- **CI / env already set:** same as above; workflows run projects explicitly (see `.github/workflows/api-e2e-playwright.yml`).
- **Local (Doppler):** do **not** use a Doppler-injected npm script — use **`task test:e2e:doppler`** from the repo root, or  
  `doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e`  
  (see **`.cursor/rules/e2e-local-doppler.mdc`**). Use `ENV=prod` with the task when targeting prod Doppler config.
- **Local (hydrated `.env`):** `task test:e2e:preflight` then `task test:e2e` or root `pnpm test:e2e`.

### Bootstrap grant (mint + register-grant)

`tests/system/grants-bootstrap.spec.ts` exercises **runner-side** bootstrap mint (per-root **`POST /api/keys`** with **`CUSTODIAN_APP_TOKEN`**, genesis **`POST /api/forest/{log-id}/genesis`** with **`CURATOR_ADMIN_TOKEN`**, then custody ES256 sign) and **`POST /register/{bootstrap-logid}/grants`** on the **bootstrap branch** (303 See Other with a registration-status `Location` under `/logs/{bootstrap}/{owner}/entries/…`).

The **deployed** worker needs **`R2_MMRS`**, sequencing queue bindings, and `bootstrapEnv` + `queueEnv`. Specs pick a **fresh UUID** per run so the target log has no MMRS massif yet for the first register-grant (303). Tests that poll sequencing and resolve receipts need **forestrie-ingress** on the same SequencingQueue — without it, **system** tests **fail** (no env-driven skips).

**First signed entry** (`tests/system/bootstrap-log-first-entry.spec.ts`): same stack requirements; mint → register → receipt, then runner **`POST /api/keys/{root-key}/sign`** and **`POST /register/{bootstrap}/entries`**. Missing **`CURATOR_ADMIN_TOKEN`** or **`CUSTODIAN_APP_TOKEN`** causes **hard failure** at mint (`assertBootstrapMintE2eEnv` / `assertSystemE2eEnv`).

**Child auth grant** (`tests/system/bootstrap-child-auth-grant.spec.ts`): root bootstrap mint plus an additional custody key for the child grant. Helpers: `@e2e-utils/custodian-custody-grant`.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env`** (after `task vars:doppler:dev`) **and** the process environment. If `.env` is missing locally, Playwright throws (unless `CI` is set).

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. `https://api-dev.example.com` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/test.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**System / bootstrap e2e** (`tests/system/*.spec.ts`):

- **Runner:** **`CURATOR_ADMIN_TOKEN`** (genesis), **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`** (create key + sign). The **Worker** must expose SCRAPI **`/register/{bootstrap}/…`** with queue/MMRS configured.
- If bootstrap mint env is missing, tests **fail** immediately with a clear error.
- **`E2E_RUN_ID`**: optional disambiguator for key labels (when used by helpers).

Other keys:

- **`SCRAPI_API_KEY`**: Bearer for authorized fixtures (optional for specs that use `unauthorizedRequest` only).

**Custodian API e2e** (`tests/custodian/custodian-api.spec.ts`, Playwright project **`custodian`**):

- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**: create key, public, sign, curator, list via **`/v1/api/…`** (ingress); ops probes use the URL **origin** only (`/healthz`, `/readyz`, …).
- **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**: required for teardown (`POST /v1/api/keys/{keyId}/delete`). If unset, the suite **fails** in `beforeAll` / teardown (no skip).

**Listing all custody keys:** **`GET /api/keys/list`** requires at least one label query parameter. To list **every** key in the custody ring, use **`POST /api/keys/list`** with CBOR **`labels: {}`** (see `postCustodianApiKeysListAll` in `tests/utils/custodian-api-keys-list.ts`). The dedicated bootstrap KMS key (`BOOTSTRAP_KMS_CRYPTO_KEY_ID` / `:bootstrap`) is not part of that ring unless you also created it there.

**Ops tasks (repo root):** `task custodian:keys-list` (needs **`CUSTODIAN_APP_TOKEN`** and **`CUSTODIAN_BASE_URL`** or default from `Taskfile.dist.yml`). `task custodian:keys-delete-all` lists keys then **dry-runs** deletes; set **`CONFIRM=1`** to call **`POST /v1/api/keys/{keyId}/delete`** per id (**`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** required). Prefer **`doppler run -- …`** when injecting tokens locally.

## Test layout (by file)

| File                                        | Area                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `integration/api.spec.ts`                   | Cross-cutting HTTP (e.g. CORS OPTIONS).                                                                              |
| `integration/observability.spec.ts`         | `/api/health`, `/.well-known/scitt-configuration`.                                                                   |
| `system/grants-bootstrap.spec.ts`           | Bootstrap mint + register-grant (Custodian-profile Forestrie-Grant).                                                 |
| `system/bootstrap-log-first-entry.spec.ts`  | `POST /register/{bootstrap}/entries` with completed bootstrap grant; rejects wrong signer (`403` `signer_mismatch`). |
| `system/bootstrap-child-auth-grant.spec.ts` | Root bootstrap + custody-key child auth grant; 303 Location under `/logs/{root}/{root}/entries/…`.                   |
| `system/auth-data-log-chain.spec.ts`        | Root → child auth log → data log delegation chain (delegated `grantData`).                                           |
| `custodian/custodian-api.spec.ts`           | Direct **`fetch`** to deployed Custodian: ops + **`/v1/api/…`** key routes. Does not use `:bootstrap` key paths.     |

- Shared e2e utils: `e2e-env-guards.ts`, `e2e-grant-flags.ts`, `register-grant-through-receipt.ts`, `post-entries-e2e.ts`, `custodian-sign-payload.ts`, `custodian-api-*.ts`, `problem-details.ts`, `bootstrap-grant-flow.ts`, etc.
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
