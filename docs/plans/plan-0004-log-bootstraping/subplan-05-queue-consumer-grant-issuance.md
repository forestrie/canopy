# Subplan 05: Queue consumer — grant-issuance service

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- Implement the **queue consumer** in arbor/services (ranger-like) that:
  - Is **configured with** bootstrap public key (or id) and univocity contract address.
  - Consumes **“issue grant”** messages (from x402 settlement path; see subplan 06).
  - For **root bootstrap** (contract not yet bootstrapped): requests delegation for local key, creates and signs initial grant, sends leaf to ranger queue, publishes grant to storage.
  - For **derived logs** (child authority or data log): requests delegation for parent log, creates and signs grant, sends leaf to ranger queue (append to parent MMR), publishes grant to storage.
- Does **not** hold bootstrap or any log private key; uses signer delegations only. Does **not** maintain the MMR; ranger does the append.

**Out of scope**: Canopy enqueue (subplan 06); sealer find-grant (existing); chain submission of first checkpoint (sealer/existing flow).

## 2. Dependencies

- **Subplan 01**: Grant/leaf encoding and leaf commitment.
- **Subplan 02**: Detect “contract not bootstrapped”; resolve parent log for derived logs (and possibly key resolution).
- **Subplan 03**: Ranger consumes “append leaf” and updates authority MMR; queue consumer sends leaf to ranger’s queue.
- **Subplan 04**: Request delegation for local key (bootstrap) and for parent log (derived).

## 3. Inputs

- “Issue grant” message schema (overview refinement §4.5): grant request fields, settlement id / idempotency key, target logId, ownerLogId, kind (bootstrap vs derived).
- Config: bootstrap public key (or id), univocity contract address, RPC URL, queue binding for ranger, storage (R2) path for grant publication.
- Grant storage path convention (same as canopy R2_GRANTS content-addressable path or agreed variant).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Queue consumer** | Service that consumes “issue grant” messages; implements bootstrap and derived-log flows. |
| **Bootstrap flow** | Detect “not bootstrapped” (via subplan 02 or chain); request delegation for local key; create and sign initial grant; send leaf to ranger queue; publish grant to storage. |
| **Derived flow** | Resolve parent (via subplan 02); request delegation for parent log; create and sign grant; send leaf to ranger queue (parent MMR); publish grant to storage. |
| **Result for client** | Grant location (path) written where settlement/client can read it (poll or callback); optional idempotency handling. |

## 5. Verification

- **Bootstrap**: With contract not bootstrapped, send “issue grant” (bootstrap); consumer creates grant, sends leaf to ranger, publishes grant; sealer find-grant can discover the grant; leaf appears in ranger’s authority MMR.
- **Derived**: With parent log existing, send “issue grant” (derived, parentLogId); consumer creates grant, sends leaf to ranger (parent MMR), publishes grant; sealer find-grant discovers grant.
- No private keys in consumer config or process; all signing via signer delegation.

## 6. References

- Overview: §3 (queue consumer), §5 (bootstrap and derived flows), §6 (grant issuance flow), §8 (delegation); refinement §4.5.
- Subplans 01–04.
