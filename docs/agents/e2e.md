# E2E testing (Canopy)

Full detail: [packages/tests/canopy-api/README.md](../../packages/tests/canopy-api/README.md),
[taskfiles/e2e-setup.md](../../taskfiles/e2e-setup.md).

## Policy

- **No Doppler in `@canopy/api-e2e` package scripts** — CI runs plain Playwright.
- **Locally**: `task test:e2e` or
  `doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e`
- **No repo-root `.env`** for secrets.

## Preflight

`task test:e2e:preflight` — installs tooling only.

## Playwright projects

- **integration** — deployed worker, no bootstrap mint
- **system** — full bootstrap grant flow; needs Custodian + forestrie-ingress

## Key env vars

- `CANOPY_BASE_URL`, `CANOPY_FQDN`, `SCRAPI_API_KEY`
- Bootstrap/system: `CUSTODIAN_APP_TOKEN`, `CURATOR_ADMIN_TOKEN`, Custodian URL
- Univocity chain-binding: `E2E_UNIVOCITY_ADDRESS_*`, genesis log IDs — static
  defaults in Doppler **`canopy/dev`**, or fresh addresses when
  **`E2E_UNIVOCITY_PROVISION_FRESH=true`** (see [plan-0032](../plans/plan-0032-univocity-imutable-e2e-provision.md))

## System test flow docs

Narrative specs: `packages/tests/canopy-api/tests/system/docs/`
