# ADR-0007 — Wallet-challenge session authentication

**Status:** Accepted (2026-06-23)
**Date:** 2026-06-23
**Related:**
[devdocs ARC-0023](../../../devdocs/arc/arc-0023-wallet-challenge-control-plane-auth.md),
[ADR-0008 authority-source route boundaries](adr-0008-authority-source-route-boundaries.md),
[mandate coordinator-types wire types](../../../mandate/packages/libs/coordinator-types/)

---

## Context

User-facing coordinator management must bind the caller to the authority log
root `K(L)`. A shared `COORDINATOR_APP_TOKEN` cannot express ownership; route
partitioning and credential classes are specified in
[ADR-0008](adr-0008-authority-source-route-boundaries.md).

This ADR covers only the **wallet-challenge session mechanism** (`wcc-1`).

## Decision

1. **`POST /api/auth/challenge`** and **`POST /api/auth/session`** implement
   protocol `wcc-1` (see ARC-0023 §3).
2. **Nonces** live in a dedicated **`WalletChallengeNonceDO`** (single global
   DO, not sharded). Each nonce is single-use with ~120s TTL.
3. **Session tokens** are coordinator-minted **HMAC-SHA256** blobs signed with
   `WALLET_CHALLENGE_SIGNING_SECRET`. TTL **10 minutes**; no refresh in v1.
   Claims: `{ v, authLogId, scopes[], exp, aud }` where `aud` is
   `COORDINATOR_DOMAIN`.
4. **Ownership (v1):** recover KS256 signer from the EIP-191 challenge
   message; require match against the coordinator **registered publicRoot** for
   `authLogId` (not live Univocity/curator lookup).
5. **Scopes** gate user-session routes only (see ADR-0008). Implemented scopes:
   `delegations:read`, `logs:enabled:read`, `logs:enabled:write`,
   `logs:signing-route:read`, `logs:signing-route:write`, `onboard:bind`
   (reserved).
6. **`requireUserSessionOrResponse`** validates bearer session + scope + log
   binding when `ENABLE_WALLET_CHALLENGE=true`. When disabled, user-session
   routes fall back to `COORDINATOR_APP_TOKEN` (transitional).
7. **Do not** extend per-log `issuerToken` to user-session routes.

## Consequences

- Env: `WALLET_CHALLENGE_SIGNING_SECRET`, `COORDINATOR_DOMAIN`,
  `ENABLE_WALLET_CHALLENGE`.
- ES256 envelope verification and hierarchical `authLogId ≠ logId` deferred.
- Sealing, public reads, operator `/admin/api/`, and service issuance are out
  of scope here — see ADR-0008.
