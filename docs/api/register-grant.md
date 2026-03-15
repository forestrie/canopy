# Register-grant API

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0005 grant and receipt as single artifact](../plans/plan-0005-grant-receipt-unified-resolve.md), [ARC-0001 grant verification](../arc-0001-grant-verification.md) (receipt-based inclusion), [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md), [canopy-api](canopy-api.md), [Subplan 08](../plans/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md)

## Endpoint

`POST /logs/{logId}/grants`

Creates a grant (enqueues for sequencing). Per [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md), **grant storage and location are the caller's responsibility** in the current phase; the API may return the grant in the response for the caller to persist. No payment in this phase.

## Request

- **Content-Type**: `application/cbor` (CBOR end-to-end).
- **Body**: CBOR-encoded grant request. Required fields (all bytes for Solidity/on-chain safety):
  - **logId** — 16 bytes (UUID of target log). Must match URL `{logId}`.
  - **ownerLogId** — 16 bytes (UUID of authority log that owns this grant).
  - **grantFlags** — 8 bytes (bitmap).
  - **kind** — 1 byte (uint8; e.g. 0 = attestor, 1 = publish-checkpoint).
  - **signer** — bytes (key id or public key; must match statement signer at register-statement).
  - **grantData** — bytes (optional; can be empty).
  - Optional numeric: maxHeight, minGrowth, exp, nbf.

Schema and CDDL in the grant format module (Plan 0001 Step 1).

## Response

- **201 Created**
  - **Location**: Grant location as a **URL path only** (e.g. `/<kind>/<hash>.cbor`), relative to the public grant storage hostname. Client must combine with the configured public base URL for grant storage to form a full URL if needed.
  - **Content-Type**: `application/cbor`
  - **Body** (optional): CBOR map with e.g. `location` (path), `hash`, `kind` for convenience.

## Storage path (content-addressable)

- Path schema: **`<kind>/<hash>.cbor`**
- **`kind`**: Grant kind as path segment (e.g. `attestor`, `publish-checkpoint`); stored as 1 byte in grant.
- **`hash`**: Hash of the **encoded grant content** (e.g. SHA-256 of the grant CBOR bytes). Same grant content → same path; idempotent. Idtimestamp is not part of the path in this phase.
- Storage key is this path (possibly with a prefix such as `grants/`). The **location** returned to the client is the path (or path with prefix) so that it can be interpreted relative to the public grant storage hostname.

## Auth and inclusion (non-bootstrap)

When the log is already initialized, the **auth grant must be supplied in the Authorization header**: `Authorization: Forestrie-Grant <base64>` (base64-encoded SCITT transparent statement: grant + receipt in one artifact). The grant must be **completed** (idtimestamp) and the **receipt is part of the artifact** (unprotected headers). The API verifies the receipt (MMR inclusion). See [ARC-0001](../arc-0001-grant-verification.md) and [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md). No X-Grant-Receipt-Location or server-built receipt in this phase. Missing or wrong header → **401**; invalid receipt → **403 Forbidden**.

## Errors

- **400 Bad Request** — Invalid grant request (missing required fields, invalid values). CBOR Concise Problem Details; optional `detail` or extension members.
- **413 Payload Too Large** — Request body exceeds configured maximum.
- **415 Unsupported Media Type** — Body is not CBOR.
- **500 Internal Server Error** — Storage or internal failure. CBOR problem details.

All error responses are CBOR (Concise Problem Details) consistent with other APIs.

## Example (informative)

Request:

```
POST /logs/550e8400-e29b-41d4-a716-446655440000/grants
Content-Type: application/cbor

<CBOR grant request>
```

Response:

```
201 Created
Location: /attestor/a1b2c3....cbor
Content-Type: application/cbor

{ "location": "/attestor/a1b2c3....cbor", "kind": "attestor" }
```

The client uses the path `/attestor/a1b2c3....cbor` when calling register-statement (as the grant location). The full URL is `https://<grant-storage-host>/attestor/a1b2c3....cbor` if the client needs to fetch the grant directly.
