# Domain terminology (Canopy)

Shared Forestrie terms: [devdocs/glossary.md](../../../devdocs/glossary.md).

## Canopy-specific

**SCRAPI worker**: Cloudflare Workers implementing grant registration, statement
ingress, forest administration, and receipt resolution.

**Transparent statement**: COSE Sign1 wrapping a Forestrie-Grant payload; used in
`Authorization: Forestrie-Grant` headers.

**MMRS-cold bootstrap**: First register-grant on a fresh log id before its MMR
store is warm (no entries yet); register-grant takes the creation-grant branch
and returns a 303 redirect to the would-be first entry. Once an entry is
sequenced the log is **MMRS-warm** and bare creation grants are refused (a
steady-state statement registration requires an inclusion receipt).

**Queue-only mode**: Worker configured without full bootstrap env; unsafe for
production grant auth without envelope verification.

## Chain binding (Univocity)

**Bootstrap key**: the contract-global key from the ImutableUnivocity
`bootstrapConfig()` — **ES256:** 64-byte `x‖y`; **KS256:** 20-byte Ethereum
address. One bootstrap key per deployed contract instance. The forest genesis
stores it as the `bootstrapKey`.

**Statement signer binding**: bytes derived from a grant's committed **`grantData`**
that the statement COSE **`kid`** must equal at register-statement. ES256: first
32 bytes of 64-byte `x‖y`; KS256: full 20-byte address. Distinct from the grant
envelope signer (authority key on `ownerLogId`).

**Forest root R**: a Canopy forest's root authority log id (a UUID, e.g. the
`E2E_UNIVOCITY_GENESIS_LOG_ID_ES256` fixture). A forest is bound to a contract by
**key**: the root creation grant's `grantData` must equal `bootstrapConfig()`.
The forest root R is **not** required to equal the contract's on-chain root log
id.

**On-chain root authority log**: the contract sets `rootLogId` to the `logId` of
the **first** `publishCheckpoint` (whose grant must carry `grantData ==
bootstrapConfig()`), then enforces exactly one root per instance
(ImutableUnivocity `_applyInclusionGrant`: `rootLogId = logId`). It is an
ordinary 32-byte id chosen by that first checkpoint — the contract has no
hardcoded root id. Today the ES256/KS256 bootstrap scripts seed it with the
synthetic `keccak256("authority-log")` rather than a Canopy forest root R UUID,
so the on-chain `rootLogId` currently equals no forest R.

**Chain binding = key binding**: arbor's register-grant root check
(`verifyGrantChainDepth`) accepts a root grant when `grantData ==
bootstrapConfig()` against an anchored genesis — i.e. it binds by bootstrap key,
not by matching the on-chain `rootLogId`. Whether the on-chain root should
instead be a forest root R UUID (vs the synthetic bootstrap id) is an open
question — see devdocs ADR follow-up.

## Related

- [CONTEXT.md stub](../../CONTEXT.md) → devdocs glossary
- [grants.md](../grants.md) — grant workflow overview
