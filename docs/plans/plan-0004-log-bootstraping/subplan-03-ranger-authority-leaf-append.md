# Subplan 03: Ranger — authority log leaf append

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

- **Ranger** (or the component that maintains the authority log MMR) accepts **“append leaf”** messages (e.g. from a queue).
- For each message: append the leaf to the **owner authority log’s MMR** and persist in the same format as arbor massifs/checkpoints (R2).
- **Idempotency**: same leaf (by commitment hash) must not be appended twice; no-op or return existing index.

**Out of scope**: Creating the grant or leaf (done by queue consumer); signing; chain submission.

## 2. Dependencies

- **Subplan 01**: Leaf format and commitment semantics (so ranger knows how to identify “same leaf” and how the leaf fits the MMR).

## 3. Inputs

- Message format for “append leaf” (overview refinement §4.3): at least ownerLogId (or authority log id), leaf bytes or leaf commitment, and optionally idempotency key.
- R2 bucket/prefix and path layout for authority log MMR (aligned with existing arbor layout).
- Queue name/binding from which ranger consumes (if separate from existing ranger queue).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Consume “append leaf”** | Ranger (or dedicated consumer) reads messages from the agreed queue; parses ownerLogId and leaf. |
| **MMR append** | Append leaf to the correct authority log’s MMR; update size and accumulator. |
| **Persist to R2** | Write massifs/checkpoints to R2 in the same format arbor uses so chain and sealer stay consistent. |
| **Idempotency** | Detect duplicate leaf (e.g. by leaf commitment hash); no duplicate append; return or use existing index where applicable. |

## 5. Verification

- Unit or integration test: send two identical “append leaf” messages; second is no-op (idempotent).
- Append for owner A and owner B updates separate MMRs (or correct sharding).
- Queue consumer (subplan 05) can send a leaf to this queue and ranger appends it; grant becomes usable for inclusion proof.

## 6. References

- Overview: §5 (leaf to ranger queue), §6 (ranger performs append); refinement §4.3.
- Subplan 01: leaf commitment and format.
