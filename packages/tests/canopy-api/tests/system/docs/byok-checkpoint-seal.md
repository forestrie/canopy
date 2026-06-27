# System e2e — `byok-checkpoint-seal.spec.ts` (stretch)

**Spec:** `tests/system/byok-checkpoint-seal.spec.ts`  
**Index:** [README.md](./README.md)

**Opt-in:** `E2E_BYOK_SEAL_STRETCH=1` plus coordinator and ops admin env.
Skipped in default CI system tier (FOR-204); Mode C webhook seal covers default BYOK push path.

## Purpose

End-to-end proof of BYOK checkpoint sealing: runner-held log root,
coordinator `public-root`, Sealer ephemeral delegated keys, wallet-signed
material, Ranger massif commit, R2 checkpoint, and SCRAPI receipt verification.

## Run

```bash
E2E_BYOK_SEAL_STRETCH=1 doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
    tests/system/byok-checkpoint-seal.spec.ts
```

See prior flow diagram in git history; operational notes unchanged from stretch spec.
