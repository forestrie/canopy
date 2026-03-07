# Register-statement API

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md), [canopy-api](canopy-api.md), [register-grant](register-grant.md)

## Endpoint

`POST /logs/{logId}/entries`

Registers a signed statement (COSE Sign1) into the log. **Requires** a valid grant: the client supplies the grant location, the API retrieves the grant from object storage, verifies that the statement being registered is signed by the grant’s signer, then enqueues the statement. No fallback; no x402 payment in this phase.

## Grant location (required)

- **Mechanism**: One of (to be chosen in implementation):
  - **`Authorization: Bearer <path>`** — The token is the grant location (URL path only).
  - **`X-Grant-Location: <path>`** — Header value is the grant location (URL path only).
- **Format**: **URL path only** (e.g. `/<kind>/<hash>.cbor`). It is interpreted **relative to the public grant storage hostname** configured for the API. The API resolves this to a storage key (path with optional prefix) and fetches the grant from object storage. Full URLs are not accepted in this phase; clients must use the path form.
- If the grant location is missing, malformed, or not a path relative to the configured grant storage base → **401 Unauthorized** or **402 Payment Required** (CBOR problem details), and the request body is not processed.

## Request body

- **Content-Type**: `application/cbor` or `application/cose` (COSE Sign1 statement, or CBOR wrapper with statement).
- **Body**: The signed statement (COSE Sign1) to register. Existing behaviour: COSE Sign1 bytes or CBOR `{ "signedStatement": <COSE bytes> }`.

## Verification

1. **Locate** — Parse grant location from header; must be URL path only.
2. **Retrieve** — Resolve path to storage key; fetch grant from object storage (R2). If not found or error → **401** or **402** with problem detail (e.g. `grant_location_invalid` or `grant_not_found`).
3. **Decode** — Decode grant bytes to grant structure. If invalid → **401** or **402**.
4. **Verify signer** — From the request body (COSE Sign1), obtain the signer (e.g. kid or public key). Compare with the grant’s signer binding. If they do not match → **401 Unauthorized** or **403 Forbidden** with problem detail (e.g. `signer_mismatch`).
5. (Optional) If the grant has validity fields (exp, nbf), reject if expired or not yet valid.
6. On success, proceed to existing enqueue logic (303 See Other with Location to the entry).

## Response

- **303 See Other** — Registration accepted; `Location` points to the entry (e.g. by content hash). Same as existing behaviour.
- **401 Unauthorized** / **402 Payment Required** — Grant missing, invalid, or not found. CBOR Concise Problem Details; optional extension (e.g. `reason: "grant_not_found"`).
- **403 Forbidden** — Grant signer does not match statement signer. CBOR problem details; optional `reason: "signer_mismatch"`.

All error responses are CBOR (Concise Problem Details) consistent with other APIs.

## Errors (summary)

| Status | Meaning |
|--------|--------|
| 400 | Bad Request (e.g. invalid statement body). |
| 401 / 402 | Grant location missing, malformed, or grant not found. |
| 403 | Statement signer does not match grant’s signer binding. |
| 413 | Payload too large. |
| 415 | Unsupported media type. |
| 500 / 503 | Server / storage error. |

## Rate limiting

- Rate limits are keyed by **grant signer**. A KV store tracks per-signer usage (rolling window + spike window). Rate tiers define max requests per window and per spike. Enforcement is **unit-tested only** in this phase. See [canopy-api](canopy-api.md).

## Observability

- Log **success** at INFO (e.g. grant location, logId, outcome). Otherwise follow prevailing implementation practice for logging and metrics.
