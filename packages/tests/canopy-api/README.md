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

- **CI / env already set:** `pnpm --filter @canopy/api-e2e exec playwright test` — all tests (**`dev`** project), or `pnpm --filter @canopy/api-e2e test:e2e` (same).
- **Local (Doppler):** do **not** use a Doppler-injected npm script — use **`task test:e2e:doppler`** from the repo root, or  
  `doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e exec playwright test --project=dev`  
  (see **`.cursor/rules/e2e-local-doppler.mdc`**). Use `ENV=prod` with the task when targeting prod Doppler config.
- **Local (hydrated `.env`):** `task test:e2e:preflight` then `task test:e2e` or root `pnpm test:e2e`.
- **Custodian HTTP API only:** `pnpm --filter @canopy/api-e2e exec playwright test --project=custodian` or `pnpm --filter @canopy/api-e2e test:e2e:custodian` (same repo-root `.env` / Doppler as other e2e). Requires **`CUSTODIAN_URL`** (ingress **origin**, no `/v1` required), **`CUSTODIAN_APP_TOKEN`**, and **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** for teardown (`POST /v1/api/keys/{keyId}/delete`). Tests call ops at `/healthz`… and the API at **`/v1/api/…`** (Traefik). Does not call `:bootstrap` key routes.

### Bootstrap grant (mint + register-grant)

`tests/grants-bootstrap.spec.ts` exercises **runner-side** bootstrap mint (per-root **`POST /api/keys`** with **`CUSTODIAN_APP_TOKEN`**, genesis **`POST /api/forest/{log-id}/genesis`** with **`CURATOR_ADMIN_TOKEN`**, then custody ES256 sign) and **`POST /register/{bootstrap-logid}/grants`** on the **bootstrap branch** (303 See Other with a registration-status `Location` under `/logs/{bootstrap}/{owner}/entries/…`).

The **deployed** worker needs **`R2_MMRS`**, sequencing queue bindings, and `bootstrapEnv` + `queueEnv`. Specs pick a **fresh UUID** per run so the target log has no MMRS massif yet for the first register-grant (303). Tests that poll sequencing and resolve receipts need **forestrie-ingress** on the same SequencingQueue — see **`AGENTS.md`**. If you only have **canopy-api-dev** without ingress, set **`E2E_SKIP_SEQUENCING_POLL=1`** to skip those tests.

**First signed entry** (`tests/bootstrap-log-first-entry.spec.ts`): same as above for mint → register → receipt, then runner **`POST /api/keys/{root-key}/sign`** (same key as mint) and **`POST /register/{bootstrap}/entries`**. Missing **`CURATOR_ADMIN_TOKEN`** or **`CUSTODIAN_APP_TOKEN`** causes **hard failure** at mint (`assertBootstrapMintE2eEnv`); only **`E2E_SKIP_SEQUENCING_POLL=1`** skips work when ingress is absent.

**Child auth grant** (`tests/bootstrap-child-auth-grant.spec.ts`): root bootstrap mint (same **`CUSTODIAN_APP_TOKEN`** as above) plus an additional custody key for the child grant. Helpers: `tests/utils/custodian-custody-grant.ts`.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env`** (after `task vars:doppler:dev`) **and** the process environment. If `.env` is missing locally, Playwright throws (unless `CI` is set).

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. `https://api-dev.example.com` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/test.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**Bootstrap grant e2e** (`grants-bootstrap.spec.ts` and related specs):

- **Runner:** **`CURATOR_ADMIN_TOKEN`** (genesis), **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`** (create key + sign). The **Worker** must still expose SCRAPI **`/register/{bootstrap}/…`** with queue/MMRS configured.
- If bootstrap mint env is missing, tests **fail** immediately with a clear error (no silent skip).
- **`E2E_SKIP_SEQUENCING_POLL=1`**: skip only tests that poll sequencing / receipt when ingress is not running against the same dev stack.

Other keys:

- **`SCRAPI_API_KEY`**: Bearer for authorized fixtures (optional for current specs that use `unauthorizedRequest` only).

**Custodian API e2e** (`custodian-api.spec.ts`, Playwright project **`custodian`**):

- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**: create key, public, sign, curator, list via **`/v1/api/…`** (ingress); ops probes use the URL **origin** only (`/healthz`, `/readyz`, …).
- **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**: required for the second test that calls **`POST /v1/api/keys/{keyId}/delete`** (privileged bootstrap token in Custodian; not the `:bootstrap` KMS key). If unset, that test is skipped and a custody key may remain in the target KMS ring.

## Test layout

| File                                 | Area                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.spec.ts`                        | Cross-cutting HTTP (e.g. CORS OPTIONS).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `observability.spec.ts`              | `/api/health`, `/.well-known/scitt-configuration` (metrics TBD).                                                                                                                                                                                                                                                                                                                                                                                         |
| `grants-bootstrap.spec.ts`           | Bootstrap mint + register-grant (Custodian-profile Forestrie-Grant).                                                                                                                                                                                                                                                                                                                                                                                     |
| `bootstrap-log-first-entry.spec.ts`  | `POST /register/{bootstrap}/entries` with completed bootstrap grant (Custodian sign); rejects wrong signer (`403` `signer_mismatch`).                                                                                                                                                                                                                                                                                                                    |
| `bootstrap-child-auth-grant.spec.ts` | Root bootstrap + custody-key child auth grant; 303 Location under `/logs/{root}/{root}/entries/…`.                                                                                                                                                                                                                                                                                                                                                       |
| `auth-data-log-chain.spec.ts`        | Root → child **auth** log → first **data** log grant (delegated `grantData`, signed by auth custody) → `POST /entries` on data log with **delegated** signer + completed data-log grant as auth; negative: wrong signer → `signer_mismatch`. **Purpose:** confirm delegated register-statement for a data log under a child auth log. Requires same Custodian + sequencing setup as other custody e2e (`CUSTODIAN_APP_TOKEN`, bootstrap token, ingress). |
| `custodian-api.spec.ts`              | Direct **`fetch`** to deployed Custodian: root ops + **`/v1/api/…`** key routes (public `POST /v1/api/keys`, sign, curator, list, optional `log-id=true` public, delete via bootstrap app token). **Does not** use `:bootstrap` key paths.                                                                                                                                                                                                               |

- Fixtures: `tests/fixtures`.
- Shared e2e utils: `tests/utils/e2e-env-guards.ts`, `tests/utils/e2e-grant-flags.ts`, `tests/utils/register-grant-through-receipt.ts`, `tests/utils/post-entries-e2e.ts`, `tests/utils/custodian-sign-payload.ts`, `tests/utils/custodian-api-*.ts` (direct Custodian HTTP helpers), `tests/utils/problem-details.ts`, `tests/utils/bootstrap-e2e-guard.ts`, `tests/utils/bootstrap-grant-flow.ts`.
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
