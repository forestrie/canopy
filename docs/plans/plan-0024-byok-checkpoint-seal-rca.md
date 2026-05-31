# BYOK checkpoint seal stretch — root cause analysis

**Status:** ACCEPTED  
**Date:** 2026-05-30  
**Related:** [plan-0021](plan-0021-delegation-coordinator-apis.md),
[arbor plan-0006](https://github.com/forestrie/arbor/blob/main/docs/plan-0006-byok-checkpoint-seal-end-to-end.md)

## Summary

Deployed `E2E_BYOK_SEAL_STRETCH=1` failed primarily because Playwright-built
delegation certificates used **string-key CBOR maps** in payload field `5`
(delegated COSE_Key). The coordinator stored that material without validation;
Sealer rejected the lease with `expected kty EC2` / `delegated key is not a map`
(non-retryable verify errors). The wallet then saw **empty pending** and endless
receipt **404** (`checkpoint missing`), which looked like an e2e timing bug.

## Evidence (forest-dev-5 / `forestrie-a`)

| Layer       | Observation                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ranger      | `committed` for test log ids (massif written)                                                                            |
| Sealer      | `verify delegation lease: delegated public key: expected kty EC2` and `delegated key is not a map` after material upload |
| Coordinator | Pending cleared after `POST /api/delegations/material`; poison cert remained in `materials`                              |
| Playwright  | Receipt redirect reached; `GET …/receipt` timed out on 404                                                               |

## Design issues addressed in remediation

- **A** Encoding contract: integer-key COSE maps; golden-vector test; `mapsAsObjects: false`.
- **B** Coordinator validates material before store (reject 400).
- **C** Pending issue returns **202 Accepted** + `Retry-After` (not 503).
- **D** Documented status→receipt vs checkpoint race (e2e polls receipt).
- **E** E2e diagnostics: pending seen / material signed counts.
- **F** Sealer accepts 202 as `ErrDelegationPending`; structured verify-failure logs.
- **G** `auth-data-log-chain`: retry data grant until parent auth log MMRS-ready.
  **Superseded by [plan-0025](plan-0025-queue-independent-grant-authorization.md).**
  The MMRS-readiness retry was a symptom of authorizing the child-data grant from
  Durable Object queue state / `isLogInitializedMmrs(A)`. plan-0025 removes that:
  the child-data gate now verifies the parent auth log's **completed creation grant
  receipt** (later moved from the `Forestrie-Parent-Grant` header to the register-grant
  POST body; see [grants.md §11](../grants.md#11-evidence-transport-parent-grant-post-body)),
  so there is no readiness race and the retry crutch is gone.

## Out of scope (follow-up)

- Horizontal Sealer sharding (plan-0006 follow-up).
- SCRAPI status waiting for checkpoint before receipt redirect.
