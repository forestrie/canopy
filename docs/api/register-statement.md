# Register-statement API

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0005 grant and receipt as single artifact](../plans/plan-0005-grant-receipt-unified-resolve.md), [ARC-0001 grant verification](../arc-0001-grant-verification.md) (receipt-based inclusion and signer binding), [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md), [canopy-api](canopy-api.md), [register-grant](register-grant.md)

## Endpoint

`POST /register/entries`

Registers a signed statement (COSE Sign1) into the log identified by **`grant.logId`** (queue shard and `Location` use that target log). **Requires** a valid grant: the client **supplies the grant in the Authorization header** as `Authorization: Forestrie-Grant <base64>` (base64-encoded SCITT transparent statement). The API decodes it, verifies receipt-based inclusion when required, verifies that the statement signer matches the grant signer, then enqueues the statement. No grant fetch by the API in this phase. See [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md).

## Grant supply (required)

- **Mechanism**: The grant **must** be provided in the **Authorization** header: `Authorization: Forestrie-Grant <base64>`, where `<base64>` is the base64-encoded raw bytes of the SCITT transparent statement (COSE Sign1 with grant as payload and receipt in unprotected headers). There is no body or alternate-header option.
- The API **does not fetch** the grant from a URL. Where the client obtains the grant is out of scope.
- If the header is missing, not Forestrie-Grant, or the value is malformed or not a valid transparent statement with receipt when inclusion is required → **401 Unauthorized** (missing/wrong grant) or **400** / **403** (invalid artifact). The request body is not processed in that case.

## Request body

- **Content-Type**: `application/cbor` or `application/cose` (COSE Sign1 statement, or CBOR wrapper with statement).
- **Body**: The signed statement (COSE Sign1) to register. Existing behaviour: COSE Sign1 bytes or CBOR `{ "signedStatement": <COSE bytes> }`.

## Verification

1. **Get grant from request** — Read **Authorization: Forestrie-Grant** header; base64-decode the token → COSE-decode; yield GrantResult (grant from payload, receipt from unprotected headers). If missing, wrong scheme, or invalid → **401**, **400**, or **403**.
2. **Receipt-based inclusion** — When inclusion is required, the grant must be completed (idtimestamp) and the **receipt is part of the artifact** (unprotected headers). The API verifies the receipt (MMR inclusion). See [ARC-0001](../arc-0001-grant-verification.md) and [Plan 0005](../plans/plan-0005-grant-receipt-unified-resolve.md). Missing or invalid receipt → **403 Forbidden**.
3. **Verify grant shape and signer** — Forestrie-Grant wire **v0**: payload map keys **1–6** only ([ARC-0001 §6](arc-0001-grant-verification.md)). The **`grant`** bitmap must satisfy **`isStatementRegistrationGrant`** (data-log checkpoint **or** root auth bootstrap). From the request body (COSE Sign1 statement), obtain the signer (e.g. kid). Compare with **`statementSignerBindingBytes(grant)`** = committed **`grantData`** only (64-byte ES256 **x||y** → first 32 bytes). If they do not match → **403 Forbidden** (e.g. `signer_mismatch`).
4. On success, proceed to existing enqueue logic (303 See Other with Location to the entry).

## Response

- **303 See Other** — Registration accepted; `Location` points to the entry (e.g. by content hash). Same as existing behaviour.
- **401 Unauthorized** / **402 Payment Required** — Grant missing, invalid, or not found. CBOR Concise Problem Details; optional extension (e.g. `reason: "grant_not_found"`).
- **403 Forbidden** — Grant signer does not match statement signer. CBOR problem details; optional `reason: "signer_mismatch"`.

All error responses are CBOR (Concise Problem Details) consistent with other APIs.

## Errors (summary)

| Status    | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| 400       | Bad Request (e.g. invalid statement body).              |
| 401 / 402 | Grant location missing, malformed, or grant not found.  |
| 403       | Statement signer does not match grant’s signer binding. |
| 413       | Payload too large.                                      |
| 415       | Unsupported media type.                                 |
| 500 / 503 | Server / storage error.                                 |

## Rate limiting

- Rate limits are keyed by **grant signer**. A KV store tracks per-signer usage (rolling window + spike window). Rate tiers define max requests per window and per spike. Enforcement is **unit-tested only** in this phase. See [canopy-api](canopy-api.md).

## Observability

- Log **success** at INFO (e.g. grant location, logId, outcome). Otherwise follow prevailing implementation practice for logging and metrics.
