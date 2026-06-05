---
Status: ACCEPTED
Date: 2026-06-01
Related: [plan-0028](plans/plan-0028-forest-genesis-chain-binding.md), [plan-0018](plans/plan-0018-forest-genesis-api.md), [arbor plan-0003](../../arbor/docs/plan-0003-non-custodial-checkpoint-support.md)
---

# ADR-0004: Forest genesis POST requires Univocity chain binding

New `POST /api/forest/{log-id}/genesis` requests must include genesis schema
version `1`, a 20-byte Univocity contract address (`-68011`), and a decimal
EIP-155 chain id string (`-68013`). The legacy `-68012` uint32 array is rejected
on write.

Multi-forest Canopy needs a curator-attested `(chain, contract)` tuple per
bootstrap log `R` so Sealer and publishers can verify plan-0003 delegations and
checkpoints without deployment-wide `UNIVOCITY_*` env vars. Optional null chain
fields failed the product rule that every forest has an explicit genesis.

POST is a breaking change for callers that omitted addr/chain (tests only today).
Existing v0 genesis objects in R2 remain readable: parser accepts documents
without version or chain binding; only new POSTs write v1.

**Considered:** Keep addr/chain optional for queue-only forests — rejected;
integration tests use dummy values instead.
