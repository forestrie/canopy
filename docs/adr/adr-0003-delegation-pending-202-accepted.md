# ADR-0003: Delegation pending returns 202 Accepted

**Status:** ACCEPTED  
**Date:** 2026-05-30  
**Related:** [plan-0024](plans/plan-0024-byok-checkpoint-seal-rca.md),
[plan-0021](plans/plan-0021-delegation-coordinator-apis.md)

## Context

`POST /api/delegations` on the Delegation Coordinator returns a stored
certificate when wallet material exists. When material is missing, the
coordinator records a pending row and must signal that the **wallet** (or test
runner) should sign and upload material — not that the service is down.

Historically this path returned **503 Service Unavailable**, which Sealer and
Custodian mapped to `ErrDelegationPending` for queue retry. That conflated
“action required” with outage.

## Decision

1. **Coordinator** returns **202 Accepted** with `Content-Type:
   application/problem+cbor`, `Retry-After: 5`, and detail
   `delegation material not found for requested range and key` when material
   is missing after enqueueing pending state.

2. **503** remains for true unavailability (misconfiguration, internal errors).

3. **Sealer** and **Custodian proxy** treat **202** and **503** with the
   pending detail as `ErrDelegationPending` (defer queue ack, retry).

4. **`POST /api/delegations/material`** validates certificates before store:
   ES256 signature against uploaded `public-root`, integer-key COSE_Key in
   payload field `5`, and match to request `delegatedPublicKey`. Invalid
   material returns **400** without deleting pending.

## Consequences

- E2e and stretch tests expect **202** on first issue miss.
- Clients should poll `GET /api/logs/{logId}/pending-delegation` or retry issue
  after uploading material.
- Legacy **503** pending responses remain accepted by Sealer during transition.
