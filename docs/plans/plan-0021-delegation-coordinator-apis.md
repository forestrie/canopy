# Plan 0021: Delegation Coordinator APIs (custodial-trust-root path)

**Status:** DRAFT  
**Date:** 2026-05-24  
**Related:** [plan-0016](plan-0016-delegation-signer-custodian-migration.md), [arbor plan-0003](../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md), [ARC-0001 per-project ingress](../../forest-1/docs/arc-0001-per-project-ingress-isolation.md), [plan-0022 ops parity](plan-0022-delegation-coordinator-ops-parity.md)

---

## Purpose

Deliver Delegation Coordinator Phase 3 **management APIs** (no frontend) on a new Canopy Worker, with Phase 2 custodian proxy and coordinator issuance skeleton. Keep **custodian-based trust root** throughout; defer Univocity integration and wallet UI.

## Scope

- **`delegation-coordinator`** Worker at `coordinator-dev.forestrie.dev` (prod: `coordinator.forestrie.dev`)
- Sharded **`DelegationStoreDO`** (`shard-0` … `shard-{N-1}`) via `@canopy/forestrie-sharding`
- Phase 3 APIs: signing-route, material submit, pending list, custody-keys orchestration
- Custodian **`DELEGATION_COORDINATOR_URL`** proxy on local-key miss and wallet-managed logs
- Playwright **coordinator** e2e project

## Out of scope (this milestone)

- Univocity trust-root adapter
- Zero-Custodian receipt verify for BYOK logs
- Wallet frontend
- Per-project Worker cutover (ARC-0001 deferred; v1 shared dev script OK)

## Acceptance criteria

- [ ] `delegation-coordinator-dev` deployed at `coordinator-dev.forestrie.dev`
- [ ] Phase 3 four APIs with DO persistence and `COORDINATOR_APP_TOKEN` auth
- [ ] Custodian proxies to coordinator on local-key miss and wallet-managed logs
- [ ] Coordinator never calls Custodian sign endpoints
- [ ] Playwright coordinator project green in CI
- [ ] Custodian proxy issuance e2e: `POST /api/delegations` returns cert from stored material
- [ ] Existing system e2e remain green
