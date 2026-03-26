# Canopy API overview

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md)

## Summary

Canopy API is the HTTP surface for the Forestrie transparency ledger. It provides:

- **Register-grant** — Create a grant (authorization to register statements or publish checkpoints). Grants are stored in object storage and identified by a content-addressable path. No payment in the initial phase.
- **Register-statement** — Register a signed statement (COSE Sign1) into a log. **Requires** a valid grant: the client supplies the grant location, the API retrieves the grant, verifies the statement signer matches the grant, and enqueues the statement.

The API is **CBOR end-to-end**: request and response bodies use CBOR where applicable. Errors use **Concise Problem Details** (CBOR) consistent with RFC 9290 and existing `application/problem+cbor` usage so agents can parse and branch on error type.

## Endpoints

| Endpoint                     | Purpose                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `POST /logs/{logId}/grants`  | Create a grant; returns grant location (URL path).                           |
| `POST /logs/{logId}/entries` | Register a signed statement; requires grant location in request.             |
| (existing)                   | Query registration status, resolve receipt, transparency configuration, etc. |

## Grant storage and location

- Grants are stored in **object storage** (R2 or equivalent) under a **content-addressable** path: **`grant/<hash>.cbor`** where `hash` is SHA-256 of the encoded grant (v0 wire, keys **1–6**). Same content → same path; idempotent.
- The **grant location** returned to clients is a **URL path only** (e.g. `/grant/<hash>.cbor`), interpreted **relative to the public grant storage hostname**. Register-statement in the current phase uses **Authorization: Forestrie-Grant** (no path fetch); see [register-statement](register-statement.md).
- See [register-grant](register-grant.md) and [register-statement](register-statement.md) for request/response and error details.

## Errors

- All error responses use **Concise Problem Details** in CBOR (`Content-Type: application/problem+cbor` or same as existing CBOR problem responses). Body includes at least `type`, `title`, `status`, and optionally `detail`, `instance`, and extension members (e.g. `reason` for `grant_location_invalid`, `signer_mismatch`) so agents can branch on error type.
- Consistent with existing `problemResponse` / `ClientErrors` / `ServerErrors` in the codebase.

## Rate limiting (this phase)

- Rate limits are keyed by **grant signer** (e.g. kid or public key id). A **KV** store holds per-signer state. Limits use a **rolling window** (e.g. 1 hour) and a **spike window** (e.g. 1 minute). **Rate tiers** define allowed requests per window and max per spike window. Enforcement is implemented and **tested via unit tests only** in this phase; integration/e2e may bypass or mock.

## See also

- [Register-grant](register-grant.md) — Request/response, path schema, errors.
- [Register-statement](register-statement.md) — Grant location, signer verification, errors.
- [Plan 0001](../plans/plan-0001-register-grant-and-grant-auth-phase.md) — Implementation plan.
