# Subplan 03: Grant-sequencing component (authority log leaf)

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

## 1. Scope

A **component that completes the work started by register-grant**. Register-grant (canopy) is responsible for initial validation. This component takes the validated grant (or handoff from register-grant), ensures the grant’s leaf is appended to the correct authority log MMR, and allows the client to treat the grant as sequenced (idtimestamp, mmrIndex available).

**Ranger is otherwise unchanged.** One **exception** (see §7.1): ranger may be configured to include idtimestamps in the batch ack; when so configured, it collects the idtimestamp for each entry in the batch it commits and sends them in the ack. This is the only ranger change in this plan.

**Why ranger does not need other changes.** Ranger already accepts **opaque values** (entries with ContentHash) and appends them to **whatever log it is asked to extend** (logId). It does not interpret the content; it generates idtimestamp and computes leafHash = H(idTimestampBE || ContentHash). It can do exactly the same for grants: we only need to feed it entries with logId = ownerLogId (the authority log) and ContentHash = inner (the pre-idtimestamp part of the univocity leaf commitment, per subplan 01). Then ranger’s existing behaviour produces the correct univocity leaf. No new message types, queues, or logic in ranger—only a **producer** that creates entries in the existing format and injects them into the pipeline ranger already consumes.

**Flow**: Register-grant (or canopy post-settlement) validates → **canopy** completes (produces entry in the format ranger already consumes; pushes to the **same DO** as register-signed-statement, forestrie-ingress SequencingQueue) → ranger extends the log as it does today (unchanged).

**Invariant (unchanged)**: Ranger remains the sole source of idtimestamp. 1:1 idtimestamp ↔ mmrIndex per log; same numerical sort; padded-hex idtimestamp lexical sort matches mmrIndex sort. This design is not changed by grants.

**Out of scope**: Any other ranger code or config changes; signing; chain submission; grant validation (that stays with register-grant). The only ranger change in scope is the optional, config-driven inclusion of idtimestamps in the ack (see §7.1).

## 2. Dependencies

- **Subplan 01**: Leaf commitment formula. This component must produce an entry such that when ranger applies its existing rule (leafHash = H(idTimestampBE || ContentHash)), the result is the univocity leaf commitment. So this component supplies the correct ContentHash (the “inner” part of the commitment, per subplan 01) and the correct logId (ownerLogId); ranger adds idtimestamp and appends.

## 3. Inputs

- Handoff from register-grant: validated grant (or reference) and ownerLogId (authority log to extend).
- Ranger’s existing entry format: Entry has ContentHash (and optional extras). Ranger computes leafHash = H(idTimestampBE || ContentHash) and appends. So this component must produce ContentHash = inner (subplan 01) so that ranger’s output equals the univocity leaf commitment.
- **Injection**: Same DO as register-signed-statement (forestrie-ingress SequencingQueue). Canopy already calls `queue.enqueue(logIdBytes, contentHash, extras)` there; grant-sequencing calls `enqueue(ownerLogId, inner, extras)`. Ranger pulls from that DO unchanged.

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Component** | **Canopy** (same codebase as register-signed-statement). Receives handoff from register-grant or post-settlement grant creation and completes sequencing. |
| **Produce ranger entry** | From validated grant, compute inner (subplan 01); produce entry with logId = ownerLogId, ContentHash = inner, in the exact format ranger’s existing consumer expects. |
| **Inject into ranger pipeline** | Push to the **same DO** as register-signed-statement via existing `enqueue(ownerLogId, inner, extras)` (forestrie-ingress SequencingQueue). Ranger unchanged. |
| **Result to client** | After ranger has sequenced the entry, the grant record must be updated or exposed so the client has (idtimestamp, mmrIndex). Canopy (or whoever completes the return path) obtains result via resolveContent; when idTimestamp is missing or null, **must** use R2 fallback (e.g. readIdtimestampFromMassif). Poll resolveContent(inner) until sequenced; then return path (see §8). |
| **Idempotency** | Component-level dedupe by inner (grant hash): check resolveContent(inner) before enqueue; if already sequenced, use existing result. See §7.2. |

## 5. Verification

- Register-grant validates a grant; handoff to this component; component produces entry and injects; ranger (unchanged) extends the authority log; grant becomes usable (idtimestamp, mmrIndex) for inclusion proof.
- No changes to ranger code or config.

## 6. What breaks vs previous plan (subplan 03)

- **Previous subplan 03** (“Ranger: authority log leaf append”) assumed ranger would accept new “append leaf” messages or a new queue. That is **withdrawn**. Ranger is excluded from changes.
- **Overview and other subplans** that said “ranger accepts append leaf” or “send leaf to ranger queue” must be read as: something (this new component) produces entries in the **existing** format and feeds the **existing** ranger pipeline; ranger itself does not change.

## 7. Remaining functional gaps

- **Location**: **Decided: canopy.** Same codebase as register-signed-statement; canopy already pushes to the DO.
- **Handoff**: Register-grant (sync/async) or canopy post-settlement grant creation triggers this; no arbor queue in primary path.
- **Injection**: **Decided: same DO.** Canopy calls existing SequencingQueue `enqueue(ownerLogId, inner, extras)` (forestrie-ingress). Ranger pulls from that DO.
- **Return path**: See §7.1 below (current schema sufficient; optional DO extension for idtimestamp).
- **Idempotency**: **Decided (a)**. Component-level dedupe by inner (grant hash): see §7.2.
- **Subplan 05 / 06**: Primary path is **canopy** (subplan 06): canopy creates the grant after settlement and runs grant-sequencing (push to same DO). Subplan 05 (arbor queue consumer) is optional/legacy.

### 7.1 DO schema: optional idtimestamps in ack; two-path ack update; canopy fallback

**Decided design.** The batch ack may include an **optional** array of idtimestamps (one per acked entry). The DO and ranger changes below are in scope; canopy **must not assume** idtimestamp is in the DO and **must** use an R2 fallback when it is not.

**DO schema and ack.**

- `enqueue(logId, contentHash, extras)` → `{ seq }` — unchanged; canopy uses this for grant-sequencing (contentHash = inner).
- **Ack request**: Existing fields (logId, seqLo, limit, firstLeafIndex, massifHeight) plus **optional** `idTimestamps?: bigint[]` (length = limit when present). When present, the DO stores id_timestamp per entry; when absent, the DO sets id_timestamp to null for the acked range.
- **Ack update — two paths**: (1) **Path 1 (formula)**: When the ack does **not** include idtimestamps, the DO uses a single formula-based UPDATE: CTE with ROW_NUMBER, leaf_index = firstLeafIndex + (r−1), massif_index = floor(leaf_index / leavesPerMassif); set id_timestamp to null for those rows. (2) **Path 2 (array-bound)**: When the ack **does** include idtimestamps, the DO performs a single array-bound UPDATE: one `UPDATE ... FROM` joining the queue table to a derived table built from the acked seq range and the idtimestamps array (e.g. unnest(seqs, idtimestamps) or VALUES with N bindings). Both paths are single-statement; no per-row loop.
- **resolveContent**: Return `{ leafIndex, massifIndex, idTimestamp?: bigint | null } | null`. When the entry has been sequenced and id_timestamp was stored (path 2), return it; otherwise idTimestamp is omitted or null. Backward-compatible: existing callers that ignore idTimestamp are unchanged.

**Ranger exception (only change to ranger in this plan).** When configured via service configuration (e.g. "include idtimestamps in ack"), ranger collects the idtimestamp for each entry in the batch it commits and includes them in the ack payload. When not configured, ranger sends the ack without idtimestamps; the DO uses path 1. No other ranger behaviour changes.

**Canopy must not assume idtimestamp in DO.** Every caller of resolveContent that needs idtimestamp (grant-creation path, query-registration-status, etc.) **must** implement a **fallback path**: when resolveContent returns idTimestamp as missing or null, fetch idtimestamp from the massif in R2 using leafIndex and massifIndex (e.g. `readIdtimestampFromMassif` in canopy-api). Behaviour is correct whether or not ranger is configured to send idtimestamps; the DO is an optimisation, not a requirement for correctness.

**Performance.** With idtimestamps in ack: payload 512 × 8 bytes = 4 KB per request (plus CBOR framing). Negligible. DO uses one statement per path (formula or array-bound). See plan README §4a for rationale.


**Cryptographic verifiability of idtimestamp ↔ mmrIndex for a log.** Yes. The binding is verifiable against the log’s own data, independent of the DO. Canonical source of truth is the massif blob (R2): ranger writes each leaf as a record whose first 8 bytes are idtimestamp and whose commitment is leafHash = H(idTimestampBE || ContentHash). The signed checkpoint commits to the MMR root for that log. So for a given logId, leafIndex (or mmrIndex), and claimed idtimestamp: (1) fetch the leaf at that index from the massif for that log, (2) read the stored idtimestamp and ContentHash, (3) recompute leafHash = H(idTimestampBE || ContentHash) and verify it matches the leaf hash in the MMR at that index, (4) verify the MMR root against the signed checkpoint. If the DO (or anything else) returns a wrong idtimestamp, step (2)–(3) will fail when checked against the massif and the tree. The DO is only a cache; verification does not rely on it, so even a corrupted DO can be detected cryptographically.

### 7.2 Deduplication by inner (grant hash)

**Principle.** The value we enqueue as ContentHash is **inner** — the pre-idtimestamp part of the univocity leaf commitment (subplan 01). For a given grant content, inner is **deterministic**. To avoid double-append when the same grant is handed off twice (e.g. retry after timeout, duplicate settlement callback, or duplicate register-grant call), we dedupe at **component level** using inner as the key: **do not enqueue if this inner is already sequenced**.

**Mechanism.**

1. **Before enqueue**: Call `resolveContent(inner)` (DO RPC).  
   - If the result is **non-null**, the entry is already sequenced (ranger has acked it). Use that result for the return path (leafIndex, massifIndex, idTimestamp or R2 fallback). **Do not call enqueue.** Return success to the caller with the existing sequencing result.  
   - If the result is **null**, the entry is not yet sequenced (and may or may not be in the queue). Proceed to step 2.

2. **Enqueue once**: Call `enqueue(ownerLogId, inner, extras)`. The DO may allow multiple rows with the same content_hash for the same logId (e.g. duplicate enqueue from retries). We avoid that by only enqueueing when resolveContent was null. After a successful enqueue, poll resolveContent(inner) until non-null (see implementation plan §8 step 4).

3. **Retries**: If the component crashes after enqueue but before writing the grant document, a retry will call resolveContent(inner) again. By then ranger may have acked the entry, so resolveContent returns non-null and we use that result without enqueueing again. If ranger has not yet acked, resolveContent is still null; we would enqueue again and get a second row with the same content_hash. Whether the DO dedupes by (logId, content_hash) is implementation-defined; the **canonical** dedupe is "only enqueue when resolveContent(inner) is null." If the DO stores duplicates, resolveContent(contentHash) should return the first (or deterministic) match so the return path still sees one result. To avoid duplicate rows entirely, an optional in-memory guard per process (e.g. "we have already enqueued this inner in the last N seconds") can suppress a second enqueue on fast retry before the first ack; the spec does not require it.

**Summary.** Dedupe key = **inner** (32-byte ContentHash). Check **resolveContent(inner)** before every enqueue; if non-null, use existing result and skip enqueue. This gives at-most-one logical append per distinct grant content; idempotent retries.

## 8. Implementation plan (agent-optimised)

Ordered steps; each step has input, output, location hint, and verification. Dependencies: subplan 01 (inner computation and fixtures).

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **8.1** | Compute inner from grant | Validated grant (logId, ownerLogId, kind, grant fields per subplan 01) | inner (32 bytes, ContentHash) | Canopy-api: grant-sequencing module. Use same formula as go-univocity / subplan 01 (pre-idtimestamp leaf commitment). | Unit test: grant fixture → inner matches go-univocity test vector. |
| **8.2** | Dedupe check | inner, DO stub | decision: already sequenced | resolveContent(inner). If non-null → already sequenced; go to 8.5. If null → go to 8.3. | Unit test: mock stub returns null then non-null; enqueue called only when null. |
| **8.3** | Enqueue entry | ownerLogId (from grant), inner, extras (optional) | seq (from DO) | Same DO as register-signed-statement: `enqueue(ownerLogId, inner, extras)` via SequencingQueue stub (forestrie-ingress). | Integration test: enqueue then pull/ack in test DO; entry appears. |
| **8.4** | Poll until sequenced | inner, DO stub, backoff config | result = { leafIndex, massifIndex, idTimestamp? } | Poll resolveContent(inner) with backoff (e.g. exponential, max attempts or timeout). Exit when non-null. | Unit test: stub transitions null → result after N calls. |
| **8.5** | Return path: idtimestamp | result (leafIndex, massifIndex, idTimestamp?), logId, massifHeight, R2 binding | idtimestamp (bigint), mmrIndex (bigint) | If result.idTimestamp present and non-null, use it. Else call readIdtimestampFromMassif(r2, logId, massifHeight, result.massifIndex, result.leafIndex). mmrIndex = mmrIndexFromLeafIndex(result.leafIndex). Reuse readIdtimestampFromMassif from query-registration-status (canopy-api). | Unit test: resolveContent with idTimestamp → no R2 call; without idTimestamp → R2 fallback called. |
| **8.6** | Write grant and publish | Grant document (with idtimestamp, mmrIndex), storage path | Grant at content-addressable path | Update grant payload with idtimestamp and mmrIndex; write to R2 (or configured storage) at path from register-grant / content-addressable convention. | Grant doc contains correct idtimestamp and mmrIndex; readable at returned location. |
| **8.7** | Wire into callers | — | — | **Register-grant path**: after validation, invoke grant-sequencing (sync or async; if async, client polls for grant location). **Settlement path (subplan 06)**: after creating grant (delegation + sign), invoke grant-sequencing then publish. Single function or pipeline: steps 8.1 → 8.2 → [8.3 → 8.4] or skip to 8.5 → 8.6. | E2E or flow test: register-grant or settlement → grant sequenced → client can resolve grant with (idtimestamp, mmrIndex). |

**Data flow (concise).** Grant → inner (8.1) → resolveContent(inner) (8.2): if non-null → (8.5 → 8.6); if null → enqueue (8.3) → poll (8.4) → (8.5 → 8.6). Step 8.5 always uses R2 fallback when idTimestamp missing or null.

**Files to add or touch (canopy).** New or extended module for grant-sequencing (e.g. under `packages/apps/canopy-api/src/` or next to register-signed-statement); call into existing SequencingQueue stub and existing readIdtimestampFromMassif / mmrIndexFromLeafIndex (query-registration-status, entry-id or equivalent). Register-grant handler and settlement handler (subplan 06) call this module after validation / grant creation.

## 9. Refinement: async status (no blocking in register-grant) — implemented

Aligning register-grant with register-signed-statement is **implemented**: **no server-side blocking or polling**; register-grant returns **303** to a status URL (`/logs/{ownerLogId}/entries/{innerHex}`); the client uses the **same** endpoint as query-registration-status to poll until complete; grant document is completed lazily on GET `/grants/authority/{innerHex}`. See [subplan-03-evaluation-async-status-and-unified-receipt.md](subplan-03-evaluation-async-status-and-unified-receipt.md) for the design. Implementation: canopy-api grant inner hash (`grant/inner-hash.ts`), grant-sequencing module (dedupe + enqueue), register-grant returns 303 with X-Grant-Location, GET `/grants/authority/:innerHex` completes grant (serve-grant), register-statement uses getCompletedGrant for `/grants/` paths.

## 10. References

- Overview: §5 (leaf to ranger pipeline), §6 (ranger performs append); refinement §4.3.
- Subplan 01: leaf commitment; this component produces ContentHash = inner so ranger’s H(idTimestamp || ContentHash) equals univocity leaf.
- Ranger: consumes existing entry format (e.g. DO pull); one exception per §7.1 (optional idtimestamps in ack when configured).
