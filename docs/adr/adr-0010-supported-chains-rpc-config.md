# ADR-0010 — Supported chains RPC configuration

**Status:** Accepted (2026-06-27)
**Date:** 2026-06-27
**Related:**
[ADR-0009](adr-0009-self-service-onboard-provisioning.md),
[ADR-0004](adr-0004-ks256-register-statement-binding.md),
[devdocs ADR-0034](../../../devdocs/adr/adr-0034-forest-genesis-chain-binding-required.md),
[arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md)

---

## Context

BYOK and self-service onboarding attach a **per-forest** `(chainId,
univocityAddr)` chain binding (ADR-0034). Deployment-wide
`UNIVOCITY_CONTRACT_ADDRESS` implied a single canonical Univocity contract per
canopy instance. `UNIVOCITY_CONTRACT_RPC_URL` implied one JSON-RPC endpoint for
all chains — insufficient for multi-chain forests and misleading for operators.

## Decision

1. **Remove** `UNIVOCITY_CONTRACT_ADDRESS` and `UNIVOCITY_CONTRACT_RPC_URL`
   from canopy-api worker env.
2. **Add** `SUPPORTED_CHAINS_RPC`: a JSON object mapping decimal EIP-155
   `chainId` strings to **preference-ordered** RPC URL arrays.
3. **Supported chains** (deployment capability) are the keys of that map.
   **Chain binding** (per forest / onboard request) remains `(chainId, addr)`.
4. **Validate** `chainId` against supported keys on onboard create and genesis
   POST (`400` when unsupported).
5. **Route KS256 ERC-1271** verification using the forest genesis
   `chainBinding.chainId` → RPC URL list (failover across URLs).
6. **Env substitution** at deploy time: URLs may contain inline `${env:VAR}`
   tokens (same escape rules as univocity-tools `evaluateOptionValue`). Resolved
   by `apply-runtime-contract.mjs` + Doppler; the Worker receives fully resolved
   JSON (no `process.env` in production).

Canonical template:
`packages/apps/canopy-api/config/supported-chains.jsonc`.

Shared library: `@canopy/chain-rpc` (`parseSupportedChainsRpc`,
`substituteEnvTemplates`, `ethRpcWithFailover`).

## Consequences

- Operators configure **which chains** this canopy accepts and **how** to reach
  them — not which Univocity contract (that stays per registration).
- Doppler / GitHub Environment: set `SUPPORTED_CHAINS_RPC` (or rely on template
  + `ALCHEMY_API_KEY` substitution). Remove legacy `UNIVOCITY_CONTRACT_*` vars.
- `ONBOARD_ALLOWED_CHAIN_ID` removed; supported set replaces single-chain
  allowlist.
- `delegation-coordinator` `KS256_RPC_URL` unchanged (follow-up may adopt
  `@canopy/chain-rpc`).
