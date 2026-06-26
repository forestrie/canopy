# ADR-0009 — Self-service onboard request provisioning

**Status:** Accepted (2026-06-26)
**Date:** 2026-06-26
**Related:**
[plan-0039](../plans/plan-0039-self-service-onboard-provisioning.md),
[devdocs ARC-021.7](../../../devdocs/arc/arc-021-payment-onboarding/07-self-service-onboard-request.md),
[FOR-166](https://linear.app/forestrie/issue/FOR-166)

---

## Context

Mandate fork operators need a `CANOPY_PAYMENTS_ONBOARD_TOKEN` without manual
email to the canopy operator. Today only ops can mint via
`POST /api/payments/onboard-tokens` (`CANOPY_OPS_ADMIN_TOKEN`).

Reimbursement trust remains **off-chain** (glossary: payment-authoritative
registration). Self-service automates credential issuance only.

## Decision

### Route namespace

Public and ops onboard-request routes live under **`/api/onboarding/**`**, not
`/api/payments/**` (which stays entirely ops-gated).

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/onboarding/requests` | Public |
| `GET` | `/api/onboarding/requests/{id}` | Public |
| `POST` | `/api/onboarding/requests/{id}/redeem` | Public (redeem code) |
| `GET` | `/api/onboarding/requests` | Ops admin bearer |
| `POST` | `/api/onboarding/requests/{id}/approve` | Ops admin bearer |
| `POST` | `/api/onboarding/requests/{id}/reject` | Ops admin bearer |
| `GET` | `/api/onboarding/admin/tokens` | Ops admin bearer (JSON) |
| `GET` | `/api/onboarding/admin/requests` | Ops admin bearer (JSON) |
| `POST` | `/api/onboarding/admin/requests/{id}/approve` | Ops admin bearer (JSON) |
| `POST` | `/api/onboarding/admin/requests/{id}/reject` | Ops admin bearer (JSON) |

JSON admin routes exist for the ops admin UI only; mandate CLI uses CBOR.

### Deployment env

`/api/onboarding/**` is exempt from custodian/sequencing/receipt checks in
`checkRequestEnv` (same pattern as `/api/forest/**`). Requires `R2_GRANTS` and
`UNIVOCITY_CONTRACT_RPC_URL` for the public create path.

### Request lifecycle

`pending` → `approved` | `rejected` | `expired` → `redeemed` (after redeem).

Onboard token mint happens on **approve** (or auto-approve), not on create.

### Univocity gate (v1)

On create, `eth_getCode(univocityAddr)` via `UNIVOCITY_CONTRACT_RPC_URL`.
Reject if code empty. Reject `chainId` unless it equals `ONBOARD_ALLOWED_CHAIN_ID`
(when set).

### Token binding and consume

Request-minted tokens carry `chainBinding` copied from the request. PA genesis
must match binding. On first successful PA genesis, set `consumedForestR`.
Legacy ops-mint tokens without binding remain valid until revoked.

### Redeem code

32-byte hex secret; stored as SHA-256 hash only. Returned once on create.

### Notifications

Optional `ONBOARD_REQUEST_WEBHOOK_URL` + HMAC secret; best-effort async;
failures do not fail create.

### Auto-approve (dev only)

`ONBOARD_AUTO_APPROVE=true` with `ONBOARD_AUTO_APPROVE_CHAIN_IDS` allowlist.
Redeem still required.

## CBOR map keys

**Create request body:** 1=label, 2=chainId, 3=univocityAddr, 4=contactEmail,
5=mandateOrigin?, 6=plannedForestR?

**Create response:** 1=requestId, 2=status, 3=expiresAt, 4=redeemCode

**Redeem body:** 1=redeemCode

**Approve response / redeem success:** same shape as mint (token, ref, …)

## Consequences

- `CANOPY_OPS_ADMIN_TOKEN` never exposed to mandate operators.
- Distinct from wallet-challenge session (FOR-133) and Mode C onboarding (FOR-112).
