# End-to-end (Playwright) test setup

E2e tests live in **`packages/tests/canopy-api`** (`@canopy/api-e2e`). They target the
**deployed** Canopy worker (dev/staging/prod depending on your Doppler config), not a
locally emulated mini-stack.

Playwright projects are **integration** (Canopy surface only), **system** (full SCRAPI + sequencing + Custodian mint), and **custodian** (direct Custodian HTTP). Default `pnpm test:e2e` runs **integration → system → custodian**. See **`packages/tests/canopy-api/README.md`** for layout and path aliases.

## One-time / when dependencies change

From the **repository root**:

| Task | Purpose |
| ---- | ------- |
| **`task test:e2e:preflight`** | `pnpm install` and Playwright + Chromium only. Does **not** download secrets. |
| **`task test:e2e`** | Run the default e2e suite with secrets from **Doppler** (see below). |

Use **`ENV=prod task test:e2e`** when the Doppler config should be **`prod`** (project stays **`canopy`**).

## Secrets and environment variables (local)

Do **not** hydrate a repo-root **`.env`** file. Inject secrets at runtime with the Doppler CLI:

- **Project:** `canopy`
- **Config:** `dev` (default) or `prod` (set `ENV=prod` on Task invocations)

```bash
# Install tooling once (no secrets):
task test:e2e:preflight

# Default suite (integration → system → custodian):
task test:e2e

# Equivalent explicit invocation:
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e
```

**System only** (full stack; requires Custodian + curator secrets in Doppler):

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:system
```

Required keys in the Doppler config include at least:

- **`CANOPY_BASE_URL`** _or_ **`CANOPY_FQDN`** — worker origin. Playwright resolves `CANOPY_BASE_URL` first; if unset, it builds `https://…` from `CANOPY_FQDN` (same logic as `.github/workflows/api-e2e-playwright.yml`). Doppler `dev` may only define **`CANOPY_FQDN`**.
- **`SCRAPI_API_KEY`** — bearer token for authorized fixtures (when used)
- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**, **`CURATOR_ADMIN_TOKEN`** — for **system** bootstrap mint (runner-side `POST /api/keys` + genesis)

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

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for preflight probes (default **20000**) if used by future probes.
- **`E2E_RUN_ID`**: optional disambiguator for Custodian key labels in e2e helpers.

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
