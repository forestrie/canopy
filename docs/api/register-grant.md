# Register-grant API

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0005 grant and receipt as single artifact](../plans/plan-0005-grant-receipt-unified-resolve.md), [ARC-0001 grant verification](../arc-0001-grant-verification.md) (**§4** grant transparent-statement signature; **§5** receipt inclusion; **§9** implementation gaps), [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md), [canopy-api](canopy-api.md), [Subplan 08](../plans/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md)

## Endpoint

`POST /register/grants`

Creates a grant (enqueues for sequencing). Per [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md), **grant storage and location are the caller's responsibility** in the current phase; the API may return the grant in the response for the caller to persist. No payment in this phase.

## Request

- **Content-Type**: `application/cbor` (CBOR end-to-end).
- **Body**: CBOR-encoded grant request (**Forestrie-Grant v0** — map keys **1–6** only):
  - **logId** — 16 bytes (UUID of target log). Authoritative target log id (not duplicated in the URL).
  - **ownerLogId** — 16 bytes (UUID of authority log that owns this grant).
  - **grant** (CBOR key 3) — 8 bytes (flags bitmap; `PublishGrant.grant` on-chain).
  - **grantData** — bytes (issuer attestation; for register-statement, binds allowed statement signer via **`statementSignerBindingBytes`**).
  - Optional numeric: **maxHeight**, **minGrowth** (CBOR keys 4–5).
  - **No** CBOR **signer** (key 7), **kind** (key 8), **version**, **exp**, or **nbf** on the wire map.

Schema and CDDL in the grant format module (Plan 0001 Step 1).

## Response

- **201 Created**
  - **Location**: Grant location as a **URL path only** (e.g. **`/grant/<sha256>.cbor`**), relative to the public grant storage hostname. Client must combine with the configured public base URL for grant storage to form a full URL if needed.
  - **Content-Type**: `application/cbor`
  - **Body** (optional): CBOR map with e.g. `location` (path), `hash` for convenience.

## Storage path (content-addressable)

- Path schema: **`grant/<hash>.cbor`** (v0; content-addressed, no kind segment).
- **`hash`**: SHA-256 of the **encoded grant** CBOR (keys **1–6**). Same grant content → same path; idempotent. Idtimestamp is not part of the path in this phase.
- Storage key is this path (possibly with a prefix such as `grants/`). The **location** returned to the client is the path (or path with prefix) so that it can be interpreted relative to the public grant storage hostname.

## Auth, signature, and inclusion

When the log is already initialized, the **auth grant must be supplied in the Authorization header**: `Authorization: Forestrie-Grant <base64>` (base64-encoded SCITT transparent statement: grant + receipt in one artifact). **Normative (ARC-0001 §4):** the transparent statement MUST be a **valid COSE Sign1** whose signing key is the **checkpoint signer** for the **authority log** identified by inner **`ownerLogId`**, or an **authorised delegate** — so only that identity can issue grants whose leaves append under that log. **§5:** the grant must be **completed** (idtimestamp) and the **receipt** (unprotected headers) must verify (MMR inclusion). **Current Canopy:** §4 is **not** fully implemented on the non-bootstrap path; see [ARC-0001 §9](../arc-0001-grant-verification.md). [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md). No `X-Grant-Receipt-Location` in this phase. Missing or wrong header → **401**; invalid signature or receipt → **403 Forbidden** (once §4 is enforced).

## Errors

- **400 Bad Request** — Invalid grant request (missing required fields, invalid values). CBOR Concise Problem Details; optional `detail` or extension members.
- **413 Payload Too Large** — Request body exceeds configured maximum.
- **415 Unsupported Media Type** — Body is not CBOR.
- **500 Internal Server Error** — Storage or internal failure. CBOR problem details.

All error responses are CBOR (Concise Problem Details) consistent with other APIs.

## Example (informative)

Request:

```
POST /register/grants
Content-Type: application/cbor

<CBOR grant request>
```

Response:

```
201 Created
Location: /grant/a1b2c3....cbor
Content-Type: application/cbor

{ "location": "/grant/a1b2c3....cbor" }
```

The client may persist the grant at the content-addressable path. Register-statement uses **Authorization: Forestrie-Grant** with the transparent statement (Plan 0005); grant path fetch is not used in that phase.
