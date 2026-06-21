# Plan 0022: Delegation coordinator ops and CI/CD parity

**Status:** DRAFT  
**Date:** 2026-05-24  
**Related:** [plan-0021 delegation coordinator APIs](plan-0021-delegation-coordinator-apis.md), [forest-1 bootstrap-canopy-contract](../../forest-1/docs/bootstrap-canopy-contract.md), [workers-environments](../workers-environments.md)

---

## Purpose

Align **delegation-coordinator** and custodian-proxy configuration with the existing
**canopy-api** / forest-1 consumer contract ops model: deploy workflows, GitHub
Environment vars/secrets, health gates, and cross-repo bootstrap tasks.

## Acceptance criteria

- [x] `DELEGATION_COORDINATOR_URL` documented and verified in forest-1 contract + GitHub + `canopy/{lane}` Doppler
- [ ] `COORDINATOR_APP_TOKEN` bootstrapped per lane (`bootstrap:canopy:bootstrap-coordinator-token`)
- [ ] `WEBHOOK_SIGNING_KEY_PEM` bootstrapped in Doppler + GitHub (`cf:coordinator:bootstrap-webhook-signing-key`); Secrets Store ensured on deploy
- [x] Coordinator `CUSTODIAN_URL` injected from GitHub vars at deploy (`apply-runtime-contract.mjs`)
- [x] Post-deploy health includes coordinator when URL configured
- [x] CI coordinator e2e required on `main` dev deploy (`require_coordinator_e2e`)
- [x] PR pipeline deploys coordinator when coordinator package changes
- [x] arbor-flux lane-aware `DELEGATION_COORDINATOR_URL` + optional `DELEGATION_COORDINATOR_TOKEN`

## Dev lane rollout (operator)

Run from **forest-1** with Doppler infra context:

```bash
export PROJECT_ID=forest-dev-5   # active forest project

# 1. Token (once per lane)
CANOPY_PROMOTION_LANE=dev \
  doppler run -p "${PROJECT_ID}" -c infra -- \
  task bootstrap:canopy:bootstrap-coordinator-token:"${PROJECT_ID}"

# 2. Contract + GitHub + canopy Doppler CI
CANOPY_PROMOTION_LANE=dev \
  doppler run -p "${PROJECT_ID}" -c infra -- \
  task bootstrap:canopy:sync-github-env:"${PROJECT_ID}"

# 3. Deploy coordinator Worker
SKIP_CANOPY_COORDINATOR_DEPLOY=0 CANOPY_PROMOTION_LANE=dev \
  doppler run -p "${PROJECT_ID}" -c infra -- \
  task bootstrap:canopy:deploy-coordinator:"${PROJECT_ID}"

# 4. Custodian config (arbor-flux)
CANOPY_PROMOTION_LANE=dev \
  doppler run -p "${GCP_PROJECT_ID}" -c infra -- \
  task service:populate-config:custodian
# Sealer/custodian/ranger/scout/univocity pick up Doppler changes via Reloader
# (~90s after Doppler sync; see arbor-flux service-secrets.md). No manual
# kubectl rollout restart for those services.

# 5. Verify
SKIP_CANOPY_HEALTH=0 SKIP_COORDINATOR_HEALTH=0 CANOPY_PROMOTION_LANE=dev \
  doppler run -p "${PROJECT_ID}" -c infra -- \
  task bootstrap:canopy:verify-contract:"${PROJECT_ID}"
```

Local coordinator e2e:

```bash
cd canopy && doppler run --project canopy --config dev --
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:coordinator
```

## Paired rollout rule

When changing **custodian proxy** (arbor) or **coordinator issuance** (canopy Worker):

1. Deploy **delegation-coordinator-**{lane}
2. Refresh custodian **`DELEGATION_COORDINATOR_URL`** (`service:populate-config:custodian` + `service:populate-config:sealer`); Reloader restarts affected arbor services automatically (~90s)
3. Run coordinator Playwright project in CI or locally

## Explicitly deferred

Per-project coordinator Worker (ARC-0001), in-cluster coordinator URL, prod lane until DNS + secrets ready.
