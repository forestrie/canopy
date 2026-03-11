# Subplan 06: Canopy — settlement to issue-grant queue

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- After **x402 settlement** completes (payment verified and settled for a grant resource), the canopy side **enqueues** an “issue grant” message to the **arbor queue** consumed by the queue consumer (subplan 05).
- Message must carry: grant request (or sufficient payload for queue consumer to create the grant), **settlement id** or **idempotency key**, and any routing (target logId, kind).
- Client obtains **grant location** via existing settlement callback, status endpoint, or poll.

**Out of scope**: Queue consumer implementation (subplan 05); x402 verify/settle logic (existing); placeholder register-grant behaviour when not using authority log (can remain for dev).

## 2. Dependencies

- **Subplan 05**: Queue consumer and its queue exist; message schema agreed so canopy sends the correct payload.

## 3. Inputs

- Where settlement runs: canopy-api vs x402-settlement worker (overview refinement §4.6).
- Queue identity: queue name, region, and binding (e.g. Cloudflare Queue, SQS); how arbor queue consumer is bound.
- Grant request shape: what the register-grant (or grant resource) receives from the client and what must be passed to the queue (logId, ownerLogId, kind, grant params, etc.).
- How client gets grant location: settlement completion payload, status URL, or receipt field (refinement §4.6).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Enqueue on settlement** | After successful settlement for a grant, enqueue one message to the arbor “issue grant” queue with agreed schema. |
| **Idempotency** | Use settlement id (or equivalent) as idempotency key so duplicate settle does not create duplicate grant. |
| **Client grant location** | Grant location (path) available to client via chosen mechanism (callback, poll, receipt). |

## 5. Verification

- End-to-end: client pays at register-grant (or grant resource) → settlement completes → message appears on arbor queue → queue consumer processes and publishes grant → client can obtain grant location (and use it at register-statement).
- Duplicate settlement for same auth/session does not enqueue twice (or queue consumer deduplicates by idempotency key).

## 6. References

- Overview: §3 (x402-triggered grant creation), §6 (canopy enqueues); refinement §4.6.
- Plan 0001: register-grant placeholder; x402 flow.
