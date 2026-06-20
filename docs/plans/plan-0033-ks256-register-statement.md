# Plan 0033: KS256 register-statement parity

**Status**: ACTIVE  
**Date**: 2026-06-14  
**Related**:
- [plan-0031](plan-0031-ks256-forest-roots.md) (KS256 forest roots — left statement verify out of scope)
- [forest-1 plan-0002](../../../forest-1/docs/plans/plan-0002-per-slot-pipeline-rollout.md) (per-slot e2e sign-off)
- [FOR-74](https://linear.app/forestrie/issue/FOR-74) (self-describing COSE statements — deferred)
- [arc-statement-cose-encoding.md](../arc/arc-statement-cose-encoding.md)
- [ADR-0004](../adr/adr-0004-ks256-register-statement-binding.md)

## Goal

Enable **KS256** register-statement on par with **ES256**: verify statement COSE
Sign1 when `grantData` is a 20-byte Ethereum address, and re-enable the two
skipped KS256 cases in `bootstrap-log-first-entry.spec.ts`.

## Scope

- `register-signed-statement.ts`: dispatch signature verify by `grantData` length
  (64 = ES256 Web Crypto; 20 = KS256 Keccak + ecrecover / ERC-1271).
- E2e: `signKs256RootStatement`, flip KS256 `supportsRootStatementRegistration`,
  variant-aware wrong-signer test.
- Unit tests: `test/register-statement-ks256.test.ts`.
- Docs + ADR + glossary updates.

**Out of scope:** KS256 receipt/checkpoint Sign1 verify; self-describing statement
protected headers (`alg` in header) — see FOR-74.

## Binding convention

- KS256 statement COSE `kid` = **20-byte address** (== full `grantData`).
- Protected header (this plan): `{4: address}` only (kid-only; same shape as ES256
  statements which use `{4: x}`).
- Verifier selects ES256 vs KS256 from **grant** `grantData` length, not from the
  statement header.

## Verification

```sh
pnpm -r --filter './packages/**' typecheck
pnpm --filter @canopy/api test

doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/bootstrap-log-first-entry.spec.ts
```

Expected: KS256 first-entry cases pass; default system tier skip count drops by 2
(BYOK stretch specs remain opt-in).

## Implementation status

| Phase | Task | Status |
|-------|------|--------|
| 0 | `@canopy/api` unit tests + typecheck | Done |
| 1 | Land code, ADR, docs, README index | In progress |
| 2 | Deploy `canopy-api` Lane A + B (`forest-dev-5`) | Pending |
| 3 | `bootstrap-log-first-entry.spec.ts` dev + prd | Pending |
| 4 | Full `task test:e2e` 22/22 both lanes | Pending |
| 5 | Mark plan IMPLEMENTED; update plan-0002 sign-off | Pending |
