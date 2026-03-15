# Plan 0005: Grant and receipt as single artifact (unified resolve)

**Status**: DRAFT  
**Date**: 2026-03-14  
**Related**: [ARC-0001 grant verification](../arc-0001-grant-verification.md), [Subplan 08 grant-first bootstrap](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [auth-grant.ts](../../packages/apps/canopy-api/src/scrapi/auth-grant.ts)

## 1. Goal

- The **caller** supplies the grant artifact in the request. Canopy does **not** fetch or store grants; where the caller obtains or stores the artifact is out of scope for this plan.
- The artifact is the **single document**: a SCITT transparent statement (grant as signed statement with **receipt attached in unprotected headers**). No separate receipt URL or second fetch.
- **Get grant from request**: Read the grant from the **Authorization** header: `Authorization: Forestrie-Grant <base64>`, where `<base64>` is the base64-encoded transparent statement bytes. Decode into a **grant result** (grant + receipt).
- **grantAuthorize** takes the grant result and **only verifies** the receipt (MMR inclusion); no fetch.
- Callers (registerSignedStatement, registerGrant) then perform logId/signer checks as today.

**Deferred to later work:** Grant fetching (e.g. by URL), grant storage, canonical paths, bootstrap grant location. For now, both register-grant and register-signed-statement **require the grant in the Authorization header** as `Authorization: Forestrie-Grant <base64>` (base64-encoded transparent statement).

## 2. Current vs desired behaviour

| Aspect | Current | Desired (this plan) |
|--------|--------|--------|
| Grant supply | Location header (fetch) or body; receipt sometimes separate (X-Grant-Receipt-Location or server-built). | Caller provides **grant in Authorization header**: `Authorization: Forestrie-Grant <base64>` (transparent statement). No fetch by Canopy. |
| Receipt | Separate fetch or built server-side. | Receipt is **part of the artifact** (unprotected headers of the transparent statement). |
| Get grant from request | resolveGrantFromRequest may fetch URL, build receipt. | Read grant from **Authorization: Forestrie-Grant** (base64 decode → COSE decode); yield **GrantResult** (grant + receipt from same bytes). No fetch. |
| grantAuthorize | Takes (request, grant, env); may read request for receipt. | Takes (grantResult, env); verifies receipt only. No request. No fetch. |
| Caller | Resolve → grantAuthorize → logId/signer checks. | Provide grant in **Authorization: Forestrie-Grant** → get GrantResult → grantAuthorize(grantResult, env) → logId/signer checks. |

## 3. Artifact format: SCITT transparent statement

The single artifact is a **SCITT transparent statement**: a signed statement (COSE Sign1) with the **receipt attached in the unprotected headers**. This is established by the SCITT architecture document. The receipt (MMR inclusion proof, root) is carried in the statement’s unprotected header (e.g. label 396 / VDS_COSE_RECEIPT_PROOFS_TAG). One document contains both the statement (grant) and its receipt.

- **Decode**: Parse the COSE Sign1; the payload yields the grant; the unprotected header yields the receipt (root, proof). We decode into a **grant result** with `grant` (Grant) and `receipt` (root + proof) for verification.
- **GrantResult type**: Receipt is required (no null). Every grant artifact supplied to Canopy must be a SCITT transparent statement with attached receipt when inclusion verification is required.

```ts
type GrantResult = {
  grant: Grant;
  receipt: { root: Uint8Array; proof: Proof };  // decoded from the artifact’s unprotected headers
  bytes?: Uint8Array;                          // raw artifact if callers need it
};
```

## 4. How the grant is supplied

- **Authorization header**: register-grant and register-signed-statement **require** the grant in the **Authorization** header using the **Forestrie-Grant** scheme: `Authorization: Forestrie-Grant <base64>`, where `<base64>` is the base64-encoded raw bytes of the SCITT transparent statement. There is no body or alternate-header option; the grant is supplied only via this header. The maximum inclusion proof path length is 63 elements, so the encoded artifact fits within typical header size limits.
- **Decode**: Parse the header value (after the scheme and space); base64-decode to obtain the transparent statement bytes; then COSE-decode to obtain GrantResult (grant from payload, receipt from unprotected headers). If the header is missing, malformed, or the bytes are not a valid transparent statement with receipt, return 401 (missing grant) or 400/403 as appropriate.
- **No fetch, no storage**: Canopy does not resolve grant URLs, store grants, or define canonical paths. Obtaining the grant (e.g. after sequencing) and persisting it elsewhere is the **caller's responsibility**. Bootstrap grant is also supplied by the caller when required; Canopy has no special bootstrap storage.
- **Deferred**: Grant fetching by URL, grant storage, canonical paths (e.g. `/grants/{logId}/{mmrIndex}/grant.cose`), and alias paths are left to later work.

## 5. grantAuthorize signature and behaviour

- **Signature**: `grantAuthorize(grantResult: GrantResult, env: AuthGrantAuthorizeEnv): Promise<Response | null>`.
- **Behaviour**:
  - If `!env.inclusionEnv` → return `null` (no receipt check).
  - If `env.inclusionEnv` and `grantResult.receipt === null` → return 403 (grant artifact must be SCITT transparent statement with receipt; no legacy grant-only).
  - Otherwise: run existing MMR verification using `grantResult.grant` (for leaf hash) and `grantResult.receipt` (root + proof). Return `null` if valid, 403 if invalid.
- No `request` parameter; no reading headers; no fetch.

## 6. Caller flow (registerSignedStatement, registerGrant)

- **registerSignedStatement**:  
  - Caller sends grant in **Authorization: Forestrie-Grant &lt;base64&gt;** (transparent statement).  
  - `grantResult = getGrantFromRequest(request)` (read header, base64 decode + COSE decode); if error, return 401/400/403.  
  - `err = await grantAuthorize(grantResult, env)`; if err, return err.  
  - Check request path logId matches `grantResult.grant.logId`; parse statement, check statement signer matches `grantResult.grant.signer`.  
  - Enqueue, etc.

- **registerGrant**:  
  - Caller sends grant in **Authorization: Forestrie-Grant &lt;base64&gt;** (transparent statement).  
  - `grantResult = getGrantFromRequest(request)`; if error, return 401/400/403.  
  - `grantAuthorize(grantResult, env)` when in non-bootstrap inclusion path.  
  - Check grant.logId matches URL logId; enqueue. (Canopy does not store the grant artifact; caller is responsible for persistence.)

## 7. Implementation steps (summary)

1. **Define GrantResult type** (grant + receipt decoded from SCITT transparent statement; receipt required).
2. **getGrantFromRequest(request)**: Read the **Authorization** header; require `Forestrie-Grant` scheme and a single base64 token. Base64-decode → COSE-decode; extract grant from payload and receipt from unprotected headers. Return `GrantResult | null` or error Response (401 if header missing or wrong scheme, 400/403 if invalid). No fetch; no URL resolution.
3. **grantAuthorize(grantResult, env)**: Use grantResult.grant and grantResult.receipt; when inclusionEnv set and receipt null, return 403; else verify MMR and return null or 403. No request parameter; no fetch.
4. **Callers (registerSignedStatement, registerGrant)**: Require **Authorization: Forestrie-Grant &lt;base64&gt;**; call getGrantFromRequest → grantAuthorize(grantResult, env) → logId/signer checks → enqueue. Remove X-Grant-Receipt-Location and any grant-URL resolution from the API contract for this phase.
5. **Out of scope for this plan**: Grant storage, grant fetching by URL, canonical paths, bootstrap storage. Defer to later work.

## 8. Security and authorization (assessment)

This simplification **does not weaken** the security or authorization model:

- **Inclusion verification**: Unchanged. We still verify the grant receipt (MMR inclusion) using `grantResult.grant` and `grantResult.receipt`. The artifact is whatever the caller sends; we verify it. We do not trust the source of the bytes—only that the receipt proves inclusion in the authority log.
- **Signer binding**: Unchanged. For register-signed-statement, the statement signer must match the grant signer (ARC-0001). We derive the grant from the supplied artifact and compare.
- **No trust in location**: We never relied on "where" the grant was fetched from as a security property. Authorization is determined by the content (grant + receipt) and its verification. Caller-supplied grant in the request is therefore consistent: a forged or invalid artifact fails receipt or signer checks.

Making storage and fetching the caller's responsibility **simplifies execution**: no R2 paths, no serve-grant, no bootstrap storage, no URL resolution in this phase. The API surface is "provide the grant in Authorization: Forestrie-Grant &lt;base64&gt;; we verify and proceed."

## 9. Payload vs headers: idtimestamp never in payload

### 9.1 Architectural rule

**Idtimestamp must never be in the COSE Sign1 payload.** COSE and SCITT treat the payload as the signed content that was submitted to the log; it is immutable and must match what was actually registered. Idtimestamp is **strictly post-sequencing**: it is assigned by the log (Ranger) when the leaf is appended. It cannot be both available and correct before the statement is fully registered and added to the log. Therefore idtimestamp **cannot** be part of the payload. Forestrie and Canopy must not have an opinion on payload contents beyond this rule: the payload is the statement that was registered; idtimestamp is carried **only** in the unprotected header (label -65537).

### 9.2 Relationship: what is registered vs what the log receives

- **What gets signed and submitted**: A signed statement (COSE Sign1) whose **payload** is the grant content **without** idtimestamp — the content that exists at sign time, before any registration.
- **What the log (Ranger) receives**: The content is keyed by **ContentHash = inner** (the hash of that payload content; see `innerPreimage` in `src/grant/inner-hash.ts`, which explicitly excludes idtimestamp). So we enqueue **inner**; Ranger appends the leaf and **assigns** idtimestamp. Leaf commitment = **leafHash** = SHA-256(idTimestampBE || inner). The payload of the signed statement is therefore the pre-sequencing content; it never contains idtimestamp.
- **Completed transparent statement**: After sequencing, we have the **same payload** (unchanged) plus unprotected headers: **396** = receipt (MMR proof), **-65537** = idtimestamp (8-byte bstr, big-endian). The payload is not modified; idtimestamp exists only in the header.

### 9.3 What led to the earlier error (idtimestamp in payload)

Earlier guidance incorrectly stated that idtimestamp could be in the grant payload (CBOR key 0). That came from:

1. **Conflating wire formats**: The current **Grant** type and **codec** (`encodeGrant` / `decodeGrant`) include idtimestamp as key 0. That encoding is used for **storage** (e.g. R2 grant document) and for the **in-memory completed grant** (e.g. GET /grants/authority/{innerHex} returns a full grant with idtimestamp merged from the massif). That is a **completed grant document** representation, not the SCITT signed statement payload. The SCITT transparent statement has a payload that is the **statement as registered** — which cannot contain idtimestamp.
2. **Focusing only on inner preimage**: The inner hash correctly excludes idtimestamp (`innerPreimage` has no idtimestamp), so we concluded "no chicken-and-egg" even if idtimestamp were in the payload. But COSE/SCITT semantics require the **payload** to be the content that was committed; that content does not and cannot include a value that does not exist until after registration. So the payload must be idtimestamp-free by design.
3. **Plan/overview wording**: Docs that say "grant document written with (idtimestamp, mmrIndex)" refer to the **stored** document or the completed grant **object**, not the SCITT statement payload. The architectural distinction (payload = registered statement only; idtimestamp only in header) was not spelled out.

### 9.4 Suggested header labels

| Purpose | Label | Name | Value / notes |
|--------|-------|------|----------------|
| **Receipt (inclusion proof)** | **396** | `vdp` (verifiable data structure proofs) | IANA-assigned. Map with key `-1` → array of proof entries; each entry `{ 1: mmrIndex, 2: path }`. **Use 396** for the receipt in the transparent statement unprotected headers. |
| **Idtimestamp** | **-65537** | (private use) | **Required** for completed transparent statements. Idtimestamp is **never** in the payload. **Use unprotected header label -65537** (COSE private use, RFC 9052: integers &lt; -65536): value = 8-byte bstr (big-endian). Writers set -65537 to the idtimestamp assigned by the log after sequencing. Parsers and verifiers read idtimestamp from -65537 only. |

**Recommendation:** Use **396** for the receipt; use **-65537** for idtimestamp. The payload is the grant content without idtimestamp (the statement that was registered). Implementation must not require or expect idtimestamp in the payload; GrantResult.grant.idtimestamp (for verification) must be taken from the -65537 header when decoding the transparent statement.

### 9.5 Consistency with Univocity smart contracts (sibling repo univocity)

The sibling repository **univocity** (Univocity smart contracts) is consistent with this design:

- **PublishGrant** (`src/interfaces/types.sol`): The struct has `logId`, `grant`, `request`, `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`. It has **no idtimestamp field**. The NatSpec states: "Leaf inner hash: logId, grant, maxHeight, minGrowth, ownerLogId, grantData (no request)."
- **_leafCommitment** (`src/algorithms/lib/LibLogState.sol`): Signature is `_leafCommitment(bytes8 grantIDTimestampBe, PublishGrant calldata g)`. The idtimestamp is a **separate** parameter, not part of the grant. Inner = `sha256(abi.encodePacked(g.logId, g.grant, g.maxHeight, g.minGrowth, g.ownerLogId, g.grantData))`; leaf = `sha256(abi.encodePacked(grantIDTimestampBe, inner))`. So leaf = H(idTimestampBE \|\| inner) with inner = hash of grant content only.
- **LibLeafEncoding** (`src/algorithms/lib/LibLeafEncoding.sol`): `innerPreimage(PublishGrant memory g)` uses only PublishGrant fields; `leafCommitment(bytes8 grantIDTimestampBe, PublishGrant memory g)` returns `sha256(abi.encodePacked(grantIDTimestampBe, sha256(innerPreimage(g))))`.
- **publishCheckpoint** (`src/contracts/_Univocity.sol`): Takes `bytes8 grantIDTimestampBe` and `PublishGrant calldata publishGrant` as **separate** arguments. Inclusion is verified with `_leafCommitment(grantIDTimestampBe, publishGrant)`.

So the contract never embeds idtimestamp in the grant type; it is always supplied separately and used only in the leaf commitment. The SCITT transparent statement rule (idtimestamp never in payload; only in header -65537) matches the contract interface (PublishGrant without idtimestamp; grantIDTimestampBe separate).

## 10. Open decisions

- Grant fetching, storage, and canonical paths: deferred; no decision in this plan.

---

Once this plan is confirmed, implementation can proceed in auth-grant.ts and callers (register-signed-statement, register-grant). No serve-grant or storage in this phase.
