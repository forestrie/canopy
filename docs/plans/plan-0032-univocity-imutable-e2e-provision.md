# Plan 0032: Univocity Imutable e2e provision (Safe path)

**Status**: DRAFT  
**Date**: 2026-06-08  
**Related**:
- [plan-0031](plan-0031-ks256-forest-roots.md) (KS256 chain-binding)
- [univocity deploy-imutable workflow](../../univocity/.github/workflows/deploy-imutable.yml)
- [univocity-tools ADR-0005](../../univocity-tools/docs/adr/adr-0005-safe-approve-command.md)

## Goal

Provision fresh **ImutableUnivocity** deployments for canopy Playwright
chain-binding e2e without hand-running Python Safe scripts. Canopy
orchestrates only; **univocity** owns deploy tasks and the reusable
**deploy-imutable** workflow; **univocity-tools** ships `deployer deploy
approve`.

## Scope

### Gating

Fresh provision runs when GitHub Environment **`dev`** var
**`E2E_UNIVOCITY_PROVISION_FRESH`** is **`true`**. Default (unset /
`false`) keeps static **`vars.E2E_UNIVOCITY_*`** addresses from Doppler.

### Salt policy

Per CI run and algorithm:

```text
salt = keccak256(abi.encode("canopy-e2e", github.run_id, bootstrap_alg))
```

Implemented in **`.github/workflows/pr-dev-deploy-e2e.yml`** and
**`task e2e-univocity:ci-salt`**. Do **not** use the stable
`defaultSafeBatchSalt()` from deployer for e2e — that pins CREATE2
addresses across runs.

### CI flow (canopy)

1. **`univocity-salt-{es256,ks256}`** — compute salts.
2. **`deploy-imutable-{es256,ks256}`** — parallel
   `workflow_call` to `forestrie/univocity/.github/workflows/deploy-imutable.yml`
   (Safe propose → approve → manifest).
3. **`map-univocity-e2e-env`** — map `imutable_address` → Playwright env
   + mnemonic genesis log UUID (`univocity/scripts/es256_common.py` shape).
4. **`api-e2e-full`** — pass overrides into **`api-e2e-playwright.yml`**.

### Secrets / Doppler sync

| Canopy GitHub **dev** | Source | Purpose |
|----------------------|--------|---------|
| **`DEPLOY_KEY`** | Doppler **`univocity` / `dev`** → `DEPLOY_KEY` | Safe owner signer for `deploy approve` |
| **`BOOTSTRAP_PEM_ES256`** | Doppler **`canopy` / `dev`** (existing) | ES256 propose bootstrap key |
| **`E2E_UNIVOCITY_RPC_URL`** | **`vars`** (existing) | Passed as workflow `rpc_url` input |

Configure Doppler cross-project grant: **`canopy.dev.DEPLOY_KEY`**
references **`univocity.dev.DEPLOY_KEY`**. Sync to GitHub Environment
**`dev`** secrets (no Doppler CLI in CI).

### Local dev

Deploy in sibling **univocity** repo:

```bash
cd ../univocity
doppler run --project univocity --config dev -- \
  task imutable-deploy:default ALG=es256 SALT=0x…
```

Map manifest in **canopy**:

```bash
eval "$(doppler run --project canopy --config dev -- \
  task e2e-univocity:env-from-manifest MANIFEST=../univocity/deployments/immutable/manifest-….json)"
task e2e-univocity:verify MANIFEST=…
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/univocity-genesis-es256-chain-binding.spec.ts
```

Canopy taskfile **does not** duplicate deploy.

## Out of scope (first slice)

- Automated genesis POST / curator bootstrap after deploy
- Replacing legacy Python deploy scripts (deprecated in README only)
- **`deploy approve`** for non-imutable proposal kinds

## Manual smoke checklist

1. **univocity** — `workflow_dispatch` **Deploy ImutableUnivocity** with
   `bootstrap_alg=es256`, unique `salt`, `tools_version=v0.2.0`; confirm
   manifest artifact and on-chain code.
2. **canopy** — set **`E2E_UNIVOCITY_PROVISION_FRESH=true`** on a test PR;
   confirm parallel ES256 + KS256 deploy jobs and chain-binding specs only
   (or full system suite) against fresh addresses.
3. Reset **`E2E_UNIVOCITY_PROVISION_FRESH`** after validation.

## Verification

```sh
# univocity-tools
cd ../univocity-tools && bun test

# univocity taskfile (dry): task --list-all | grep imutable-deploy

# canopy adapter
cd canopy && task e2e-univocity:genesis-log-id ADDR=0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94
```
