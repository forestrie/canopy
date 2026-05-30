# Plan 0021: Delegation Coordinator APIs (custodial-trust-root path)

**Status:** DRAFT  
**Date:** 2026-05-24  
**Related:** [plan-0016](plan-0016-delegation-signer-custodian-migration.md), [arbor plan-0003](../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md), [arbor plan-0004 (ACCEPTED)](../../arbor/docs/plan-0004-coordinator-backed-byok-lease-proof.md), [ARC-0001 per-project ingress](../../forest-1/docs/arc-0001-per-project-ingress-isolation.md), [plan-0022 ops parity](plan-0022-delegation-coordinator-ops-parity.md)

---

## Purpose

Deliver Delegation Coordinator Phase 3 **management APIs** (no frontend) on a new Canopy Worker, with Phase 2 custodian proxy and coordinator issuance skeleton. Keep **custodian-based trust root** throughout; defer Univocity integration and wallet UI.

## Scope

- **`delegation-coordinator`** Worker at `coordinator.{DNS_SUB}.{DNS_APEX}` (catalog; prod: `coordinator.{DNS_APEX}` when bound)
- Sharded **`DelegationStoreDO`** (`shard-0` … `shard-{N-1}`) via `@canopy/forestrie-sharding`
- Phase 3 APIs: signing-route, material submit, pending list, custody-keys orchestration
- Custodian **`DELEGATION_COORDINATOR_URL`** proxy on **local KMS miss only** (KMS presence is routing source of truth; Custodian does not probe coordinator `signing-route.mode`)
- Playwright **coordinator** e2e project

## Out of scope (this milestone)

- Univocity trust-root adapter
- Zero-Custodian receipt verify for BYOK logs
- Wallet frontend
- Per-project Worker cutover (ARC-0001) — pilot on forest-dev-5; see [forest-1 plan-0001](../../forest-1/docs/plans/plan-0001-dns-catalog-rollout-completion.md)

## Acceptance criteria

- [x] `delegation-coordinator-dev` deployed at catalog `coordinator.{DNS_SUB}.{DNS_APEX}`
- [x] Phase 3 four APIs with DO persistence and `COORDINATOR_APP_TOKEN` auth
- [x] Custodian proxies to coordinator on local-key miss when `DELEGATION_COORDINATOR_URL` is set (arbor `29f08dc`; see [arbor plan-0003 § Custodian routing](../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md))
- [x] Coordinator never calls Custodian sign endpoints
- [x] Playwright coordinator project green in CI (`coordinator-api` + `coordinator-byok-material`)
- [x] Custodian proxy issuance e2e: `POST /api/delegations` returns cert from stored material (`coordinator-delegation-issuance.spec.ts` stretch with `E2E_COORDINATOR_SEALER_STRETCH=1`)
- [x] Existing system e2e remain green
