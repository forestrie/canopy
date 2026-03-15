# Subplan 07: Sealer — key resolution per log

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- The **sealer** must **request the appropriate signing key for each log** it needs to sign (e.g. root key for root log, parent/root key for child auth log, log’s own key for data log).
- Implement this by having the sealer call the **REST auth log status service** (subplan 02) to resolve “which signing key (or key id) for this logId?” using log type and owner.
- **Find-grant process** is unchanged: sealer continues to find grants in storage; this subplan only adds **key resolution** so the sealer knows which key to use when signing a checkpoint for a given log.

**Out of scope**: REST service implementation (subplan 02); queue consumer; ranger; signer delegation API (subplan 04). Root bootstrap (subplan 08) — sealer does not trigger bootstrap; grant-first model applies.

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

## 6. Implementation plan (agent-optimised)

Sealer uses subplan 02 REST service to resolve “which signing key for this logId?” then requests that key (or delegation) from the signer. Find-grant is unchanged; this adds key resolution only.

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **6.1** | Determine logIds to sign | Checkpoint or batch; per-log decision | List of logIds for which the sealer must produce a signature | Arbor: sealer. For each checkpoint/log, decide which logId(s) need signing (root, child auth, data log). | Each log that requires a signature is included. |
| **6.2** | Call REST for key resolution | logId; subplan 02 base URL | GET /api/logs/{logId}/signing-key → { logId, kind, ownerLogId, rootKeyX, rootKeyY } or 404/error | HTTP client to auth log status service. Parse response. | Sealer gets key identity for known logId. |
| **6.3** | Map response to signer request | kind, ownerLogId, rootKeyX/Y | “Bootstrap key”, “parent log X”, or “log’s own key” for signer | Mapping: root / authority → bootstrap or parent key id; data log → log’s key. Use ownerLogId and kind from REST. | Correct key id passed to signer for each log type. |
| **6.4** | Request delegation/key from signer | Key id (from 6.3) | Delegation or key handle for signing | Existing signer API: request delegation for that key. | Signature produced with correct key. |
| **6.5** | Sign checkpoint using resolved key | Delegation; checkpoint payload | Signature for that log | Use delegation to sign; attach to checkpoint. No private key in sealer. | Checkpoint signed with key for that logId. |
| **6.6** | Failure and retry behaviour | REST errors, 404, timeouts | Defined behaviour: retry with backoff, or fail checkpoint; never use wrong key | Document and implement: REST unavailable or unknown logId → retry (with limit) or mark checkpoint failed; do not fall back to another key. | No silent wrong-key use; behaviour consistent and documented. |
| **6.7** | Caching (optional) | Resolution per logId | Cache key resolution per logId with TTL or invalidation to avoid repeated REST calls | Per refinement §4.7: resolve per checkpoint vs cache. Implement chosen strategy. | Cached resolution matches fresh call when log unchanged. |

**Data flow (concise).** For each log to sign (6.1) → GET signing-key from REST (6.2) → map to signer key id (6.3) → request delegation (6.4) → sign checkpoint (6.5). Handle failures explicitly (6.6); optional cache (6.7).

**Files to add or touch (arbor).** Sealer service: module or package that takes logId → calls subplan 02 REST → maps to signer request → returns delegation or key handle; integration in checkpoint signing path (6.1–6.5); config: auth log status service URL; failure and retry logic (6.6); optional cache (6.7). Repo: sealer (e.g. `services/sealer/` or equivalent). Find-grant code unchanged.

## 7. References

- Overview: §4.3 (sealer key resolution), §8 (sealer finds grant, requests key per log); refinement §4.7.
- Subplan 02: REST auth log status service.
