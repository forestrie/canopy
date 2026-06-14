# Plan 0032: Univocity Imutable e2e provision (ephemeral)

**Status**: ACTIVE  
**Date**: 2026-06-13  
**Related**:
- [plan-0031](plan-0031-ks256-forest-roots.md) (KS256 chain-binding)
- [univocity-tools ADR-0009](../../univocity-tools/docs/adr/adr-0009-propose-from-build-archive.md)
- [univocity-tools ADR-0004](../../univocity-tools/docs/adr/adr-0004-deploy-propose-execute-model.md)

## Goal

Every **`task test:e2e:preflight`** (default in **`task test:e2e`**) deploys fresh
**ImutableUnivocity** contracts for **ES256** and **KS256** on Base Sepolia via
**EOA** `deploy propose` + `deploy execute`, with **ephemeral bootstrap keys**
generated per run. Playwright **system bootstrap specs** read **`.work/e2e-univocity.env`**
and run each scenario for **ES256** and **KS256** variants.

No static Doppler contract addresses, no Safe publish path, no
`BOOTSTRAP_PEM_ES256`.

## Opt-out

Skip on-chain provision for faster local iteration:

```bash
task test:e2e:preflight SKIP_UNIVOCITY_PROVISION=true
# or E2E_SKIP_UNIVOCITY_PROVISION=true in Doppler/shell
```

Bootstrap **system** specs skip when env is unset; integration/custodian/coordinator still run.

## Preflight sequence

1. `e2e-shared:bootstrap`
2. `e2e-shared:ensure-doppler`
3. `e2e-shared:provision-univocity` (unless skipped)
4. `e2e-shared:validate-env`

## Deploy flow (local + CI)

1. Install **univocity-tools** (`task install:dev` or CI release binaries).
2. **`contract-artefacts fetch-release`** + **`archive-extract`**.
3. For **es256** and **ks256**:
   - `deploy propose imutable` with `--bootstrap-*-generate` + key-out paths
   - `deploy execute` (EOA broadcast; `DEPLOY_KEY` pays gas)
4. Write **`.work/e2e-univocity.env`** (addresses, genesis log IDs, PEM file path,
   KS256 signer).

Requires **univocity-tools v0.5.1+** (`--bootstrap-es256-generate`,
`--bootstrap-ks256-generate`).

## Secrets

| Canopy Doppler / GitHub **dev** | Purpose |
|--------------------------------|---------|
| **`DEPLOY_KEY`** | EOA deploy + execute on Base Sepolia |
| **`E2E_UNIVOCITY_RPC_URL`** | RPC for propose/execute and Playwright `eth_call` |
| **`GITAPP_ID`** / **`GITAPP_PRIVATE_KEY`** | CI: fetch univocity + univocity-tools releases |

## CI

**`provision-univocity`** runs on every same-repo PR (no feature flag). Outputs
contract addresses, genesis log IDs, base64 ES256 PEM, and KS256 bootstrap signer
to **`api-e2e-full`**.

Fork PRs skip provision; bootstrap system specs skip when env is unset.

## Local dev

```bash
doppler run --project canopy --config dev -- task test:e2e
doppler run --project canopy --config dev -- task test:e2e:preflight
```

Opt-out:

```bash
doppler run -- task test:e2e:preflight SKIP_UNIVOCITY_PROVISION=true
```

See [taskfiles/e2e-setup.md](../taskfiles/e2e-setup.md) and
[docs/agents/e2e.md](../agents/e2e.md).
