---
Status: DRAFT
Date: 2026-06-05
Related: [plan-0018](plan-0018-forest-genesis-api.md), [plan-0025](plan-0025-queue-independent-grant-authorization.md), [plan-0028](plan-0028-forest-genesis-chain-binding.md), [ADR-0004](../adr-0004-forest-genesis-chain-binding-required.md), [arbor plan-0008](../../../arbor/docs/plan-0008-univocity-grant-store-and-authority-resolver.md), [CONTEXT.md](../../CONTEXT.md)
---

# Plan 0029: Delegate grant validation (and genesis) to univocity

## Goal

Make the arbor **univocity** service the authority for creation-grant validation
and genesis storage. Canopy keeps its SCRAPI surface and queue sequencing but
delegates the cryptographic chain decision (and global `logId → R` uniqueness) to
univocity, removing canopy's local self-signing acceptance for child-auth grants
and its ownership of genesis storage. See
[arbor plan-0008](../../../arbor/docs/plan-0008-univocity-grant-store-and-authority-resolver.md)
for the univocity-side design and invariants.

## Why

Canopy cannot resolve a cold owner authority log's root key `K(O)` on its own, so
the child-auth-first path historically verified a grant's COSE envelope against
its **own** `grantData` (self-signing). Univocity now resolves `K(O)` (on-chain or
by recursing its owned grant store, anchored to `bootstrapConfig()`), so canopy
can delegate the decision and verify each non-root envelope against the **owner's**
root key instead.

## Changes

### register-grant (`src/scrapi/register-grant.ts`)

- New env seam `univocity?: { serviceUrl, token }` (from `UNIVOCITY_SERVICE_URL`
  - `UNIVOCITY_API_TOKEN`).
- When configured, **every** creation grant (any first-grant shape: root
  bootstrap, child-auth, child-data) is forwarded to univocity
  `POST /api/grants` with `{ rootLogId: R(wire), statement }`. Univocity performs
  the authoritative chain verification + atomic `logId → R` index create. Status
  maps to the edge decision:
  - `201`/`200` → enqueue for sequencing → `303`
  - `409` → `409` (cross-forest `logId` reuse)
  - `4xx` → `403` (invalid signature chain)
  - other → `503`
- When **not** configured, the legacy local first-grant verification paths run
  unchanged (so unit tests and un-wired environments still work). This makes the
  delegation an additive, transitional switch.

### Genesis (`src/forest/post-genesis.ts`, `get-forest-genesis.ts`)

- `POST /api/forest/{R}/genesis` forwards the canonical v1 genesis CBOR to
  univocity `POST /api/forest/{R}/genesis` (curator token → univocity token).
  Univocity anchors `genesis.key == bootstrapConfig()`; canopy maps `409 → conflict`,
  `4xx → 400`, transient → `503`. The R2 copy is a transitional compat shim.
- `GET /api/forest/{R}/genesis` falls back to univocity on an R2 miss.
- Existing R2 genesis is migrated by curator re-POST/import; plan-0028's
  genesis-in-canopy becomes the compat shim.

### Receipt authority (`src/env/receipt-authority-resolver.ts`, `trust-root-client.ts`)

- Add `createUnivocityPublicTrustRootClient` (same CBOR `public-root` contract as
  the coordinator client, refactored onto a shared bearer/CBOR helper).
- The resolver prefers univocity first (the authoritative chain/grant-derived
  anchor — the same root the sealer authorizes against), with custodian /
  coordinator retained as transitional fallbacks.

### Wiring (`src/index.ts`, `wrangler.jsonc`, deploy)

- `Env.UNIVOCITY_API_TOKEN` added; `UNIVOCITY_SERVICE_URL` already present.
- `apply-runtime-contract.mjs` sets `UNIVOCITY_SERVICE_URL` var;
  `deploy-workers.yml` puts the optional `UNIVOCITY_API_TOKEN` secret.

## Invariants (shared with arbor)

- Owner root key vs target root key: non-root envelopes verify against the
  owner's key, not their own.
- Each `logId` belongs to exactly one forest `R` globally; enforced atomically by
  univocity, surfaced as `409` at canopy's edge.

## Out of scope

- Removing the local first-grant paths entirely (kept as the un-wired fallback).
- KS256 delegated checkpoints (ES256-only delegated path).

## Verification

- `pnpm --filter @canopy/api test -- register-grant forest-genesis receipt-authority`
- `pnpm --filter @canopy/api typecheck`; `pnpm --filter @canopy/api-e2e typecheck`
- `pnpm check` (Prettier)
