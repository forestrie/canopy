# ADR-0008 — Authority-source route boundaries

**Status:** Accepted (2026-06-23)
**Date:** 2026-06-23
**Related:**
[ADR-0007 wallet-challenge sessions](adr-0007-wallet-challenge-coordinator-auth.md),
[devdocs ARC-0023](../../../devdocs/arc/arc-0023-wallet-challenge-control-plane-auth.md),
[devdocs ARC-0022 BYOK sealing](../../../devdocs/arc/arc-0022-byok-user-log-delegation-and-operator-hosted-sealing.md),
[mandate ADR-0001](../../../mandate/docs/adr/adr-0001-auth-strategy-seams.md)

---

## Context

FOR-129 partitions delegation-coordinator HTTP by **authority source**: who must
prove what, and which credential class applies. Shared `COORDINATOR_APP_TOKEN`
must not authorize user kill-switch or signing-route changes. Sealing and
sealer poll paths must stay callable without operator secrets.

## Decision — route map

Prefix **`/api/`** is the public coordinator surface (browser BFF, sealer,
mandate agent). Prefix **`/admin/api/`** is operator-only (never BFF-proxied).

### Public sealing (no bearer)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/delegations/certificate` | None | Self-verifying: cert signature vs registered `publicRoot`, bound `logId`/MMR/delegated key |

**Abuse mitigation:** volumetric rate limiting is enforced at the **Cloudflare
edge** (rate-limiting rule on `POST /api/delegations/certificate`), not in
worker code. The handler rejects oversized certificate bodies (16 KiB decoded)
before crypto; validation runs cheap structural checks (payload `logId`/MMR and
delegated-key binding) before signature verification or KS256 JSON-RPC.

Legacy name `material` and `POST /api/delegations/material` are removed;
webhook events expose `certificateSubmitUrl`.

### Public reads (no bearer)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/logs/{logId}/pending-delegation` | None | Sealer poll; respects effective enabled state |
| `GET` | `/api/logs/{logId}/public-root` | None | Trust-root read for verification clients |

`pending-delegation` exposes MMR range and delegated key material for a known
`logId`; this is intentional for the sealer poll path (see ARC-0022). Enumeration
of arbitrary log IDs is not a confidentiality goal; edge rate limiting may
apply if abuse appears.

### User session routes (`/api/`)

Require wallet-challenge session when `ENABLE_WALLET_CHALLENGE=true` (see
ADR-0007). Session `authLogId` must match request `authLogId` or target
`logId` (v1 self-authority).

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/api/delegations/pending?authLogId=` | `delegations:read` |
| `GET` | `/api/logs/{logId}/enabled` | `logs:enabled:read` |
| `PUT` | `/api/logs/{logId}/enabled` | `logs:enabled:write` → writes **`user_enabled`** |
| `GET` | `/api/logs/{logId}/signing-route` | `logs:signing-route:read` |
| `POST` | `/api/logs/{logId}/signing-route` | `logs:signing-route:write` |

`PUT /api/logs/{logId}/enabled` with **app token** (no session) is
**transitional**: writes **`operator_enabled`** until BFF and operators move
operator gating to `/admin/api/`.

### Operator plane (`/admin/api/`)

Require **`COORDINATOR_APP_TOKEN`** only; **reject** wallet-challenge sessions.

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/admin/api/logs/{logId}/enabled` | Read operator + user flags |
| `PUT` | `/admin/api/logs/{logId}/enabled` | Write **`operator_enabled`** (service gate) |
| `POST` | `/admin/api/logs/{logId}/custody-keys` | Custodian ensure proxy |

`POST /api/logs/{logId}/custody-keys` remains a transitional alias to the admin
handler.

### Service routes (`/api/`, app token)

Unchanged: `POST /api/delegations`, per-log webhook CRUD, `issuerToken` on
signing-route targets. **`POST /api/logs/{logId}/public-root`** still requires
`COORDINATOR_APP_TOKEN` (registration); see FOR-134 below.

## Two-authority availability model

Per-log delegation config stores **`user_enabled`** and **`operator_enabled`**.
**Effective sealing** requires both true:

```text
effective_enabled = user_enabled ∧ operator_enabled
```

- User session `PUT …/enabled` toggles **`user_enabled`** (BYOK kill switch).
- Operator `PUT /admin/api/…/enabled` toggles **`operator_enabled`** (hosting
  pause without impersonating the user).
- Either party can halt issuance/webhook delivery independently; both must allow
  for `delegation.required` to proceed.

## Transitional registration (FOR-134)

`POST /api/logs/{logId}/public-root` today accepts **`COORDINATOR_APP_TOKEN`**
(genesis broker). **FOR-134** will introduce a **registration bearer** (or
`onboard:bind` proof-of-possession) so mandate operators need not hold the
global coordinator secret for user genesis. Until then, only trusted brokers
call public-root registration.

## Consequences

- Mandate BFF allowlists **`/api/`** paths only; operator tools call
  `/admin/api/` with server-held app token.
- Certificate submit is public on coordinator and on BFF (no injected bearer).
- Removing `delegations:write` / material UX aligns control plane with
  certificate self-verification on the sealing plane.
