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
auto-provisions fresh Univocity when **`E2E_UNIVOCITY_PROVISION_FRESH=true`**.

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
- Bootstrap/system: `CUSTODIAN_APP_TOKEN`, `CURATOR_ADMIN_TOKEN`, Custodian URL
- Coordinator: `DELEGATION_COORDINATOR_URL`, `COORDINATOR_APP_TOKEN`
- Univocity chain-binding: `E2E_UNIVOCITY_ADDRESS_*`, genesis log IDs — static
  defaults in Doppler **`canopy/dev`**, or fresh addresses when
  **`E2E_UNIVOCITY_PROVISION_FRESH=true`** (see [plan-0032](../plans/plan-0032-univocity-imutable-e2e-provision.md))
- Fresh provision: **`DEPLOY_KEY`**, **`BOOTSTRAP_PEM_ES256`**, **`E2E_UNIVOCITY_RPC_URL`**
- Fresh provision CI: **`GITAPP_ID`** + **`GITAPP_PRIVATE_KEY`** (org GitHub App)

## System test flow docs

Narrative specs: `packages/tests/canopy-api/tests/system/docs/`
