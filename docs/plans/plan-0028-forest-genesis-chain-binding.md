---
Status: DRAFT
Date: 2026-06-01
Related:
  - [plan-0018](plan-0018-forest-genesis-api.md)
  - [plan-0019](plan-0019-bootstrap-path-and-genesis-cache.md)
  - [ADR-0004](../adr-0004-forest-genesis-chain-binding-required.md)
  - [CONTEXT.md](../../CONTEXT.md)
  - [grants.md §10.1](../grants.md)
---

# Plan 0028 — Forest genesis chain binding (v1 POST)

## Summary

Extend the forest genesis document so every **new** curator POST carries Univocity **chain binding** (`chain-id` + contract address) alongside the root trust-anchor COSE_Key. Tighten POST validation; keep **v0 read compatibility** for genesis objects already in R2.

## Domain language

See [CONTEXT.md](../../CONTEXT.md) for canonical terms (Forest, bootstrap root auth log `R`, forest genesis document, chain binding, Univocity contract address).

[grants.md §10.1](../grants.md) now states that chain binding lives in the same forest genesis document and is required on new POSTs; SCRAPI bootstrap verification still uses x‖y only until consumption work lands.

## Required fields on new POST (genesis v1)

| Field | CBOR label | Wire | Source at provisioning |
|-------|------------|------|------------------------|
| Root trust-anchor pubkey | COSE_Key EC2 P-256 | `1`, `-1`, `-2`, `-3`, optional `3` | Custodian key / BYOK / curator-chosen root key for `R` |
| Genesis schema version | `-68009` | uint = `1` | Literal `1` |
| Bootstrap log id | `-68010` | bstr 32 | Server-stamped from path; must equal `authorityLogId` in Univocity root-bootstrap payload |
| Univocity contract address | `-68011` | bstr 20 | `imutableUnivocity` from Safe deploy JSON (**not** the Safe multisig address) |
| Chain id | `-68013` | tstr decimal EIP-155 | `chainId` from same deploy JSON (e.g. `"84532"`) |

**Policy:** No queue-only profile. System e2e uses ephemeral Imutable contracts from [plan-0032](plan-0032-univocity-imutable-e2e-provision.md). Production curators use real deploy values.

## Wire format

### v1 POST (write target)

Allowed keys:

- COSE_Key: `1`, `-1`, `-2`, `-3`, optional `3`
- `-68009` genesis-version = `1` (**required**)
- `-68010` bootstrap-logid (optional on input; server always stamps from path)
- `-68011` univocity-addr 20 bytes (**required**)
- `-68013` chain-id tstr, non-empty, `/^[0-9]{1,10}$/` (**required**)

**Reject on POST:** `-68012` (legacy `univocity-chainids` array), unknown keys, null addr/chain.

### v0 legacy (read only)

Objects from [plan-0018](plan-0018-forest-genesis-api.md):

- No `-68009`; `-68011`/`-68012` may be null
- Parser accepts for register-grant / resolve-receipt / status paths
- `ParsedForestGenesis.chainBinding` is `null`; `schemaVersion` is `0`

**Write/read split:** POST always creates v1; read accepts v0 + v1. No PUT/PATCH.

## Provisioning runbook

Order for a new forest:

1. Choose root authority log UUID → `R` (matches future `authorityLogId`).
2. Deploy ImutableUnivocity via Safe → record `imutableUnivocity`, `chainId`.
3. `POST /api/forest/{R}/genesis` with COSE_Key + `-68011` + `-68013`.
4. Mint root bootstrap grant; `POST /register/{R}/grants`.
5. Execute Univocity root bootstrap Safe transaction.

Automating genesis POST from Safe deploy JSON is **out of scope** (forest-1 follow-up).

## Implementation

| File | Change |
|------|--------|
| `forest-genesis-labels.ts` | `-68009`, `-68013`; `-68012` legacy read-only |
| `post-genesis.ts` | v1 POST validation; canonical store |
| `genesis-cache.ts` | v0/v1 parse; `chainBinding`, `schemaVersion`; `isGenesisV1()` |
| `genesis-wire.ts` | Shared parse helpers |
| `forest-genesis.test.ts` | v1 POST; v0 read fixture; 400 matrix |
| `forest-genesis-e2e.ts` | Dummy addr + chain id on POST |
| Child-grant / deployment-env tests | v1 bodies or v0 mocks |

## Out of scope

- Consuming chain binding in register-grant, receipt resolver, Sealer ([plan-0003](../../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md), [plan-0025](plan-0025-queue-independent-grant-authorization.md))
- Grant → forest discovery API
- Embedding `R` in grant wire format
- Forced migration/re-POST of existing v0 genesis in deployed envs

## Verification

```sh
cd canopy
pnpm --filter @canopy/api test -- forest-genesis deployment-env-validation register-grant-child
pnpm --filter @canopy/api typecheck
pnpm --filter @canopy/api-e2e typecheck
```
