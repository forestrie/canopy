# E2E testing (Canopy)

Full detail: [packages/tests/canopy-api/README.md](../../packages/tests/canopy-api/README.md),
[taskfiles/e2e-setup.md](../../taskfiles/e2e-setup.md).

## Policy

- **No Doppler in `@canopy/api-e2e` package scripts** — CI runs plain Playwright.
- **Locally**: `doppler run --project canopy --config dev -- task test:e2e` (or bare
  `task test:e2e`, which self-wraps with Doppler when needed)
- **No repo-root `.env`** for secrets.

## Preflight and full run

```bash
doppler run --project canopy --config dev -- task test:e2e:preflight
doppler run --project canopy --config dev -- task test:e2e
```

**Preflight** installs tooling, validates Doppler env (including Canopy health), and
**provisions ephemeral Univocity es256+ks256 by default** (writes **`.work/e2e-univocity.env`**).

**Opt out:** `SKIP_UNIVOCITY_PROVISION=true` or `E2E_SKIP_UNIVOCITY_PROVISION=true`.

**`task test:e2e`** runs preflight then the full dev suite: integration → system →
custodian → coordinator (when coordinator vars are set).

## Playwright projects

- **integration** — deployed worker, no bootstrap mint
- **system** — full bootstrap grant flow; needs Custodian + forestrie-ingress
- **custodian** — direct Custodian HTTP
- **coordinator** — included in **`task test:e2e`** when `DELEGATION_COORDINATOR_URL` and
  `COORDINATOR_APP_TOKEN` are set

## Key env vars

- `CANOPY_BASE_URL`, `CANOPY_FQDN`, `SCRAPI_API_KEY`
- Bootstrap/system: `CUSTODIAN_APP_TOKEN`, `CANOPY_OPS_ADMIN_TOKEN`, Custodian URL
- Coordinator: `DELEGATION_COORDINATOR_URL`, `COORDINATOR_APP_TOKEN`
- Univocity chain-binding: from **`.work/e2e-univocity.env`** after preflight (see
  [plan-0032](../plans/plan-0032-univocity-imutable-e2e-provision.md))
- Provision secrets: **`DEPLOY_KEY`**, **`E2E_UNIVOCITY_RPC_URL`** (stored config; preflight
  bridges to **`RPC_URL`** for deployer/`cast` during provision; `task ... RPC_URL=` overrides
  without touching Doppler)
- CI provision: **`GITAPP_ID`** + **`GITAPP_PRIVATE_KEY`**
- CI workflows: **`ci.yml`** (lint/unit), **`tests-integration.yml`** (integration vs dev), **`tests-system.yml`** (provision + full suite; manual dispatch with optional contract addresses)

## System test flow docs

Narrative specs: `packages/tests/canopy-api/tests/system/docs/`
