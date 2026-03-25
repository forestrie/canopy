# End-to-end (Playwright) test setup

E2e tests live in **`packages/tests/canopy-api`** (`@canopy/api-e2e`). They target the
**deployed** Canopy worker (dev/staging/prod depending on your Doppler config), not a
locally emulated mini-stack.

## One-time / when dependencies change

From the **repository root**:

| Task | Purpose |
|------|---------|
| **`task test:e2e:preflight`** | `pnpm install`, Playwright + Chromium, then **`task vars:doppler:{{ENV}}`** to hydrate **repo-root `.env`** (default `ENV=dev`). |
| **`task test:e2e:preflight:env`** | Fail if **`.env`** is missing (no installs). Used in CI after the workflow writes `.env`. |

Use **`ENV=prod task test:e2e:preflight`** when Doppler config should be **`prod`**.

## Repo-root `.env` (gitignored)

Playwright and root Taskfile **`dotenv: [".env"]`** use **only** this file. There is no `.env.test`, `.env.secrets`, or `.env.{ENV}` chain.

Required keys for e2e include at least:

- **`CANOPY_BASE_URL`** *or* **`CANOPY_FQDN`** — worker origin. Playwright resolves `CANOPY_BASE_URL` first; if unset, it builds `https://…` from `CANOPY_FQDN` (same logic as `.github/workflows/test.yml`). Doppler `dev` may only define **`CANOPY_FQDN`**.
- **`SCRAPI_API_KEY`** — bearer token for authorized fixtures (when used)

Bootstrap grant Playwright tests skip with a clear reason if the deployed worker returns 503 “bootstrap not configured”. Set **`E2E_REQUIRE_BOOTSTRAP=1`** to fail instead of skip once the deployment uses Custodian (Plan 0014).

If **`.env`** is missing, `task vars:require-dotenv`, smoke tasks, and Playwright fail immediately with a short error.

## Running tests

```bash
task test:e2e:preflight   # tooling + hydrate .env from Doppler
task test:e2e             # requires existing .env
```

Or from the package:

```bash
pnpm --filter @canopy/api-e2e exec playwright test --project=dev
```

## CI

The **Tests** workflow (`.github/workflows/test.yml`) runs the job in GitHub Environment **`dev`** (Doppler **`dev`** sync). It exports **`CANOPY_BASE_URL`** (from variable **`CANOPY_BASE_URL`** or derived from **`CANOPY_FQDN`**) and secret **`SCRAPI_API_KEY`** into the step environment, then runs Playwright (no repo-root `.env` file, no Doppler CLI).

## Optional variables

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for preflight probes (default **20000**) if used by future probes.

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
