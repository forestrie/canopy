# Canopy

Canopy is Forestrie's SCRAPI transparency-log worker: grant registration, statement
ingress, forest administration, and receipt resolution.

## Language

**Forest**:
The namespace of logs that share one bootstrap root authority log `R`. SCRAPI
paths use `/register/{R}/…` and `/logs/{R}/…`.
_Avoid_: deployment, project (those are forest-1 / GCP ops terms).

**Bootstrap root auth log (`R`)**:
The first authority log in a forest. Its bootstrap grant has `ownerLogId === logId`.
After on-chain bootstrap, `R` matches Univocity `rootLogId` / `authorityLogId`.
_Avoid_: bootstrap log alone (conflicts with bootstrap grant or bootstrap transaction).

**Forest genesis document**:
Curator-written CBOR stored at `forest/{hex64(R)}/genesis.cbor` in `R2_GRANTS`.
Binds `R`, the root trust-anchor public key, and Univocity chain binding.
_Avoid_: genesis grant, on-chain genesis.

**Chain binding**:
The pair `(chain-id, univocity-contract-address)` for the EIP-155 chain and
ImutableUnivocity contract this forest publishes to.
_Avoid_: univocity config, trust root URL.

**Univocity contract address**:
The 20-byte address of the user-facing ImutableUnivocity contract (Safe deploy
field `imutableUnivocity`), not the Safe multisig address.
_Avoid_: contract, univocity addr without disambiguation.

**Root bootstrap grant**:
The first Forestrie-Grant on `R`; its `grantData` x‖y must match the forest genesis
pubkey. Distinct from the forest genesis document.
_Avoid_: genesis when meaning the grant.

**Univocity root bootstrap**:
The on-chain transaction that sets `rootLogId` on the contract. Runs after forest
genesis POST and the root bootstrap grant.
_Avoid_: forest genesis.

## Example dialogue

**Dev:** We mint a grant on data log `D` — how do we know which Univocity contract
to verify against?

**Expert:** You need bootstrap `R` from the SCRAPI path or receipt URL, then
`GET /api/forest/{R}/genesis`. The forest genesis document carries chain binding;
the trust anchor x‖y is separate and is what register-grant checks today.

**Dev:** Is that the same as the bootstrap grant?

**Expert:** No. The genesis document is curator provisioning in R2. The bootstrap
grant is the first leaf on `R`'s authority MMR.

## Related

- [plan-0028](docs/plans/plan-0028-forest-genesis-chain-binding.md) — v1 POST wire format and chain binding
- [ADR-0004](docs/adr-0004-forest-genesis-chain-binding-required.md) — POST requires chain binding; read accepts v0/v1
