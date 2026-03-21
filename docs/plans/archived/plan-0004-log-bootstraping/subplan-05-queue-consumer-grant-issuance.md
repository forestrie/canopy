# Subplan 05: Queue consumer — grant-issuance (optional)

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)  
**Related**: [Subplan 08 grant-first bootstrap](subplan-08-grant-first-bootstrap.md) (root bootstrap is **not** via queue consumer)

## 1. Scope

**Primary path is canopy** (subplan 06 for paid grants; subplan 08 for root bootstrap). This subplan is **optional/legacy** — implement only if an arbor queue consumer for **paid** grant issuance is needed.

- If implemented, the **queue consumer** in arbor/services would:
  - Is **configured with** bootstrap public key (or id) and univocity contract address.
  - Consumes **“issue grant”** messages (from x402 settlement path; see subplan 06).
  - For **root bootstrap** (contract not yet bootstrapped): requests delegation for local key, creates and signs initial grant; hands off to grant-sequencing path (subplan 03) so the leaf is appended to the authority log; publishes grant to storage.
  - For **derived logs** (child authority or data log): requests delegation for parent log, creates and signs grant; hands off to grant-sequencing path (subplan 03) so the leaf is appended to the parent MMR; publishes grant to storage.
- Does **not** hold bootstrap or any log private key; uses signer delegations only. Does **not** maintain the MMR; the grant-sequencing component (subplan 03) feeds ranger’s existing pipeline; ranger: optional idtimestamps in ack when configured (subplan 03 §7.1).

**Out of scope**: Canopy primary path (subplan 06); root bootstrap (subplan 08); sealer find-grant (existing); chain submission.

## 2. Dependencies

- **Subplan 01**: Grant/leaf encoding and leaf commitment.
- **Subplan 02**: Detect “contract not bootstrapped”; resolve parent log for derived logs (and possibly key resolution).
- **Subplan 03**: Grant-sequencing component completes register-grant and feeds ranger’s existing pipeline (ranger: optional idtimestamps in ack when configured); queue consumer (or register-grant path) hands off to that path. Result path: resolveContent + R2 fallback when idtimestamp not in DO.
- **Subplan 04**: Request delegation for local key (bootstrap) and for parent log (derived).

## 3. Inputs

- “Issue grant” message schema (overview refinement §4.5): grant request fields, settlement id / idempotency key, target logId, ownerLogId, kind (bootstrap vs derived).
- Config: bootstrap public key (or id), univocity contract address, RPC URL; handoff to grant-sequencing (subplan 03) — mechanism TBD (queue, HTTP, or same pipeline); storage (R2) path for grant publication.
- Grant storage path convention (same as canopy R2_GRANTS content-addressable path or agreed variant).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Queue consumer** | Service that consumes “issue grant” messages; implements bootstrap and derived-log flows. |
| **Bootstrap flow** | Detect “not bootstrapped” (via subplan 02 or chain); request delegation for local key; create and sign initial grant; hand off to grant-sequencing (subplan 03); publish grant to storage. |
| **Derived flow** | Resolve parent (via subplan 02); request delegation for parent log; create and sign grant; hand off to grant-sequencing (subplan 03); publish grant to storage. |
| **Result for client** | Grant location (path) written where settlement/client can read it (poll or callback); optional idempotency handling. |

## 5. Verification

- **Bootstrap**: With contract not bootstrapped, send “issue grant” (bootstrap); consumer creates grant, hands off to grant-sequencing (subplan 03); grant published; sealer find-grant can discover the grant; leaf appears in authority MMR via ranger’s existing pipeline.
- **Derived**: With parent log existing, send “issue grant” (derived, parentLogId); consumer creates grant, hands off to grant-sequencing (subplan 03); grant published; sealer find-grant discovers grant.
- No private keys in consumer config or process; all signing via signer delegation.

## 6. Implementation plan (agent-optimised)

Optional/legacy path: implement only if an arbor queue consumer for “issue grant” is needed. Depends on subplans 01–04 and 03 (grant-sequencing). Handoff to grant-sequencing: call canopy API that enqueues to same DO, or direct DO client per environment.

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **6.1** | Define “issue grant” message schema and config | Overview §4.5; settlement id for idempotency | Message schema (target logId, ownerLogId, kind, params, idempotency key); config: bootstrap key id, contract address, RPC, signer URL, grant-sequencing endpoint or DO client, storage (R2) path | Arbor: queue consumer service. Schema: bootstrap vs derived; fields for parent when derived. | Doc: message shape and config vars. |
| **6.2** | Implement message consumer loop | Queue (source of “issue grant” messages) | Dequeue message → route to bootstrap or derived handler | Same service. Parse message; if kind=bootstrap → 6.3; if derived → 6.4. | Unit test: mock queue, assert correct handler invoked. |
| **6.3** | Bootstrap branch | Message (bootstrap); subplan 02 root API; subplan 04 delegation for local key; subplan 01 encoding; subplan 03 handoff | Grant created, signed, handed to grant-sequencing, then published to storage | Call GET /api/root (02); if exists skip or fail; else request delegation for local key (04); build initial grant (01); sign; call grant-sequencing (03) e.g. HTTP to canopy or DO enqueue; poll/result path; write grant to R2; record location for client. | E2E: contract not bootstrapped → send message → grant published; leaf in authority MMR via ranger. |
| **6.4** | Derived branch | Message (derived, parentLogId); subplan 02 logs/config; subplan 04 delegation for parent; subplan 01; subplan 03 | Grant created, signed, handed to grant-sequencing, published | Resolve parent via 02; request delegation for parent log (04); build grant (01); sign; handoff to grant-sequencing (03); publish; record location. | E2E: parent exists → send message → grant published; find-grant discovers it. |
| **6.5** | Result for client | Grant location (path) after publish | Client can poll or receive callback with grant path | Write location to agreed store (e.g. by settlement id or idempotency key); optional callback URL in message. Idempotency: same key → no duplicate grant (dedupe in 03). | Duplicate message with same idempotency key does not create second grant. |
| **6.6** | Wire and deploy | Config, queue connection, signer URL, 02 URL, grant-sequencing/DO, R2 | Running consumer | Startup: validate config; connect queue; run loop. No private keys in config. | No keys in env; all signing via signer. |

**Data flow (concise).** Dequeue “issue grant” (6.1–6.2) → bootstrap (6.3): root check → delegation local key → build grant → grant-sequencing → publish → client result; or derived (6.4): resolve parent → delegation parent → build grant → grant-sequencing → publish → client result (6.5). Wire and run (6.6).

**Files to add or touch (arbor).** Queue consumer service: message schema and config (6.1); consumer loop and routing (6.2); bootstrap handler calling 02, 04, 01, 03 and R2 (6.3); derived handler (6.4); result/location and idempotency (6.5); main/config and deployment (6.6). Repo: `services/` (e.g. grant-issuance consumer or existing queue service). Grant-sequencing handoff: either HTTP client to canopy endpoint that enqueues to DO, or direct DO client; choose per env and document.

## 7. References

- Overview: §3 (queue consumer), §5 (bootstrap and derived flows), §6 (grant issuance flow), §8 (delegation); refinement §4.5.
- Subplans 01–04.
