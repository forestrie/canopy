# Subplan 07: Sealer — key resolution per log

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- The **sealer** must **request the appropriate signing key for each log** it needs to sign (e.g. root key for root log, parent/root key for child auth log, log’s own key for data log).
- Implement this by having the sealer call the **REST auth log status service** (subplan 02) to resolve “which signing key (or key id) for this logId?” using log type and owner.
- **Find-grant process** is unchanged: sealer continues to find grants in storage; this subplan only adds **key resolution** so the sealer knows which key to use when signing a checkpoint for a given log.

**Out of scope**: REST service implementation (subplan 02); queue consumer; ranger; signer delegation API (subplan 04).

## 2. Dependencies

- **Subplan 02**: REST auth log status service exposes a query that supports “which key for logId?” (log type, owner, or key id).

## 3. Inputs

- REST service endpoint and response shape for key-resolution query (overview refinement §4.2, §4.7).
- When sealer resolves: per checkpoint, per log at startup, or cached with invalidation (refinement §4.7).
- Mapping: “log type + owner” → “which key to request from signer” (bootstrap key id vs parent log key id vs log’s own key id).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Call REST for key resolution** | For each log the sealer must sign, call the auth log status service (or use cached result) to get the key id or endpoint for that log. |
| **Map to signer request** | Use the response to request the correct delegation or key from the signer (bootstrap for root, parent for child, etc.). |
| **Failure behaviour** | Define and implement behaviour when REST is unavailable or logId unknown (retry, fail checkpoint, backoff). |

## 5. Verification

- Sealer signing a checkpoint for log L uses the key resolved via the REST service for L (e.g. root key for root log, correct parent/key for derived log).
- If REST returns “unknown logId” or errors, sealer behaviour is consistent (e.g. no signature, or retry with backoff); no silent wrong-key use.

## 6. References

- Overview: §4.3 (sealer key resolution), §8 (sealer finds grant, requests key per log); refinement §4.7.
- Subplan 02: REST auth log status service.
