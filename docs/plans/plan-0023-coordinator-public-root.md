# Plan 0023: Coordinator public-root endpoint

**Status:** DRAFT  
**Date:** 2026-05-30  
**Related:** [plan-0021](plan-0021-delegation-coordinator-apis.md),
[plan-0022](plan-0022-delegation-coordinator-ops-parity.md),
[arbor plan-0004 (ACCEPTED)](../../arbor/docs/plan-0004-coordinator-backed-byok-lease-proof.md),
[arbor plan-0005 § 1](../../arbor/docs/plan-0005-sealer-trust-root-end-to-end.md)

## Goal

Expose `POST` + `GET /api/logs/{logId}/public-root` on the delegation-coordinator
Worker so BYOK log root keys are stored and returned in the CBOR `TrustRootResponse`
shape Sealer expects. Coordinator-tier Playwright proves the uploaded root
verifies delegation material for the same log id.

## Acceptance criteria

- [x] `POST /api/logs/{logId}/public-root` persists ES256 `(x, y)` per log
- [x] `GET /api/logs/{logId}/public-root` returns `application/cbor` matching
  Sealer `TrustRootResponse`; 404 uses `application/problem+cbor`
- [x] DO unit tests: round-trip, 404, validation, upsert
- [x] Playwright `coordinator-byok-public-root.spec.ts` (coordinator project)
- [x] System/package e2e docs updated (public-root gap closed)

## Follow-up

See arbor [plan-0005](../../arbor/docs/plan-0005-sealer-trust-root-end-to-end.md)
§2–3 (Sealer `TRUST_ROOT_URL` flip, receipt-authority, full seal e2e).
