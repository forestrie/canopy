---
Status: DRAFT
Date: 2026-04-04
Related:
  - [plan-0018](plan-0018-forest-genesis-api.md)
  - [plan-0014](plan-0014-register-grant-custodian-signing.md)
---

# Plan 0019 — Bootstrap-scoped SCRAPI paths and genesis cache

## Summary

SCRAPI URLs are **scoped by bootstrap forest id**: `POST /register/{bootstrap-logid}/{grants|entries}`, `GET /logs/{bootstrap-logid}/{logId}/…` (status and receipt). **`ROOT_LOG_ID`** is removed from the worker bootstrap/deployment trio. **`GET /api/forest/{log-id}/genesis`** serves public CBOR; **`genesis-cache`** loads and validates genesis for the path segment before register/log handlers run. Legacy **`POST /api/grants/bootstrap`** and **`GET /grants/bootstrap/...`** are removed; e2e mint uses runner-side Custodian + curator genesis POST.

## Implementation checklist

- [x] `GET /api/forest/{log-id}/genesis` (public CBOR); POST remains curator-authenticated (`handle-forest-request`).
- [x] `genesis-cache` (R2 + in-memory `Map`) wired into register-grant, register-signed-statement, query-registration-status, resolve-receipt.
- [x] `index.ts` routing: `register/{bootstrap}/{grants|entries}`, `logs/{bootstrap}/{logId}/…` (receipt path segment count +1).
- [x] `grant-sequencing` status URLs include bootstrap prefix.
- [x] Drop **`ROOT_LOG_ID`** from `deployment-env.ts`, `worker-configuration.d.ts`, deployment tests, Vitest pool config; CI Playwright injects **`CURATOR_ADMIN_TOKEN`** for genesis.
- [x] Remove `bootstrap-grant.ts` handler and update Vitest + Playwright helpers/specs.
- [x] Documentation: this plan, `AGENTS.md`, `packages/tests/canopy-api/README.md`.

## Risks

- **Breaking change** for SCITT clients hard-coding `/register/grants` or `/logs/{logId}/…`.
- Genesis **x,y** must match bootstrap **`grantData`** for root mint; missing genesis → **404** (“forest not provisioned” semantics).
