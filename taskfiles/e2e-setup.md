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
# Preflight: tooling + env validation (+ optional fresh Univocity when flag set)
doppler run --project canopy --config dev -- task test:e2e:preflight

# Full dev suite (runs preflight first)
doppler run --project canopy --config dev -- task test:e2e
```

Bare **`task test:e2e`** self-wraps with `doppler run` when `DOPPLER_CONFIG` is unset.

| Task | Purpose |
| ---- | ------- |
| **`task test:e2e:preflight`** | `pnpm install`, Playwright Chromium, Doppler env validation, Canopy health probe; auto-provisions Univocity when **`E2E_UNIVOCITY_PROVISION_FRESH=true`**. |
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
- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**, **`CURATOR_ADMIN_TOKEN`** — for **system** bootstrap mint (runner-side `POST /api/keys` + genesis)
- **`DELEGATION_COORDINATOR_URL`**, **`COORDINATOR_APP_TOKEN`** — optional; when both set, **`task test:e2e`** includes the **coordinator** project

**Univocity genesis chain-binding** (`tests/system/univocity-genesis-*-chain-binding.spec.ts`):

- **`E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP`** — KS256 ImutableUnivocity on Base Sepolia (default
  `0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94`). Set in Doppler **`canopy/dev`** and sync to GitHub **`dev`** Environment **`vars`** for CI.
- **`E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP`** — ES256 ImutableUnivocity (default
  `0xb5906A91eF30dA435Ff13d27619Bc6F76282d19D`).
- **`E2E_UNIVOCITY_RPC_URL`** — optional; default `https://sepolia.base.org` (runner reads `bootstrapConfig()`).
- **`E2E_UNIVOCITY_CHAIN_ID`** — optional; default `84532`.
- **`E2E_UNIVOCITY_GENESIS_LOG_ID_KS256`** — optional; default `7a4e8ad8-…` in `e2e-static-log-ids.ts`.
- **`E2E_UNIVOCITY_GENESIS_LOG_ID_ES256`** — optional; default `b5906a91-…` in `e2e-static-log-ids.ts`.
- **`CURATOR_ADMIN_TOKEN`** — required (POST `/api/forest/{log-id}/genesis`).
- Reset persisted genesis: `task cf:genesis:delete LOG_ID=<uuid>` (see spec comments).

**Fresh Imutable provision** (optional; see [plan-0032](../docs/plans/plan-0032-univocity-imutable-e2e-provision.md)):

- Set **`E2E_UNIVOCITY_PROVISION_FRESH=true`** in Doppler — **`task test:e2e:preflight`** installs tools (if needed), deploys es256 + ks256, writes **`.work/e2e-univocity.env`**, and Playwright sources it automatically.
- Manual path still available: `doppler run -- task e2e-univocity:provision RUN_ID=local-smoke`
- Requires **`gh`** auth (for `fetch-release --auth-kind gh-cli`), Foundry **`cast`**, and Doppler
  **`DEPLOY_KEY`**, **`BOOTSTRAP_PEM_ES256`**, **`E2E_UNIVOCITY_RPC_URL`**.
- **CI:** set GitHub **`dev`** var **`E2E_UNIVOCITY_PROVISION_FRESH=true`** to run
  **`provision-univocity`** (no cross-repo univocity workflow).
- Requires **univocity-tools v0.5.0+** (`deploy propose imutable --release-root`).

Run KS256 chain-binding only:

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/univocity-genesis-ks256-chain-binding.spec.ts
```

The **worker** must have **`CUSTODIAN_APP_TOKEN`** (Wrangler secret) for SCITT receipt verification on register-grant / register-statement; the **runner** uses the same token for per-root bootstrap mint. Misconfiguration surfaces as **failures**, not skipped tests.

**Do not** put `doppler run` in `@canopy/api-e2e` `package.json` scripts — CI runs Playwright without the Doppler CLI.

## CI

The **Tests** and **Deploy Workers** workflows call **`.github/workflows/api-e2e-playwright.yml`**. They use GitHub Environment **`dev`** or **`prod`** (Doppler sync): `secrets.*` and `vars.*` on the Playwright step — **no** repo-root `.env` and **no** Doppler CLI in the job.

## Optional variables

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for Canopy health probe in preflight (default **20000**).
- **`E2E_RUN_ID`**: optional disambiguator for Custodian key labels in e2e helpers.
- **`E2E_PROVISION_RUN_ID`**: override run id for fresh Univocity CREATE2 salts (default `local-<timestamp>`).

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
