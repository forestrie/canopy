# Subplan 04: Signer — delegation for bootstrap and parent log

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- Extend the **signer service** (GCP HSM delegation pattern) to support:
  - **Delegation for a local key** (used for root bootstrap): the key that will act as the root signer and that matches the configured bootstrap public key.
  - **Delegation for the parent log** (used for derived logs): given a parent logId (or owner), return a delegation that can sign grants for creating a child authority or data log under that parent.
- The **queue consumer** (subplan 05) will request these delegations to **sign grants**; it must not hold any private key material.
- **Signing model**: Only **auth logs** have their own log signing key (in KMS). **Data log** checkpoints are signed by their **parent auth log**’s key. So “delegation for parent log” is used both to sign grants (create child logs) and, for the sealer, to sign checkpoints for data logs under that auth log.
- **Bootstrap key (operational)**: The bootstrap key must **exist in KMS before** the univocity contracts are deployed or initialized — the contract is configured with that key’s public key at bootstrap. The signer is configured with that pre-existing KMS key for “delegation for local key”. In a **simple deployment** where the bootstrap root auth log is the only auth log, “parent signs” works cleanly: the same bootstrap key is the parent for that root auth log, so one key serves both bootstrap and parent-signing for data logs under the root.

**Out of scope**: Queue consumer logic; ranger; chain submission; sealer key resolution (subplan 07). **Key creation** (creating a KMS key upon verified **GC_AUTH_LOG** grant only; rate limiting via high pricing of GC_AUTH_LOG grants) is a proposed extension; viability and security are assessed in [Subplan 04 assessment — key creation via delegation](subplan-04-assessment-key-creation-via-delegation.md). Design questions there should be resolved before updating this subplan to include key creation.

## 2. Dependencies

- None for building the signer extension. Required by subplan 05 (queue consumer requests delegation to sign grant).
- Optional: auth log status service (subplan 02) if signer needs to resolve “parent log” key via that service; otherwise signer may have its own mapping.

## 3. Inputs

- Existing signer API: how delegation is requested today (overview refinement §4.4).
- **Bootstrap key**: Pre-existing KMS key (created before contract deploy/init); operator configures the signer with that key’s id or public key so the contract’s root key matches. Signer uses it for “delegation for local key” and, in a single-auth-log deployment, for “delegation for parent log” (root auth log).
- For “delegation for parent log”: how parent is identified (auth logId) and how signer resolves the parent’s key (internal state vs call to auth log status service subplan 02). Parent is always an auth log; data logs do not have their own key.

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Delegation for local key** | API or flow by which a client (queue consumer) requests a delegation for the bootstrap/local key; signer returns a delegation usable for signing the initial grant. |
| **Delegation for parent log** | API or flow by which a client requests a delegation for “parent log L” (e.g. by parent logId); signer returns a delegation usable for signing a grant that creates a child under L. |
| **Documentation** | Contract for the queue consumer: request shape, response shape, and how they map to “sign this grant payload”. |

## 5. Verification

- Queue consumer (or test client) can request “delegation for local key” and receive a delegation that signs a payload; signature verifies with the configured bootstrap public key.
- Queue consumer (or test client) can request “delegation for parent log X” and receive a delegation that signs a grant for a child of X; signature verifies with the key associated with log X.
- No private key material is exposed to the queue consumer.

## 6. Implementation plan (agent-optimised)

Ordered steps so the queue consumer (subplan 05) or canopy (subplan 06) can request “delegation for local key” (bootstrap) or “delegation for parent log” and use the result to sign a grant. No private key material leaves the signer.

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **6.1** | Define “delegation for local key” API | Existing signer API (refinement §4.4) | Request/response shape (e.g. POST /delegate/bootstrap or /delegate/local-key) | Arbor: signer service. Request: optional payload hash or grant blob to sign. Response: delegation token or signed payload. | Doc: contract for queue consumer. |
| **6.2** | Implement delegation for local key | Bootstrap public key (or key id) in config | Delegation that signs with the configured bootstrap key | Resolve “local key” from config; use existing HSM delegation path; return delegation usable for one grant. | Test client: request delegation, sign a payload; signature verifies with configured bootstrap public key. |
| **6.3** | Define “delegation for parent log” API | Parent identified by logId | Request/response shape (e.g. POST /delegate/parent with logId) | Request: parentLogId (or ownerLogId). Response: delegation for that parent’s key. | Doc: contract for queue consumer. |
| **6.4** | Resolve parent key and implement delegation | parentLogId; signer’s mapping or call to subplan 02 | Delegation that signs with the key for that parent log | Map parentLogId → key id (internal config or GET from auth log status service subplan 02); request HSM delegation for that key; return delegation. | Test client: request delegation for parent X, sign grant for child of X; signature verifies with key for X. |
| **6.5** | Document for queue consumer | Request/response shapes, mapping to “sign this grant” | Doc: how to call each endpoint and use delegation to produce signed grant | Same repo or docs/. Describe bootstrap vs parent; no private key in consumer. | Queue consumer (or canopy) can implement “request delegation → build grant → sign” from doc alone. |

**Data flow (concise).** Client sends “delegation for local key” (6.1–6.2) or “delegation for parent log” with logId (6.3–6.4); signer returns delegation; client uses it to sign grant. Documentation (6.5) closes the contract for subplan 05/06.

**Implementation location:** **Canopy** delegation-signer (not arbor). KMS is not allowed from the arbor cluster; the sealer already obtains delegations from the Canopy delegation-signer. Subplan 04 is implemented by **extending** that same service. See [Subplan 04 — delegation-signer in Canopy](subplan-04-delegation-signer-in-canopy.md) for architecture and [agent-optimised instructions](subplan-04-delegation-signer-in-canopy.md#4-agent-optimised-instructions-plan-0004-subplan-04-in-canopy) (how the log is communicated, why it is secure, implementation steps). **Files to add or touch (Canopy):** `packages/apps/delegation-signer`: new handlers for POST /api/delegate/bootstrap and POST /api/delegate/parent; optional env DELEGATION_SIGNER_UNIVOCITY_URL, DELEGATION_SIGNER_ROOT_LOG_ID, DELEGATION_SIGNER_PARENT_KEYS_JSON.

## 7. References

- Overview: §5 (queue consumer requests delegation), §8 (same pattern as sealer); refinement §4.4.
- Univocity: ADR-0005 (grantData = signer), plan-0027 (bootstrap).
- Key creation extension: [Subplan 04 assessment — key creation via delegation](subplan-04-assessment-key-creation-via-delegation.md).
