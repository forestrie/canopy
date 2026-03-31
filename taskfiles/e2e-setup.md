# End-to-end (Playwright) test setup

E2e tests live in **`packages/tests/canopy-api`** (`@canopy/api-e2e`). They target the
**deployed** Canopy worker (dev/staging/prod depending on your Doppler config), not a
locally emulated mini-stack.

## One-time / when dependencies change

From the **repository root**:

| Task                              | Purpose                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **`task test:e2e:preflight`**     | `pnpm install`, Playwright + Chromium, then **`task vars:doppler:{{ENV}}`** to hydrate **repo-root `.env`** (default `ENV=dev`). |
| **`task test:e2e:preflight:env`** | Fail if **`.env`** is missing (no installs). Used in CI after the workflow writes `.env`.                                        |

Use **`ENV=prod task test:e2e:preflight`** when Doppler config should be **`prod`**.

## Repo-root `.env` (gitignored)

Playwright and root Taskfile **`dotenv: [".env"]`** use **only** this file. There is no `.env.test`, `.env.secrets`, or `.env.{ENV}` chain.

Required keys for e2e include at least:

- **`CANOPY_BASE_URL`** _or_ **`CANOPY_FQDN`** — worker origin. Playwright resolves `CANOPY_BASE_URL` first; if unset, it builds `https://…` from `CANOPY_FQDN` (same logic as `.github/workflows/test.yml`). Doppler `dev` may only define **`CANOPY_FQDN`**.
- **`SCRAPI_API_KEY`** — bearer token for authorized fixtures (when used)

Bootstrap grant Playwright tests skip with a clear reason if the deployed worker returns 503 “bootstrap not configured”. Set **`E2E_REQUIRE_BOOTSTRAP=1`** to fail instead of skip once the deployment uses Custodian (Plan 0014).

**Child auth grant** (`tests/bootstrap-child-auth-grant.spec.ts`): after root bootstrap + receipt, creates a Custodian custody key (`POST /api/keys` with **`CUSTODIAN_APP_TOKEN`**), signs a child-shaped Forestrie-Grant (`logId` = new child UUID, `ownerLogId` = root), and registers it on **`POST /logs/{child}/grants`**. The 303 **`Location`** must target the **parent** log’s `/entries/…` (sequencing by `ownerLogId`). Without **`CUSTODIAN_APP_TOKEN`**, the test is skipped.

If **`.env`** is missing, `task vars:require-dotenv`, smoke tasks, and Playwright fail immediately with a short error.

## Running tests

```bash
task test:e2e:preflight   # tooling + hydrate .env from Doppler
task test:e2e             # requires existing .env
```

Inject secrets locally (no `.env` file) using the same Doppler project as `taskfiles/vars.yml` (**`canopy`**). **Do not** put `doppler run` in `@canopy/api-e2e` `package.json` scripts — CI runs Playwright without the Doppler CLI.

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test --project=dev

# Or from repo root (`ENV=prod` selects Doppler config prod):
task test:e2e:doppler
```

When the environment is already set (e.g. CI):

```bash
pnpm --filter @canopy/api-e2e exec playwright test --project=dev
```

## CI

The **Tests** workflow (`.github/workflows/test.yml`) runs the job in GitHub Environment **`dev`** (Doppler **`dev`** sync). It exports **`CANOPY_BASE_URL`** (from variable **`CANOPY_BASE_URL`** or derived from **`CANOPY_FQDN`**) and secret **`SCRAPI_API_KEY`** into the step environment, then runs Playwright (no repo-root `.env` file, no Doppler CLI).

## Optional variables

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for preflight probes (default **20000**) if used by future probes.

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
