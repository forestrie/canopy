# Subplan 03: Evaluation — async register-grant and unified query-status

**Status**: DRAFT  
**Date**: 2026-03-12  
**Parent**: [Plan 0004 overview](overview.md), [Subplan 03](subplan-03-grant-sequencing-component.md)

## 1. Requested change

- **No blocking/polling in register-grant.** Align with register-signed-statement: register-grant returns **immediately** with an opaque operation id and a status URL; the client (or settlement callback) uses **query-grant-status** to poll until sequencing is complete.
- **Same pattern as register-signed-statement.** Operation context = opaque id; status endpoint resolves that id to “pending” (303 self + Retry-After) or “complete” (303 to permanent location).
- **Ideal: grant as signed statement.** Treat the grant so that **query-grant-status** can be the **same** endpoint as query-registration-status (or fully reuse it), i.e. one status endpoint that accepts the opaque id and returns status / redirect regardless of whether the entry was a statement or a grant.

## 2. Current behaviour (register-signed-statement and query-registration-status)

- **Register-signed-statement**: Validates grant, parses COSE Sign1, computes `contentHash = SHA256(statementBytes)`, enqueues `enqueue(logIdBytes, contentHashBytes)` to the SequencingQueue DO (sharded by logId). Returns **303 See Other** immediately with `Location: {origin}/logs/{logId}/entries/{contentHash}` and `Retry-After: 5`. No server-side polling.
- **Query-registration-status**: `GET /logs/{logId}/entries/{contentHash}`. Uses (logId, contentHash) from the path to get the DO stub for that log’s shard and calls `resolveContent(contentHash)`. If null → 303 to same URL with Retry-After 1 (still processing). If result → reads idtimestamp from R2 massif (byte-range), builds entryId, 303 to permanent receipt: `/logs/{logId}/{massifHeight}/entries/{entryId}/receipt`.

So the **opaque id** for statements is effectively **(logId, contentHash)**; the polling URL is `GET /logs/{logId}/entries/{contentHash}`.

## 3. Feasibility: same flow for grants

**Same DO, same keying.** Grant-sequencing enqueues `enqueue(ownerLogId, inner, extras)`. The DO is keyed by (logId, contentHash); ranger and the DO do not distinguish “statement” vs “grant”. So for a grant we have:

- **logId** in the status URL = **ownerLogId** (authority log we extend).
- **contentHash** in the status URL = **inner** (32-byte hex), the same value used as ContentHash for the leaf.

So the **polling URL** for a grant can be exactly the same shape: `GET /logs/{ownerLogId}/entries/{innerHex}`.

**Conclusion: reusing query-registration-status for grants is feasible.**

- Register-grant (or post-settlement): compute inner, (optional) dedupe via resolveContent(inner), enqueue(ownerLogId, inner), return **303** to `Location: /logs/{ownerLogId}/entries/{innerHex}`. No server-side poll.
- Client (or settlement callback) polls `GET /logs/{ownerLogId}/entries/{innerHex}`. That is the **same** handler as query-registration-status: it takes (logId, contentHash) from the path, calls resolveContent(contentHash) on the DO for that log’s shard, and either 303 self + Retry-After or 303 to receipt.
- When complete, the redirect is to the **authority log entry receipt**: `/logs/{ownerLogId}/{massifHeight}/entries/{entryId}/receipt`. So the “grant receipt” **is** the receipt for that leaf in the authority log. No change to the status endpoint logic is required for this path; the only requirement is that the **logId** in the path is the one used for the DO shard (ownerLogId for grants).

So we can **fully reuse** the existing query-registration-status endpoint as “query-grant-status”: same URL shape, same handler, same receipt semantics. From the DO’s perspective a grant is just another entry with the same (logId, contentHash) format.

## 4. “Grant as signed statement” — what it means

- **At DO/ranger level:** The entry is already the same: (logId, contentHash) → leaf with leafHash = H(idTimestampBE || ContentHash). For statements contentHash = SHA256(statementBytes); for grants contentHash = inner. So the **entry type** is the same; we do not need a separate “grant” type in the queue or in the receipt.
- **At API level:** The same status URL and the same receipt URL can serve both. So “query-grant-status” **is** query-registration-status: one endpoint, one behaviour, one receipt shape. The only difference is **which log** (data log vs authority log) and **which contentHash** (statement hash vs inner).

So the requested “identical approach” and “grant as signed statement” that “could completely re-use the query-grant-status endpoint as is” is **feasible**: we use the same endpoint (query-registration-status) for both; no second “query-grant-status” implementation needed.

## 5. Implications

### 5.1 Register-grant and settlement (no blocking)

- **Register-grant** (and post-settlement grant creation in subplan 06): After creating and signing the grant, compute inner, optionally resolveContent(inner) for dedupe (if non-null, skip enqueue and still return 303 to the same status URL so the client can poll and get the existing result). Enqueue(ownerLogId, inner). Return **303** to `Location: /logs/{ownerLogId}/entries/{innerHex}` with Retry-After. **Remove** all server-side “poll until sequenced” and “then write grant doc and return grant location” from the synchronous path.
- **Subplan 03** implementation plan: Steps 8.4 (poll until sequenced) and 8.5–8.6 (return path: idtimestamp, write grant and publish) move **out** of the register-grant/settlement hot path. They happen instead when the client (or something) uses the status/receipt or grant-document flow below.

### 5.2 Grant document (X-Grant-Location) and when it gets idtimestamp/mmrIndex

- **Register-statement** requires the **grant document** (from R2, decoded as Grant with signer, etc.) for auth. So the client must have a URL that eventually returns the full grant, including idtimestamp and mmrIndex when sequencing is complete.
- **Options:**
  - **A — Lazy completion on GET grant:** Register-grant writes the grant to R2 at a stable path (e.g. by inner hex) **without** idtimestamp/mmrIndex (or with placeholders). The “grant location” given to the client is that path (e.g. `/grants/authority/{innerHex}` or the R2 path under GRANT_STORAGE_PUBLIC_BASE). When the client (or register-statement) **GET**s that URL, the handler: resolveContent(inner); if null → 202 Accepted and Retry-After (or 303 to status URL); if result → read idtimestamp (from result or R2 massif fallback), mmrIndex, merge into grant, return 200 with full grant CBOR. So the grant document is “completed” on first GET after sequencing. No KV needed; path is derived from inner.
  - **B — Complete grant when status is first polled:** When GET /logs/{ownerLogId}/entries/{innerHex} returns a result, before redirecting to the receipt, the handler checks if this contentHash is a “grant” (e.g. via extras or a side table). If so, write/update the grant document in R2 with idtimestamp/mmrIndex, then redirect. That requires a way to know “this contentHash is a grant” and where to write the grant (e.g. KV: innerHex → grant path). More state.
  - **C — Receipt as grant location:** Use the receipt URL as the “grant location” for register-statement. That would require register-statement to accept a **receipt** URL and, when fetching, parse the receipt to get entryId and then somehow obtain the grant (signer, etc.). The receipt today is not the grant document; the grant document is a separate CBOR object. So we’d need either the receipt to embed or link to the grant, or register-statement to support two URLs (receipt + grant). That complicates the current grant-auth contract (single X-Grant-Location that returns the grant). So **A** or **B** is simpler.

**Recommendation:** Option **A** (lazy completion on GET grant). Register-grant writes the grant to R2 at a path derivable from inner (e.g. `authority/{innerHex}.cbor`). Return 303 to status URL; optionally in the 303 response or in a separate header/body, indicate the grant document URL (e.g. same path under GRANT_STORAGE_PUBLIC_BASE). When that URL is GET’d, complete the grant with resolveContent + idtimestamp/mmrIndex (and R2 fallback) and return the full grant. No new KV or DO changes.

### 5.3 Subplan 03 scope and implementation plan

- **In scope:** Grant-sequencing component **only** enqueues (and optionally dedupes). It does **not** poll, does not write the grant document, and does not run in the return path. The “return path” (idtimestamp, mmrIndex, grant document completion) lives in (1) the **existing** query-registration-status handler (which already does resolveContent + idtimestamp from massif + redirect to receipt), and (2) a **grant-document GET** handler that completes the grant when sequenced (option A above).
- **Implementation steps** (revised):
  - 8.1 Compute inner (unchanged).
  - 8.2 Dedupe: resolveContent(inner); if non-null, do **not** enqueue; still return 303 to status URL (client will get result when they poll).
  - 8.3 Enqueue(ownerLogId, inner) (unchanged).
  - **Remove 8.4** (server-side poll).
  - **8.5 / 8.6** become: (a) query-registration-status (existing) handles GET /logs/{ownerLogId}/entries/{innerHex} and when complete redirects to receipt; (b) grant-document GET handler (new or extended) for the grant URL that completes the grant with resolveContent + idtimestamp/mmrIndex and returns full grant when sequenced.
  - 8.7 Wire: register-grant (and settlement) returns 303 to status URL; client uses same status endpoint as statements; grant document URL is provided so client can use it for X-Grant-Location once ready (GET grant completes lazily).

### 5.4 Subplan 06 (canopy settlement) and optional subplan 05

- **Subplan 06:** After settlement, canopy creates the grant (delegation + sign), computes inner, writes grant to R2 at path-by-inner (without idtimestamp/mmrIndex), enqueues(ownerLogId, inner), returns **303** to status URL (and grant document URL). No polling in the worker. Client or callback polls status; when complete, receipt is available and GET grant returns the completed grant.
- **Subplan 05** (optional queue consumer): Same idea; if it enqueues to the DO, it returns a status URL and does not block on polling.

### 5.5 DO and ranger

- No change to DO schema or ranger behaviour. resolveContent(inner) and the existing receipt flow already support any (logId, contentHash). Optional idtimestamps in ack (subplan 03 §7.1) and R2 fallback for idtimestamp still apply; query-registration-status already uses readIdtimestampFromMassif when needed.

## 6. Summary

| Aspect | Current (subplan 03) | After change |
|--------|----------------------|-------------|
| Register-grant / settlement | Block: enqueue then poll until result, then write grant and return location | Non-block: enqueue, return 303 to status URL (and grant doc URL) |
| Status | (Implicit: client waits or callback polls “grant location”) | Explicit: same as statements — GET /logs/{ownerLogId}/entries/{innerHex} (query-registration-status) |
| Query-grant-status | Separate or implied | **Same** as query-registration-status; no separate endpoint |
| Receipt | Grant “location” was grant doc URL after server-side completion | Receipt = authority log entry receipt; grant doc URL completes lazily on GET (option A) |
| Grant document | Written in return path after poll (steps 8.5–8.6) | Written at register time (incomplete); completed on first GET when sequenced (lazy) or when status is polled (option B) |

**Feasibility:** Yes. The change is consistent with the existing statement flow and reuses the same status endpoint and receipt shape. The main implementation work is: (1) remove server-side polling from grant-sequencing and make register-grant/settlement return 303 to the status URL; (2) add or extend a grant-document GET handler that completes the grant using resolveContent + idtimestamp/mmrIndex when the client fetches the grant URL.

**Recommendation:** Refine subplan 03 (and 06, 05) to adopt this async, status-URL-based flow and to document the unified status endpoint and the lazy grant-document completion (option A) as the return path for the grant document.

---

## 7. Impact on Univocity contracts and go-univocity

**No impact.** The change is limited to **when** and **how** we respond to the client (immediate 303 vs poll-then-return) and **where** we complete the grant document (lazy GET vs server-side after poll). It does **not** change:

- **What we present to the Univocity smart contracts.** The contracts only see checkpoints (signed MMR roots) and the leaves in the tree. Leaves are produced by ranger from (idtimestamp, ContentHash). For grants, ContentHash = **inner** (sha256(inner preimage)) and is assigned by ranger. That formula and the resulting leaf are unchanged. The contracts do not see register-grant, query-status, or any HTTP flow.
- **Hashing and grant definitions in go-univocity.** We still compute **inner** = InnerHash / InnerHashFromGrant (sha256(inner preimage)); we still enqueue (ownerLogId, inner); ranger still computes leafHash = H(idTimestampBE || ContentHash). The grant format (PublishGrant, CBOR keys 0–8, fixed-length logId/ownerLogId/grantFlags), the inner preimage layout, and the leaf commitment formula in `docs/grant-and-leaf-format.md` and in go-univocity remain the same. No changes to go-univocity or to the spec are required for this refinement.
