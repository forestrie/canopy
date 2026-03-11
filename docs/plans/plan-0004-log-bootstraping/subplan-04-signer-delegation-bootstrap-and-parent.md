# Subplan 04: Signer — delegation for bootstrap and parent log

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- Extend the **signer service** (GCP HSM delegation pattern) to support:
  - **Delegation for a local key** (used for root bootstrap): the key that will act as the root signer and that matches the configured bootstrap public key.
  - **Delegation for the parent log** (used for derived logs): given a parent logId (or owner), return a delegation that can sign grants for creating a child authority or data log under that parent.
- The **queue consumer** (subplan 05) will request these delegations to **sign grants**; it must not hold any private key material.

**Out of scope**: Queue consumer logic; ranger; chain submission; sealer key resolution (subplan 07).

## 2. Dependencies

- None for building the signer extension. Required by subplan 05 (queue consumer requests delegation to sign grant).
- Optional: auth log status service (subplan 02) if signer needs to resolve “parent log” key via that service; otherwise signer may have its own mapping.

## 3. Inputs

- Existing signer API: how delegation is requested today (overview refinement §4.4).
- Bootstrap public key (or id) configuration: how the operator configures the key that the contract expects for root.
- For “delegation for parent log”: how parent is identified (logId) and how signer resolves the parent’s key (internal state vs call to REST log-type service).

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

## 6. References

- Overview: §5 (queue consumer requests delegation), §8 (same pattern as sealer); refinement §4.4.
- Univocity: ADR-0005 (grantData = signer), plan-0027 (bootstrap).
