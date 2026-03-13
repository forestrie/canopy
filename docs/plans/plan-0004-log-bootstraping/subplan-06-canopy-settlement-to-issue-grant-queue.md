# Subplan 06: Canopy — settlement → grant creation and sequencing

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- After **x402 settlement** completes (payment verified and settled for a grant resource), **canopy** (canopy-api or x402-settlement worker):
  1. **Creates the grant** (requests delegation, signs grant per subplan 01).
  2. **Runs grant-sequencing**: produces entry (ownerLogId, ContentHash = inner) and **pushes to the same DO** as register-signed-statement (forestrie-ingress SequencingQueue). Ranger extends the log (unchanged except optional idtimestamps in ack per config).
  3. **Publishes grant** to storage (with idtimestamp and mmrIndex when sequencing completes); client obtains **grant location** via settlement callback, status endpoint, or poll.
- **Return path for idtimestamp**: After sequencing, canopy obtains (leafIndex, massifIndex, and when present idTimestamp) via `resolveContent(inner)`. Canopy **must not assume** idtimestamp is in the DO: when idTimestamp is missing or null, canopy **must** use the R2 fallback (e.g. `readIdtimestampFromMassif`). Grant document is then written with (idtimestamp, mmrIndex) and published.
- No enqueue to arbor queue in the primary path. Canopy is the direct user of the DO (same as register-signed-statement).

**Out of scope**: Optional arbor queue consumer (subplan 05); x402 verify/settle logic (existing); placeholder register-grant behaviour when not using authority log (can remain for dev).

## 2. Dependencies

- **Subplans 01, 02, 03, 04**: Grant encoding (01); auth log status if needed (02); grant-sequencing is canopy push to same DO (03); signer delegation for bootstrap/parent (04). No dependency on subplan 05 (arbor queue) for primary path.

## 3. Inputs

- Where settlement runs: canopy-api vs x402-settlement worker (overview refinement §4.6).
- Grant request shape: what the register-grant (or grant resource) receives from the client (logId, ownerLogId, kind, grant params, etc.); canopy creates the grant after settlement.
- DO binding: same SequencingQueue as register-signed-statement (forestrie-ingress); `enqueue(ownerLogId, inner, extras)` for grant-sequencing.
- How client gets grant location: settlement completion payload, status URL, or receipt field (refinement §4.6).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Grant creation on settlement** | After successful settlement, canopy creates the grant (delegation + sign), computes inner (subplan 01), pushes to same DO via `enqueue(ownerLogId, inner, extras)` (grant-sequencing). When sequenced, canopy gets result via resolveContent; if idTimestamp not in DO, uses R2 fallback (readIdtimestampFromMassif). Publishes grant to storage with (idtimestamp, mmrIndex). |
| **Idempotency** | Use settlement id (or equivalent) as idempotency key so duplicate settle does not create duplicate grant; grant-sequencing dedupe as per subplan 03. |
| **Client grant location** | Grant location (path) available to client via chosen mechanism (callback, poll, receipt). |

## 5. Verification

- End-to-end: client pays at register-grant (or grant resource) → settlement completes → canopy creates grant, pushes to same DO (grant-sequencing), publishes grant → client can obtain grant location (and use it at register-statement).
- Duplicate settlement for same auth/session does not create duplicate grant (idempotency / grant-sequencing dedupe).

## 6. Implementation plan (agent-optimised)

Primary path: canopy creates grant after x402 settlement and runs grant-sequencing (same DO as register-signed-statement). Depends on subplans 01, 03, 04; optionally 02 for auth log status. Return path: resolveContent(inner) for leafIndex, massifIndex, idTimestamp; when idTimestamp not in DO, use R2 fallback (e.g. readIdtimestampFromMassif).

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **6.1** | Settlement completion hook | x402 settlement success (canopy-api or x402-settlement worker) | Grant params: logId, ownerLogId, kind, grant params, settlement id (idempotency) | Canopy: settlement handler. Extract from settlement payload; validate. | Same payload used for grant creation. |
| **6.2** | Request delegation | Grant params (kind: bootstrap vs derived); subplan 04 signer API | Delegation for local key (bootstrap) or parent log (derived) | Call signer: “delegation for local key” or “delegation for parent log” with parentLogId. | No private key in canopy; delegation only. |
| **6.3** | Build and sign grant; compute inner | Delegation; subplan 01 encoding (go-univocity or equivalent) | Signed grant; ContentHash = inner (InnerHash) | Build grant struct; sign with delegation; compute inner = InnerHashFromGrant (subplan 01). | Inner matches go-univocity; signature verifies. |
| **6.4** | Grant-sequencing: enqueue and wait for result | ownerLogId, inner, extras; same DO as register-signed-statement (forestrie-ingress SequencingQueue) | Sequencing result: leafIndex, massifIndex; idTimestamp if present in DO | Enqueue(ownerLogId, inner, extras). Poll or callback for result. Dedupe by inner (subplan 03). | Entry in DO; ranger extends log; result returned. |
| **6.5** | Resolve idtimestamp and write grant doc | Result from 6.4; resolveContent(inner) | idtimestamp (from DO or R2 fallback), mmrIndex | Call resolveContent(inner). If idTimestamp in DO use it; else use R2 fallback (readIdtimestampFromMassif). Write grant document with idtimestamp, mmrIndex; publish to storage. | Grant doc has correct idtimestamp; no assumption idtimestamp always in DO. |
| **6.6** | Return grant location to client | Grant path after publish | Client receives path via callback, status URL, or receipt | Settlement completion payload or status endpoint includes grant location (path). Idempotency: settlement id → at most one grant. | E2E: client pays → gets grant location → can use at register-statement. |
| **6.7** | Wire settlement → grant flow | Where settlement runs (refinement §4.6) | End-to-end: settlement → 6.1–6.6 | Canopy-api or worker: on settlement success invoke 6.1–6.6. Config: signer URL, DO/SequencingQueue, R2, resolveContent and R2 fallback. | Duplicate settlement does not create duplicate grant. |

**Data flow (concise).** Settlement success (6.1) → delegation (6.2) → build grant + inner (6.3) → enqueue to same DO, poll result (6.4) → resolve idtimestamp (DO or R2), write grant doc, publish (6.5) → return location to client (6.6). Wiring in 6.7.

**Files to add or touch (canopy).** Settlement handler (canopy-api or x402-settlement worker): extract grant params (6.1); signer client and delegation request (6.2); grant build and inner (subplan 01) (6.3); DO client and grant-sequencing enqueue/poll (6.4); resolveContent and R2 fallback, grant doc write and publish (6.5); response/callback with grant location (6.6); config and wiring (6.7). Same DO binding as register-signed-statement (forestrie-ingress SequencingQueue).

## 7. References

- Overview: §3 (x402-triggered grant creation), §6 (canopy creates grant and sequences); refinement §4.6.
- Plan 0001: register-grant placeholder; x402 flow.
