# ARC-0001: Grant verification (receipt-based inclusion and signer binding)

**Status**: DRAFT  
**Date**: 2026-03-14  
**Related**: [Plan 0005 grant and receipt as single artifact](plans/plan-0005-grant-receipt-unified-resolve.md), [Subplan 08 grant-first bootstrap](plans/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [Subplan 01 shared encoding](plans/plan-0004-log-bootstraping/subplan-01-shared-encoding-univocity-alignment.md), [Subplan 03 grant-sequencing](plans/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md)

## Purpose

This document is the **single reference** for how Canopy verifies that an auth grant is allowed for a request. It is referenced by subplans, plans, and API docs wherever grant auth or inclusion is specified. Two aspects are defined here:

1. **Receipt-based inclusion verification** — the grant must be proven included in its owner authority log via a **grant receipt** (COSE Sign1 carrying an MMR inclusion proof).
2. **Signer binding** — for register-signed-statement, the statement’s signer (e.g. COSE `kid`) must match the grant’s signer binding.

Implementations live under `src/grant/` (decoding, leaf commitment, receipt verification) and are used by register-grant and register-signed-statement when an inclusion env is configured.

---

## 1. When verification applies

- **register-grant (non-bootstrap):** When the log is initialized and inclusion is required, the auth grant must pass **receipt-based inclusion verification** (see §2). No signer check for the grant itself; after verification, the grant is enqueued.
- **register-signed-statement:** When inclusion is required, the auth grant must pass **receipt-based inclusion verification**. After that, **statement signer must match grant signer** (see §3).

The **bootstrap branch** (log not initialized, auth is bootstrap-signed) does **not** use inclusion or receipt verification.

---

## 2. Receipt-based inclusion verification

### 2.1 Prerequisites

- The grant must be **completed**: it must have an **idtimestamp** (8 bytes). A grant without idtimestamp has not yet been assigned a position in the authority log and cannot be verified by receipt. **Callers supply the grant** in the **Authorization** header: `Authorization: Forestrie-Grant <base64>` (SCITT transparent statement with receipt in unprotected headers; see [Plan 0005](plans/plan-0005-grant-receipt-unified-resolve.md)). Where callers obtain the completed grant is out of scope for this ARC.
- **Idtimestamp and the transparent statement:** Per Plan 0005 §9, idtimestamp is **never** in the COSE Sign1 payload (the payload is the statement as registered; idtimestamp is assigned post-sequencing). When decoding a SCITT transparent statement, idtimestamp must be read from the **unprotected header label -65537** (8-byte bstr, big-endian). The payload yields the grant content (for inner hash and signer); idtimestamp for leaf commitment comes from the header only.

### 2.2 Receipt format

- **Wire format:** COSE Sign1 (CBOR tag 18 optional).
- **Payload:** 32-byte **peak hash** (MMR root for the massif/peak that contains the grant leaf).
- **Unprotected header label 396 (VDS_COSE_RECEIPT_PROOFS_TAG):** Inclusion proof in MMRIVER style:
  - Value: map with key `-1` → array of proof entries.
  - Each entry: `{ 1: mmrIndex, 2: path }` where `path` is an array of 32-byte sibling hashes.

Receipt **signature** verification (COSE Sign1 signature over the receipt) may be required by policy; the core inclusion check does not depend on it.

### 2.3 Leaf commitment

Univocity leaf commitment for a grant entry (same as Subplan 01/03):

- `leafHash = SHA-256(idTimestampBE || inner)`
- `idTimestampBE` = 8-byte big-endian idtimestamp.
- `inner` = `InnerHashFromGrant(grant)` (32-byte content hash).

So the receipt proves that a leaf with this commitment exists in the MMR whose root is the receipt payload.

### 2.4 Verification steps (pseudo code)

```text
FUNCTION verify_grant_receipt(grant, receipt_bytes [, options]):
    // 1. Grant must be completed (have idtimestamp)
    IF grant.idtimestamp is missing OR length(grant.idtimestamp) < 8 THEN
        RETURN false

    // 2. Parse receipt
    (root, proof, coseSign1) := parse_receipt(receipt_bytes)
    // parse_receipt: decode COSE Sign1; payload = 32-byte root; header 396 = { -1: [ { 1: mmrIndex, 2: path } ] }

    // 3. Compute leaf hash for this grant
    inner := InnerHashFromGrant(grant)
    leaf_hash := univocity_leaf_hash(grant.idtimestamp, inner)   // SHA-256(idTimestampBE || inner)

    // 4. Verify MMR inclusion: recompute root from leaf_hash and proof; must equal receipt payload
    computed_root := calculate_root_async(leaf_hash, proof, SHA256)
    IF computed_root != root THEN
        RETURN false

    // 5. Optional: verify COSE Sign1 signature of the receipt (policy)
    IF options.verify_signature AND NOT verify_cose_sign1_signature(coseSign1) THEN
        RETURN false

    RETURN true
```

### 2.5 Obtaining the receipt

Per [Plan 0005](plans/plan-0005-grant-receipt-unified-resolve.md), the **receipt is part of the grant artifact**. The caller supplies the grant as a **SCITT transparent statement**: a COSE Sign1 whose payload is the grant and whose **unprotected headers** carry the receipt (MMR root and inclusion proof at label 396, see §2.2). The API does not fetch a receipt from a URL (X-Grant-Receipt-Location) or build it server-side in this phase. Grant fetching and receipt-building are deferred to later work. If the supplied artifact is not a valid transparent statement with receipt, the request fails (e.g. 400/403).

---

## 3. Signer binding (register-signed-statement only)

After the grant has been verified as included (via receipt), the API enforces:

- **statement.signer == grant.signer**

Here “statement signer” is the value used as the key identifier (e.g. COSE Sign1 `kid` in the protected header); “grant.signer” is the 32-byte signer binding stored in the grant. If they differ, the request is rejected (e.g. 403).

See [arc-grant-statement-signer-binding](arc-grant-statement-signer-binding.md) for code paths.

---

## 4. Summary flow (inclusion-enabled paths)

Per Plan 0005, the caller supplies the grant in the **Authorization** header as `Authorization: Forestrie-Grant <base64>` (base64-encoded SCITT transparent statement). No fetch; no X-Grant-Receipt-Location.

**register-grant (non-bootstrap):**

```text
grant_result := get_grant_from_request(request)   // base64 decode → COSE decode; grant from payload, receipt from unprotected headers
IF grant_result is error THEN RETURN 400 or 403
auth := grant_result.grant
IF NOT grant has idtimestamp THEN RETURN 403 "grant must be completed (idtimestamp required)"
IF NOT verify_grant_receipt(auth, grant_result.receipt) THEN RETURN 403   // receipt from same artifact
enqueue(grantPayload or auth)
RETURN 303 status_url
```

**register-signed-statement:**

```text
grant_result := get_grant_from_request(request)
IF grant_result is error THEN RETURN 400 or 403
grant := grant_result.grant
IF NOT grant has idtimestamp THEN RETURN 403
IF NOT verify_grant_receipt(grant, grant_result.receipt) THEN RETURN 403
IF statement.signer != grant.signer THEN RETURN 403
enqueue_statement(logId, statement)
RETURN 303 status_url
```

---

## 5. Implementation locations

| Concern | Location |
|--------|----------|
| Leaf commitment | `src/grant/leaf-commitment.ts` — `univocityLeafHash(idtimestamp, inner)` |
| Receipt parse / verify | `src/grant/receipt-verify.ts` — `parseReceipt`, `verifyGrantReceipt` |
| Build receipt from R2 (deferred; Plan 0005) | `src/scrapi/resolve-receipt.ts` — `buildReceiptForEntry` (used when server builds receipt; out of scope for current API) |
| Register-grant receipt flow | `src/scrapi/register-grant.ts` — inclusion branch with receipt and `verifyGrantReceipt` |
| Register-signed-statement receipt flow | `src/scrapi/register-signed-statement.ts` — receipt + signer check |

MMR verification reuses the algorithm from `@canopy/merklelog` with an async digest (e.g. `crypto.subtle.digest("SHA-256", ...)`) for Workers.
