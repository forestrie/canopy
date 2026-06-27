# Plan 0047 — KS256 BYOK register-grant remediation (FOR-204)

**Status:** IMPLEMENTED  
**Date:** 2026-06-27  
**Linear:** [FOR-204](https://linear.app/forestrie/issue/FOR-204)  
**Parent:** [plan-0044](plan-0044-package-d-cross-stack-e2e.md) (FOR-201)  
**Design:** [arbor ADR-0006](https://github.com/forestrie/arbor/blob/main/docs/adr/adr-0006-genesis-authoritative-byok-root-key.md)

---

## Problem

Mode C e2e (`byok-mode-c-webhook-seal.spec.ts`) failed at register-grant with:

```text
403 grant chain invalid — grant envelope not signed by owner root key
```

Mode C stores the **user's** KS256 address in genesis but pre-FOR-123 univocity
verified root grants against on-chain **contract deployer** `bootstrapConfig()`
only.

## Root cause

Application fix landed in arbor **FOR-123** (`366b223`, ADR-0006): stored
genesis `(alg,key)` overrides contract when they differ.

Operational gap: cross-stack e2e had **no deploy-readiness gate** and image
automation **merge workflow** cancelled overlapping runs when five IUAs pushed
after one arbor build.

Arbor CI and Flux git automation **did** produce `main-d25d42e-433` on
`arbor-flux` main; failure was exercising stale runtime or running before cluster
reconcile.

## Remediation (implemented)

| Area | Change |
|------|--------|
| **arbor-flux** | `flux-image-updates-merge.yaml`: `cancel-in-progress: false`; skip when branch already merged |
| **forest-1** | `ops-cd-flow.md`: IUA → `flux/image-updates` → merge → `main` |
| **canopy preflight** | `e2e-shared:validate-univocity-deploy` task; wired in `test:e2e:preflight` |
| **canopy CI** | `tests-system.yml`: `E2E_MODE_C_WEBHOOK_IN_CI=1`, readiness script before system tier |
| **canopy e2e** | Mode C spec default in CI when env flag set (playwright.config.ts unchanged guard, flag now on in CI) |

## Verification

```bash
# Cluster (operator)
kubectl -n forestrie-a get deploy univocity -o jsonpath='{.spec.template.spec.containers[0].image}'
curl -sS "${UNIVOCITY_SERVICE_URL}/version"

# Local / CI preflight
doppler run --project canopy --config dev -- task test:e2e:preflight
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/byok-mode-c-webhook-seal.spec.ts
```

## Success criteria

- Runtime univocity commit ≥ FOR-123 (`366b223`).
- Preflight fails fast with CD message when univocity is stale.
- `byok-mode-c-webhook-seal.spec.ts` runs in default system CI.
- IUA merge pipeline converges without cancelled merge runs blocking promotion.
