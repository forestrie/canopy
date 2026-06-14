# End-to-end (Playwright) test setup

E2e tests live in **`packages/tests/canopy-api`** (`@canopy/api-e2e`). They target the
**deployed** Canopy worker (dev/staging/prod depending on your Doppler config), not a
locally emulated mini-stack.

Playwright projects are **integration**, **system**, **custodian**, and **coordinator**
(when configured). **`task test:e2e`** runs the full dev suite in CI-parity order:
**integration → system → custodian → coordinator** (coordinator skipped with a warning
when `DELEGATION_COORDINATOR_URL` or `COORDINATOR_APP_TOKEN` is unset). See
**`packages/tests/canopy-api/README.md`** for layout and path aliases.

## Local workflow

From the **repository root** (recommended — inject secrets via Doppler):

- **Project:** `canopy`
- **Config:** `dev` (default) or `prod` (set `ENV=prod` on Task invocations)

```bash
# Preflight: tooling + env validation (+ ephemeral Univocity provision by default)
doppler run --project canopy --config dev -- task test:e2e:preflight

# Opt out of on-chain Univocity deploy (bootstrap system specs skip per variant)
doppler run --project canopy --config dev -- task test:e2e:preflight SKIP_UNIVOCITY_PROVISION=true

# Full dev suite (runs preflight first)
doppler run --project canopy --config dev -- task test:e2e
```

Bare **`task test:e2e`** self-wraps with `doppler run` when `DOPPLER_CONFIG` is unset.

| Task | Purpose |
| ---- | ------- |
| **`task test:e2e:preflight`** | `pnpm install`, Playwright Chromium, Doppler env validation, Canopy health probe; **provisions ephemeral Univocity es256+ks256 by default** (see opt-out below). |
| **`task test:e2e`** | Full dev Playwright sequence via **`taskfiles/e2e-run-playwright.sh`** (depends on preflight). |

Use **`ENV=prod task test:e2e`** when the Doppler config should be **`prod`** (project stays **`canopy`**).

**Single tier** (explicit Doppler + package script):

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:system
```

## Secrets and environment variables (local)

Do **not** hydrate a repo-root **`.env`** file. Inject secrets at runtime with the Doppler CLI.

Required keys in the Doppler config include at least:

- **`CANOPY_BASE_URL`** _or_ **`CANOPY_FQDN`** — worker origin. Playwright resolves `CANOPY_BASE_URL` first; if unset, it builds `https://…` from `CANOPY_FQDN` (same logic as `.github/workflows/api-e2e-playwright.yml`). Doppler `dev` may only define **`CANOPY_FQDN`**.
- **`SCRAPI_API_KEY`** — bearer token for authorized fixtures (when used)
- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**, **`CURATOR_ADMIN_TOKEN`** — for **system** specs (child custody keys + genesis)
- **`DELEGATION_COORDINATOR_URL`**, **`COORDINATOR_APP_TOKEN`** — optional; when both set, **`task test:e2e`** includes the **coordinator** project

**Univocity ephemeral provision** (bootstrap **system** specs):

Provisioned automatically in preflight (see [plan-0032](../docs/plans/plan-0032-univocity-imutable-e2e-provision.md)). Playwright reads **`.work/e2e-univocity.env`**:

- **`E2E_UNIVOCITY_ADDRESS_*_BOOTSTRAP`**, **`E2E_UNIVOCITY_GENESIS_LOG_ID_*`**
- **`E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE`** — ES256 root grant signing
- **`E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE`** — KS256 root grant signing
- **`E2E_UNIVOCITY_RPC_URL`** — optional; default `https://sepolia.base.org`
- **`E2E_UNIVOCITY_CHAIN_ID`** — optional; default `84532`

**Opt out:** `SKIP_UNIVOCITY_PROVISION=true` or **`E2E_SKIP_UNIVOCITY_PROVISION=true`** —
bootstrap system specs skip; other projects still run.

**Manual provision:** `doppler run -- task e2e-univocity:provision`

Requires **`gh`** auth, Foundry **`cast`**, Doppler **`DEPLOY_KEY`**, **`E2E_UNIVOCITY_RPC_URL`**, and **univocity-tools v0.5.1+** (sibling `task install:dev` or release binaries).

**CI:** **`provision-univocity`** runs on every same-repo PR (no feature flag).

Run ES256 bootstrap specs only:

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/grants-bootstrap.spec.ts --grep "ES256"
```

The **worker** must have **`CUSTODIAN_APP_TOKEN`** (Wrangler secret) for SCITT receipt verification; the **runner** uses Custodian for **child** custody keys. Misconfiguration surfaces as **failures**, not skipped tests.

**Do not** put `doppler run` in `@canopy/api-e2e` `package.json` scripts — CI runs Playwright without the Doppler CLI.

## CI

The **Tests** and **Deploy Workers** workflows call **`.github/workflows/api-e2e-playwright.yml`**. They use GitHub Environment **`dev`** or **`prod`** (Doppler sync): `secrets.*` and `vars.*` on the Playwright step — **no** repo-root `.env` and **no** Doppler CLI in the job.

## Optional variables

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for Canopy health probe in preflight (default **20000**).
- **`E2E_RUN_ID`**: optional disambiguator for Custodian key labels in e2e helpers.
- **`E2E_PROVISION_RUN_ID`**: override run id label for provision logs (default unix timestamp).

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
