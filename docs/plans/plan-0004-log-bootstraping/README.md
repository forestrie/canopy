# Plan 0004: Log bootstrapping — overview and subplans

---

## Plan to update the plan (concise)

Design updates baked into overview and subplans.

**1. Grant model (from your input)**  
- **All grants require x402 payment** except the bootstrap grant. Use the existing x402 prototype, fully updated to a “pay for a grant” model.  
- **Only free grant**: bootstrap grant; it may only be signed by the bootstrap key holder (or a delegate of that key).  
- **Plan changes**: In overview and subplans 05/06, state that paid grants flow through x402 at register-grant (or grant resource) → settlement → grant creation. No free grant path at register-grant for non-bootstrap; bootstrap is a special case (contract not bootstrapped, single grant signed by bootstrap/delegate).

**2. Single post-settlement path — canopy creates grant and sequences**  
- **Paid grants**: client pays (x402) → settlement → **canopy** detects/completes settlement (existing or new API) → **canopy** creates the grant (delegation + sign), runs grant-sequencing (push to same DO as register-signed-statement), publishes grant. No arbor queue consumer for grant-issuance in the primary path.  
- **Plan change**: Overview and subplans 05/06: post-settlement grant creation and grant-sequencing are **canopy** responsibilities. Subplan 06 becomes "Canopy: settlement completion → grant creation and sequencing" (not "enqueue to arbor queue"). Subplan 05 (arbor queue consumer) is no longer the primary path; reduce to optional/legacy or remove.

**3. Where grant-sequencing lives — decided: canopy, same DO as register-signed-statement**  
- **Canopy already pushes directly to the DO** in the current register-signed-statement path: `register-signed-statement.ts` calls `queue.enqueue(logIdBytes, contentHash, enqueueExtras)` on the SequencingQueue DO (forestrie-ingress). Ranger pulls from that same DO. Canopy is already a direct user of the DO and owns the producer side of the schema.  
- **No architectural downside** to using that path for grant-sequencing: after settlement, canopy creates the grant, computes inner (subplan 01), and calls the same DO `enqueue(ownerLogId, inner, extras)` so ranger appends the grant leaf to the authority log. No new component in arbor.  
- **DO schema updates** to support canopy's role (e.g. return path for idtimestamp/mmrIndex via `resolveContent` or extension) are in scope. The DO already has `resolveContent(contentHash)`; extending it to return idtimestamp when available would support writing the grant document after sequencing.  
- **Plan change**: Subplan 03 and overview: grant-sequencing is **canopy** pushing to the same DO via the existing enqueue API.

**4. Return path (idtimestamp, mmrIndex)**  
- **Resolved in subplan 03 §7.1**: Current DO schema is sufficient — `resolveContent(inner)` returns leafIndex/massifIndex; idtimestamp can be read from R2 massif (same as query-registration-status). **Decided**: Optional DO extension where idtimestamps are an **optional** component of the batch ack; DO and ranger changes as below. Canopy **must not assume** idtimestamp is in the DO — it must have a **fallback path** that fetches idtimestamp from R2 when resolveContent does not return it.

**4a. Idtimestamp in batch ack — decided design**  
- **idtimestamps optional in batch ack**: The batch ack may include an **optional** array of idtimestamps (one per acked entry). When present, the DO stores them; when absent, the DO sets id_timestamp to null for the acked range.  
- **DO ack update — two paths**: (1) **Path 1 (formula)**: When the ack does **not** include idtimestamps, the DO uses the formula-based single UPDATE (CTE with ROW_NUMBER, leaf_index = firstLeafIndex + (r−1), massif_index = floor(leaf_index / leavesPerMassif)); set id_timestamp to null for those rows. (2) **Path 2 (array-bound)**: When the ack **does** include idtimestamps, the DO performs a single array-bound UPDATE (one `UPDATE ... FROM` joining to a derived table from the acked seq range and the idtimestamps array). Both paths are single-statement; no per-row loop required.  
- **Ranger exception to "no ranger changes"**: To support the optional idtimestamp path, **ranger** is allowed one **config-driven** change: when so configured (e.g. service config), ranger collects the idtimestamp for each entry in the batch it commits and includes them in the ack payload. When not configured, ranger sends ack without idtimestamps; DO uses path 1. This is the only exception to the "ranger unchanged" rule in this plan.  
- **Canopy must not assume idtimestamp in DO**: Canopy (grant-creation path, query-registration-status, and any other caller of resolveContent) **must not assume** that idtimestamp is present in the DO. resolveContent returns `{ leafIndex, massifIndex, idTimestamp?: bigint | null }`; when idTimestamp is missing or null, canopy **must** use the **fallback path**: fetch idtimestamp from the massif in R2 (e.g. `readIdtimestampFromMassif`) using leafIndex and massifIndex. So behaviour is correct whether or not ranger is configured to send idtimestamps.  
- **(Rationale)** Storing idtimestamp in the DO is a convenience (one resolveContent call, no R2 in hot path when present); the massif remains the canonical source. Without idtimestamps in ack, DO uses formula-only single UPDATE; with idtimestamps, array-bound single UPDATE — both one statement (see subplan 03 §7.1).  

**4b. Benefits to other APIs and the general system**  
- **query-registration-status (canopy-api)**: Today this is the only production caller of `resolveContent`. It does one DO call then an R2 byte-range read via `readIdtimestampFromMassif` to build entryId and redirect to the permanent receipt URL. If the DO returned idtimestamp, this API could serve the redirect with a single DO call and no R2 in the hot path — direct latency and dependency benefit for the existing SCRAPI statement flow.  
- **Grant-creation path**: As in §4/4a — one resolveContent call to write the grant document with idtimestamp.  
- **resolve-receipt**: Does not use the DO; it receives entryId (idtimestamp || mmrIndex) in the URL. No change.  
- **Debug / observability**: The forestrie-ingress debug handler (`recentEntries`) currently returns leafIndex/massifIndex from the DO. With idtimestamp stored, we could optionally expose it there (e.g. full entryId for debugging) without touching R2. Minor.  
- **General system**: Any future API or service that needs "contentHash → full sequencing result (including idtimestamp)" benefits from a single DO round-trip and no R2 dependency — e.g. lighter workers, or products that use the same DO but do not have R2 access. One consistent place for the full result when we have it.

**5. Inner = ContentHash**  
- **Confirmation only**. In go-univocity and subplan 01/03, explicitly state that the “inner” hash (univocity leaf commitment, pre-idtimestamp) is the value used as **ContentHash** in the entry fed to ranger, so that ranger’s H(idTimestampBE || ContentHash) equals the contract leaf. No behaviour change; plan and spec wording only.

**6. Subplan 05 vs 03 build order**  
- Keep 05 depending on 03. If grant-sequencing is “queue consumer pushes to DO”, then 03 can be implemented as part of 05 (same codebase) or as a shared library; document the chosen location in subplan 03 so build order is unambiguous.

**7. Idempotency**  
- **Decided (a)**: Grant-sequencing dedupes by inner (grant hash) before pushing: check resolveContent(inner) before enqueue; if already sequenced, use existing result. See subplan 03 §7.2 and §8.

---

**Decisions (all resolved)**

- Post-settlement grant creation and grant-sequencing live in **canopy**; canopy pushes to the same DO as register-signed-statement. No arbor queue consumer in the primary path. Return path: subplan 03 §7.1 (optional idtimestamps in batch ack; DO two-path update; ranger exception; canopy R2 fallback).
- Idempotency: (a) grant-sequencing dedupes by inner before pushing (subplan 03 §7.2, §8).  

---

**Recommended next steps (build order)**

1. **Subplan 01** — **Complete.** go-univocity at `arbor/services/_deps/go-univocity`: spec (ContentHash = inner hash in §1), InnerHash/InnerHashFromGrant, leaf_vectors.json with expected_inner_hex, canopy codec aligned. Subplan 03 step 8.1 can use go-univocity or spec and fixtures for inner.
2. **Subplans 02, 03, 04** — In parallel: REST auth log status (02), grant-sequencing in canopy (03; follow subplan 03 §8; compute inner via InnerHashFromGrant or spec/fixtures), signer delegation (04).
3. **Canopy return-path hardening** — Optional early step: query-registration-status (and any resolveContent callers) treat idTimestamp as optional and use R2 fallback when missing.
4. **Subplan 06** — Canopy settlement → grant creation and sequencing (after 01 remaining items, 02, 03, 04).
5. **DO and ranger (optional idtimestamps)** — When desired: forestrie-ingress DO two-path ack, resolveContent returning idTimestamp; ranger config for idtimestamps in ack. Subplan 05 (queue consumer) only if needed.

---

This directory contains the **overview** and **agent-optimised subplans** for authority log bootstrap and grant issuance (Plan 0004).

- **[overview.md](overview.md)** — Key outcomes, deliverables, summary of each subplan, build order, and refinement questions for agentic implementation.

**Subplans** (independently buildable; each has scope, dependencies, inputs/outputs, verification, references):

| # | Subplan |
|---|---------|
| 01 | [Shared encoding and univocity alignment](subplan-01-shared-encoding-univocity-alignment.md) |
| 02 | [REST auth log status and log type service](subplan-02-rest-auth-log-status.md) |
| 03 | [Grant-sequencing component](subplan-03-grant-sequencing-component.md) *(canopy, same DO; ranger: optional idtimestamps in ack per config)* |
| 04 | [Signer: delegation for bootstrap and parent log](subplan-04-signer-delegation-bootstrap-and-parent.md) |
| 05 | [Queue consumer: grant-issuance (optional)](subplan-05-queue-consumer-grant-issuance.md) |
| 06 | [Canopy: settlement → grant creation and sequencing](subplan-06-canopy-settlement-to-issue-grant-queue.md) |
| 07 | [Sealer: key resolution per log](subplan-07-sealer-key-resolution-per-log.md) |
