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

### Bootstrap grant (mint + register-grant)

`tests/grants-bootstrap.spec.ts` exercises **runner-side** bootstrap mint (Genesis **`POST /api/forest/{log-id}/genesis`** with **`CURATOR_ADMIN_TOKEN`**, then Custodian `:bootstrap` sign) and **`POST /register/{bootstrap-logid}/grants`** on the **bootstrap branch** (303 See Other with a registration-status `Location` under `/logs/{bootstrap}/{owner}/entries/…`).

The **deployed** worker needs **`R2_MMRS`**, sequencing queue bindings, `bootstrapEnv` + `queueEnv`, and **no** first massif object for the target log in MMRS (same key layout as resolve-receipt). If that massif already exists or the queue is missing, register-grant will not return 303 for this flow—fix the environment or use a fresh `rootLogId` in the spec.

A third test (**poll query-registration-status → SCITT receipt**, assert **mmrIndex 0**) runs a fresh UUID root log, mint + register (303), then polls with an arithmetic delay ladder (`sequencingBackoff` in `tests/utils/arithmetic-backoff-poll.ts`). That path needs **forestrie-ingress** (or equivalent) processing the same SequencingQueue so MMRS is written—see repo **`AGENTS.md`**. If you only have **canopy-api-dev** without ingress, set **`E2E_SKIP_SEQUENCING_POLL=1`** to skip that test.

**First signed entry** (`tests/bootstrap-log-first-entry.spec.ts`): after the same mint → register → receipt flow as the poll test, calls **Custodian** from the **test runner** (`POST /api/keys/:bootstrap/sign` with **`CUSTODIAN_URL`** and **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**) to build a COSE Sign1 statement body, then **`POST /register/{bootstrap}/entries`** with the **completed** Forestrie-Grant (`bootstrap` and target log match the root for this flow). Supply **`CURATOR_ADMIN_TOKEN`**, Custodian vars, and API origin via repo-root `.env` or **`doppler run --project canopy --config dev`** (see **`taskfiles/e2e-setup.md`**). Use the **exact** `CUSTODIAN_URL` the **deployed worker** uses (including **`/v1`**, see `packages/apps/canopy-api/wrangler.jsonc`); a different host or path can yield **`403` `signer_mismatch`**. The test is skipped when curator/custodian env vars are unset or when **`E2E_SKIP_SEQUENCING_POLL=1`**. In GitHub Actions, **`secrets.CURATOR_ADMIN_TOKEN`** and optional **`vars.CUSTODIAN_URL`** + **`secrets.CUSTODIAN_BOOTSTRAP_APP_TOKEN`** enable this path. Shared helpers: `tests/utils/bootstrap-grant-flow.ts`, `tests/utils/mint-bootstrap-grant-e2e.ts`.

**Child auth grant** (`tests/bootstrap-child-auth-grant.spec.ts`): bootstraps a root log, completes the first grant to MMRS, then **`POST /api/keys`** (Custodian **`CUSTODIAN_APP_TOKEN`**) to create an ES256 custody key, builds a child Forestrie-Grant signed with that key (**`POST /api/keys/{keyId}/sign`**), and **`POST /register/{root}/grants`** with that artifact. Expect **`303`** with **`Location`** under `/logs/{root}/{root}/entries/…` (parent owner log). Skipped without **`CURATOR_ADMIN_TOKEN`**, **`CUSTODIAN_APP_TOKEN`**, bootstrap token, or when **`E2E_SKIP_SEQUENCING_POLL=1`**. Helpers: `tests/utils/custodian-custody-grant.ts`.

## Environment variables

Resolved in **`playwright.config.ts`** from **repo-root `.env`** (after `task vars:doppler:dev`) **and** the process environment. If `.env` is missing locally, Playwright throws (unless `CI` is set).

**Worker origin** (one of):

- **`CANOPY_BASE_URL`** — full origin, e.g. `https://api-dev.example.com` (no trailing slash), or
- **`CANOPY_FQDN`** — host or URL; Playwright builds `https://{host}` the same way as `.github/workflows/test.yml` (Doppler `dev` often supplies only `CANOPY_FQDN`).

**Bootstrap grant e2e** (`grants-bootstrap.spec.ts` and related specs):

- **Runner:** **`CURATOR_ADMIN_TOKEN`** (genesis), **`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**. The **Worker** must still expose SCRAPI **`/register/{bootstrap}/…`** with queue/MMRS configured.
- If required env is missing, tests **skip** (or **fail** when **`CI`** / **`E2E_REQUIRE_BOOTSTRAP=1`**).
- **`E2E_SKIP_SEQUENCING_POLL=1`**: skip only the registration-status polling / receipt test when ingress is not running against the same dev stack.
- **`E2E_BOOTSTRAP_LOG_ID`** (optional): fixed root UUID for receipt tests; legacy **`ROOT_LOG_ID`** is still read as a fallback by `e2e-env-guards.ts`.

Other keys:

- **`SCRAPI_API_KEY`**: Bearer for authorized fixtures (optional for current specs that use `unauthorizedRequest` only).

## Test layout

| File                                 | Area                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.spec.ts`                        | Cross-cutting HTTP (e.g. CORS OPTIONS).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `observability.spec.ts`              | `/api/health`, `/.well-known/scitt-configuration` (metrics TBD).                                                                                                                                                                                                                                                                                                                                                                                         |
| `grants-bootstrap.spec.ts`           | Bootstrap mint + register-grant (Custodian-profile Forestrie-Grant).                                                                                                                                                                                                                                                                                                                                                                                     |
| `bootstrap-log-first-entry.spec.ts`  | `POST /register/{bootstrap}/entries` with completed bootstrap grant (Custodian sign); rejects wrong signer (`403` `signer_mismatch`).                                                                                                                                                                                                                                                                                                                    |
| `bootstrap-child-auth-grant.spec.ts` | Root bootstrap + custody-key child auth grant; 303 Location under `/logs/{root}/{root}/entries/…`.                                                                                                                                                                                                                                                                                                                                                       |
| `auth-data-log-chain.spec.ts`        | Root → child **auth** log → first **data** log grant (delegated `grantData`, signed by auth custody) → `POST /entries` on data log with **delegated** signer + completed data-log grant as auth; negative: wrong signer → `signer_mismatch`. **Purpose:** confirm delegated register-statement for a data log under a child auth log. Requires same Custodian + sequencing setup as other custody e2e (`CUSTODIAN_APP_TOKEN`, bootstrap token, ingress). |

- Fixtures: `tests/fixtures`.
- Shared e2e utils: `tests/utils/e2e-env-guards.ts`, `tests/utils/e2e-grant-flags.ts`, `tests/utils/register-grant-through-receipt.ts`, `tests/utils/post-entries-e2e.ts`, `tests/utils/custodian-sign-payload.ts`, `tests/utils/problem-details.ts`, `tests/utils/bootstrap-e2e-guard.ts`, `tests/utils/bootstrap-grant-flow.ts`.
- Worker unit/integration tests: `packages/apps/canopy-api/test`.
