# Plan 0006: Idtimestamp as separate parameter (align with Univocity)

- **Status**: ACCEPTED
- **Date**: 2025-03-14
- **Implementation**: Completed 2025-03-14 (codec, encoding, register-grant storage, serve-grant read, tests).
- **Related**: [Plan 0005](plan-0005-grant-receipt-unified-resolve.md), [ARC-0001](../arc-0001-grant-verification.md)

## 1. Problem and agreement

Univocity contracts treat **idtimestamp** as a **separate parameter** from the grant:

- `PublishGrant` has no idtimestamp field.
- `_leafCommitment(bytes8 grantIDTimestampBe, PublishGrant calldata g)` takes idtimestamp and grant as distinct arguments.
- Leaf = H(idTimestampBE || inner); inner = hash of grant content only.

Canopy’s codec currently **encodes idtimestamp inside** the grant CBOR map (key 0) for:

- Full grant wire format (keys 0–8) in `encodeGrant` / `decodeGrant`.
- Stored grant documents (R2) and POST body (encoding package `encodeGrantRequest` keys 0–8).

So we have a structural mismatch: the contract’s “grant” is keys 1–8 (publish-grant fields only); idtimestamp is only used at the leaf-commitment boundary. Encoding idtimestamp as key 0 in the same map is inconsistent and forces every path that touches “grant bytes” to carry idtimestamp even when it’s not needed.

**Agreement:** Treat **grant content** (fields that map to PublishGrant / keys 1–8) as the single canonical encoded form. **Idtimestamp** is a separate, context-dependent value (8-byte big-endian `Uint8Array` or hex string) and is only supplied in call paths that need it (receipt verification, leaf commitment, completed-grant response).

## 2. Encoding conventions

- **Grant content (canonical):** CBOR map with integer keys **1–8 only** (logId, ownerLogId, grantFlags, maxHeight, minGrowth, grantData, signer, kind). No key 0. Same as current `encodeGrantPayload` / `decodeGrantPayload` payload shape.
- **Idtimestamp when required:**
  - In TypeScript/Worker: **8-byte big-endian `Uint8Array`** (same as header -65537 and contract `bytes8`).
  - In URLs/APIs where a string is natural: **16 hex chars** (e.g. entry ID components, logs). Decode to `Uint8Array` at boundaries.
- **No key 0 in stored or transmitted “grant” blobs** for the canonical format. Key 0 may remain only as a temporary compatibility shim where we must read legacy stored documents (see migration below).

## 3. Call-path inventory

| Context | Needs idtimestamp? | Current shape | Target shape |
|--------|--------------------|---------------|--------------|
| Transparent statement payload | No | Payload = 1–8 only | Unchanged (already correct). |
| Transparent statement header -65537 | Yes | idtimestamp in header | Unchanged. |
| POST /logs/{logId}/grants body | No | 0–8 (encoding pkg) | Body = grant content only (1–8). Server never reads key 0. |
| R2 authority/{innerHex}.cbor (sequenced) | No | 0–8 (idtimestamp often zeros) | Store **grant content only** (1–8). Idtimestamp comes from massif when serving. |
| GET /grants/authority/{innerHex} response | Yes | Full grant CBOR 0–8 | Build completed grant from (content, idtimestamp); encode for response (see below). |
| Receipt verification (leaf commitment) | Yes | grant.idtimestamp + inner | Accept (grantContent, idtimestamp) or (Grant, idtimestamp); use idtimestamp only in leaf hash. |
| Bootstrap COSE Sign1 | No | Payload 1–8, header -65537 | Unchanged. |
| Inner hash (grant-sequencing) | No | inner preimage has no idtimestamp | Unchanged. |

Only the following **actually need** idtimestamp as a value:

- Building the **completed grant** for the client (e.g. GET grant).
- **Receipt verification** (leaf = H(idTimestampBE || inner)).

All other paths can work with “grant content” only. (Grant sequencing is required for POST /logs/{logId}/grants; there is no fallback storage path.)

## 4. Target types and codec

- **GrantContent:** In-memory type for “publish-grant” fields only (no idtimestamp). Can be the same as current Grant minus idtimestamp, or a dedicated type used wherever we only have content.
- **Grant (optional):** Keep as “GrantContent + idtimestamp” for backward compatibility at API boundaries (e.g. response bodies, auth-grant checks). Idtimestamp may be optional when not yet sequenced.
- **Codec:**
  - **encodeGrantPayload** / **decodeGrantPayload:** Remain the canonical encode/decode for **grant content** (1–8). `decodeGrantPayload(bytes, idtimestamp)` already takes idtimestamp separately; keep that.
  - **encodeGrant(grant):** Either (a) deprecated in favour of “encode content + pass idtimestamp separately where needed”, or (b) defined as “encode content then append/embed idtimestamp only for legacy or response use”. Prefer (b) only for **response encoding** (e.g. GET grant returns one CBOR blob for compatibility); do not use it for storage of sequenced grants.
  - **decodeGrant(bytes):** Keep for **reading legacy stored blobs** (0–8) and for **response parsing** if we still return 0–8 in some responses. New storage should not emit 0–8; new code paths should prefer decodeGrantPayload(contentBytes, idtimestamp?) with idtimestamp from header or massif.

## 5. Concrete steps (mini plan)

1. **Codec (canopy-api grant/codec.ts)**  
   - Document that **grant content** = keys 1–8 only; idtimestamp is never part of the canonical content encoding.  
   - Add (if useful) a type or alias for “grant content” (e.g. GrantContent = Omit<Grant, 'idtimestamp'>).  
   - Ensure all **new** storage and wire formats use only content (1–8); idtimestamp passed separately where needed.

2. **Sequenced grant storage (register-grant, serve-grant)**  
   - **Write:** Store `authority/{innerHex}.cbor` as **encodeGrantPayload(grant)** only (no key 0).  
   - **Read:** Load bytes; decode with `decodeGrantPayload(bytes, 8 zero bytes)` to get in-memory grant; then fill idtimestamp from massif when available and build completed grant for response.  
   - Response encoding for GET /grants/authority/{innerHex}: build `Grant` (content + idtimestamp from massif) and encode for client; response format can stay as single CBOR blob (e.g. 0–8) for compatibility, but the **stored** blob is no longer 0–8.

3. **Encoding package (encodeGrantRequest)**  
   - Emit **keys 1–8 only** for POST /logs/{logId}/grants body (grant content only). Remove key 0 from output.  
   - **GrantRequestInput:** Remove or make clearly optional `idtimestamp`; server never uses it from body.  
   - Canopy register-grant: parse body as grant content only (decodeGrantPayload(body, zeros) or add decodeGrantRequest that returns content only).

4. **Receipt verification and auth**  
   - Receipt verification already uses grant.idtimestamp and inner; keep signature but ensure callers pass (grant content, idtimestamp) or Grant where idtimestamp is set from header -65537. No change to leaf formula.  
   - Auth-grant: continue to require “completed” grant (idtimestamp present) when inclusion is required; idtimestamp still comes from transparent statement header only.

5. **Tests and migration**  
   - Update tests that build full 0–8 grant bytes to use content-only where appropriate; provide idtimestamp only in tests that verify receipt or completed grant.  
   - Optional migration: one-time read path that accepts both (1) content-only blob and (2) legacy 0–8 blob for authority/; write path always writes new format.

## 6. Summary

- **Canonical encoding:** Grant content = CBOR keys 1–8 only. Idtimestamp = 8-byte big-endian Uint8Array or hex string by context.  
- **Only add idtimestamp** in call paths that need it: completed-grant response, receipt (leaf) verification.  
- **Storage:** Sequenced grants = content only (authority/{innerHex}.cbor). Grant sequencing is required; no fallback storage path.  
- **Wire:** POST body and new stored blobs = content only; GET response can still return a single “full grant” CBOR for compatibility while internal representation and storage stay aligned with Univocity (grant vs idtimestamp separate).
