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
- **Config:** `dev` (default) or `prd` (set `ENV=prd` on Task invocations)

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

Use **`ENV=prd task test:e2e`** when the Doppler config should be **`prd`** (project stays **`canopy`**).

**Single tier** (explicit Doppler + package script):

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:system
```

## Secrets and environment variables (local)

Do **not** hydrate a repo-root **`.env`** file. Inject secrets at runtime with the Doppler CLI.

Required keys in the Doppler config include at least:

- **`CANOPY_BASE_URL`** _or_ **`CANOPY_FQDN`** — worker origin. Playwright resolves `CANOPY_BASE_URL` first; if unset, it builds `https://…` from `CANOPY_FQDN` (same logic as `.github/workflows/tests-system.yml`). Doppler `dev` may only define **`CANOPY_FQDN`**.
- **`SCRAPI_API_KEY`** — bearer token for authorized fixtures (when used)
- **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`**, **`CANOPY_OPS_ADMIN_TOKEN`** — for **system** specs (child custody keys + onboard-token genesis)
- **`DELEGATION_COORDINATOR_URL`**, **`COORDINATOR_APP_TOKEN`** — required for full **`task test:e2e`** system BYOK / Mode C specs; optional for preflight-only (set **`VALIDATE_REQUIRE_COORDINATOR=1`** to enforce in preflight)
- **`E2E_MODE_C_WEBHOOK_PUBLIC_BASE`** — optional manual public HTTPS base for coordinator webhook push (ngrok); CI uses auto **cloudflared** quick tunnel
- **`E2E_MODE_C_ALLOW_PULL_FALLBACK=1`** — local debug only: allow pending-delegation pull when webhook push fails (not CI)

Install **cloudflared** locally for Mode C webhook push when
`E2E_MODE_C_WEBHOOK_PUBLIC_BASE` is unset (CI pins **2026.6.1** with SHA256 verify in
`tests-system.yml`).

Deployed coordinator webhook delivery requires Cloudflare Secrets Store
(`task cf:coordinator:ensure-webhook-signing-key`). Local `wrangler dev` uses
`WEBHOOK_SIGNING_KEY_PEM` from Doppler or vitest vars in `wrangler.jsonc`.

**Univocity ephemeral provision** (bootstrap **system** specs):

Provisioned automatically in preflight (see [plan-0032](../docs/plans/plan-0032-univocity-imutable-e2e-provision.md)). Playwright reads **`.work/e2e-univocity.env`**:

- **`E2E_UNIVOCITY_ADDRESS_*_BOOTSTRAP`**, **`E2E_UNIVOCITY_GENESIS_LOG_ID_*`**
- **`E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE`** — ES256 root grant signing
- **`E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE`** — KS256 root grant signing
- **`E2E_UNIVOCITY_RPC_URL`** — RPC for Playwright `eth_call` and on-chain provision; configure in Doppler or GitHub Environment. Preflight copies it to **`RPC_URL`** for deployer/`cast` (univocity-tools convention). Override per invocation with `task ... RPC_URL=https://...` without changing Doppler.
- **`E2E_UNIVOCITY_CHAIN_ID`** — optional; default `84532`

**Opt out:** `SKIP_UNIVOCITY_PROVISION=true` or **`E2E_SKIP_UNIVOCITY_PROVISION=true`** —
bootstrap system specs skip; other projects still run.

**Manual provision:** `doppler run -- task e2e-univocity:provision`

Requires **`gh`** auth, Foundry **`cast`**, Doppler **`DEPLOY_KEY`**, **`E2E_UNIVOCITY_RPC_URL`**, and **univocity-tools v0.5.1+** (sibling `task install:dev` or release binaries).

**CI:** **`prepare-univocity`** in **tests-system.yml** provisions ephemeral contracts by default (or accepts supplied addresses + keys).

Run ES256 bootstrap specs only:

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/grants-bootstrap.spec.ts --grep "ES256"
```

The **worker** must have **`CUSTODIAN_APP_TOKEN`** (Wrangler secret) for SCITT receipt verification; the **runner** uses Custodian for **child** custody keys. Misconfiguration surfaces as **failures**, not skipped tests.

**Do not** put `doppler run` in `@canopy/api-e2e` `package.json` scripts — CI runs Playwright without the Doppler CLI.

## CI

| Workflow | Role |
| -------- | ---- |
| **`ci.yml`** | Lint, format, unit tests on every push and PR |
| **`tests-integration.yml`** | Playwright **integration** vs deployed **dev** |
| **`tests-system.yml`** | Univocity prepare + full dev suite (integration → system → custodian → coordinator); `workflow_dispatch`, `workflow_call`, push to **main** when deploy-workers did not run |
| **`deploy-workers.yml`** | Deploy workers; chains **tests-system.yml** on **dev** after health |
| **`release.yaml`** | Tag → deploy **dev** → **tests-system.yml** → promote **prod** → prod health |

**tests-system.yml** manual inputs (optional): `es256_address` / `ks256_address` plus matching bootstrap key material; genesis log ids are derived from addresses when omitted. Supplied addresses skip bootstrap mutating specs for that alg.

GitHub Environment **`dev`** or **`prod`** (Doppler sync): `secrets.*` and `vars.*` on Playwright steps — **no** repo-root `.env` and **no** Doppler CLI in CI jobs.

## Optional variables

- **`E2E_PREFLIGHT_FETCH_TIMEOUT_MS`**: HTTP timeout for Canopy health probe in preflight (default **20000**).
- **`E2E_RUN_ID`**: optional disambiguator for Custodian key labels in e2e helpers.
- **`E2E_PROVISION_RUN_ID`**: override run id label for provision logs (default unix timestamp).

## Workspace rules

- **Node** ≥ 20, **pnpm** ≥ 8 (see `task tools:check`).
