# Plan 0020: Custodial delegation seams pilot

**Status:** ACCEPTED  
**Date:** 2026-05-23  
**Related:** [plan-0016](plan-0016-delegation-signer-custodian-migration.md), [arbor plan-0003](../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md), [plan-0021 delegation coordinator APIs](plan-0021-delegation-coordinator-apis.md)

---

## Purpose

Validate target architecture and CBOR APIs using **custodied keys only**, before deploying Univocity trust-root service or Delegation Coordinator.

## Completed outcomes

- **Custodian** exposes `POST /api/delegations` (local custody sign only).
- **Sealer** uses `TrustRootClient` + `DelegationIssuer` seams with `TRUST_ROOT_URL` / `DELEGATION_ISSUER_URL` config.
- **Canopy** uses `ReceiptAuthorityResolver` with custodian-public trust-root adapter and local delegation verification.
- Existing system e2e remain green without Univocity or Coordinator.

## Return path

Master BYOK plan continues as **adapter swaps** (Univocity trust root, Coordinator proxy) — interfaces from this pilot are stable.
