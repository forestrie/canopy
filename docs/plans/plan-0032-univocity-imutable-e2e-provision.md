# Plan 0032: Univocity Imutable e2e provision (Safe path)

**Status**: DRAFT  
**Date**: 2026-06-08  
**Related**:
- [plan-0031](plan-0031-ks256-forest-roots.md) (KS256 chain-binding)
- [univocity-tools ADR-0009](../../univocity-tools/docs/adr/adr-0009-propose-from-build-archive.md)
- [univocity-tools ADR-0005](../../univocity-tools/docs/adr/adr-0005-safe-approve-command.md)

## Goal

Provision fresh **ImutableUnivocity** deployments for canopy Playwright
chain-binding e2e without checking out the contracts repo or triggering
cross-repo workflows. Canopy orchestrates a composable **univocity-tools**
pipeline: fetch published build archive → extract → propose → approve.

Requires **univocity-tools v0.5.0+** (`deploy propose imutable
--release-root`).

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

### CI flow (canopy-native)

Single gated job **`provision-univocity`** when
**`E2E_UNIVOCITY_PROVISION_FRESH=true`**:

1. Mint org **GitHub App** token (`tibdex/github-app-token@v1`,
   **`vars.GITAPP_ID`** + **`secrets.GITAPP_PRIVATE_KEY`**).
2. Download **univocity-tools** latest release (`deployer-linux-x64`,
   `contract-artefacts-linux-x64`).
3. **`contract-artefacts fetch-release`** — latest **`forestrie/univocity`**
   `v*` release (`--artefact univocity`, `--auth-kind env`).
4. **`contract-artefacts archive-extract --release-root R`** — prebuilt
   `out/ImutableUnivocity.json`.
5. For **es256** and **ks256**: run-scoped salt →
   **`deployer deploy propose imutable --release-root R`** →
   **`deployer deploy approve`**.
6. Map addresses + mnemonic genesis log UUIDs → Playwright override inputs
   on **`api-e2e-full`**.

No `workflow_call` to **`forestrie/univocity`**. No `forge build`.

### Secrets / Doppler sync

| Canopy GitHub **dev** | Source | Purpose |
|----------------------|--------|---------|
| **`DEPLOY_KEY`** | Doppler **`univocity` / `dev`** → `DEPLOY_KEY` | Safe owner signer for `deploy approve` |
| **`BOOTSTRAP_PEM_ES256`** | Doppler **`canopy` / `dev`** (existing) | ES256 propose bootstrap key |
| **`E2E_UNIVOCITY_RPC_URL`** | **`vars`** (existing) | RPC for propose / approve |
| **`GITAPP_ID`** | **`vars`** | GitHub App for cross-repo release fetch |
| **`GITAPP_PRIVATE_KEY`** | **`secrets`** | GitHub App private key |

Configure Doppler cross-project grant: **`canopy.dev.DEPLOY_KEY`**
references **`univocity.dev.DEPLOY_KEY`**. Sync to GitHub Environment
**`dev`** secrets (no Doppler CLI in CI).

### Local dev

Fetch + deploy from **canopy** (requires **gh** auth or **`GH_TOKEN`**, Foundry **`cast`**, Doppler secrets):

```bash
doppler run --project canopy --config dev -- \
  task e2e-univocity:provision RUN_ID=local-smoke
```

Map a manifest:

```bash
eval "$(doppler run --project canopy --config dev -- \
  task e2e-univocity:env-from-manifest MANIFEST=.work/univocity-e2e/proposals/manifest-es256-….json)"
task e2e-univocity:verify MANIFEST=…
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/univocity-genesis-es256-chain-binding.spec.ts
```

**`task test:e2e:preflight`** validates Doppler env and auto-provisions Univocity when
**`E2E_UNIVOCITY_PROVISION_FRESH=true`** (writes **`.work/e2e-univocity.env`** for Playwright).
Manual **`e2e-univocity:provision`** remains available for ad-hoc runs.

## Out of scope (first slice)

- Automated genesis POST / curator bootstrap after deploy
- Removing univocity-side **`deploy-imutable.yml`** (still usable manually)
- **`deploy approve`** for non-imutable proposal kinds

## Manual smoke checklist

1. **univocity-tools** — tag **`v0.5.0`** and confirm release assets.
2. **canopy** — set **`E2E_UNIVOCITY_PROVISION_FRESH=true`** on a test PR;
   confirm **`provision-univocity`** fetches latest contract release and
   chain-binding specs use fresh addresses.
3. Reset **`E2E_UNIVOCITY_PROVISION_FRESH`** after validation.

## Verification

```sh
# univocity-tools
cd ../univocity-tools && bun test

# canopy adapter
cd canopy && task e2e-univocity:genesis-log-id ADDR=0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94
```
