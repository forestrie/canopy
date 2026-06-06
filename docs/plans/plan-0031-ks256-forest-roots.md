# Plan 0031: KS256 forest roots (Workstream D)

**Status**: DRAFT  
**Date**: 2026-06-06  
**Related**:
- [plan-0028](plan-0028-forest-genesis-chain-binding.md) (genesis v1 EC2)
- [plan-0023](plan-0023-coordinator-public-root.md) (coordinator trust root)
- [plan-0029](plan-0029-delegate-grant-validation-to-univocity.md)
- [univocity plan-0029](../../univocity/docs/plans/plan-0029-eip-compatible-ks256-signers.md)

## Goal

Enable **KS256** (-65799) forest bootstrap / trust roots alongside existing **ES256**
(-7) paths: genesis v2 `(genesisAlg, bootstrapKey)`, v2 trust-root CBOR
`(alg: int, key: bstr)`, Keccak Sig_structure verification with ecrecover /
ERC-1271, and coordinator BYOK public-root upload for 20-byte Safe addresses.

## Scope (Workstream D — canopy)

### Genesis v2 (`packages/apps/canopy-api/src/forest/`)

| Label | Key | Wire |
|-------|-----|------|
| `genesis-version` | -68009 | `2` for alg/key writes |
| `genesisAlg` | -68014 | int: `-7` (ES256) or `-65799` (KS256) |
| `bootstrapKey` | -68015 | bstr: 64 (x‖y) or 20 (address) |
| `bootstrap-logid` | -68010 | bstr 32 (server-stamped) |
| `univocity-addr` | -68011 | bstr 20 |
| `chain-id` | -68013 | tstr EIP-155 |

- **POST** accepts v1 (EC2 COSE_Key) or v2 (alg/key).
- **Read** accepts v0, v1 EC2, and v2 via `genesis-cache.ts`.

### Trust-root CBOR

- **v2**: `{ logId, alg: int, key: bstr }` from univocity / coordinator.
- **v1 fallback**: `{ logId, alg: "ES256", x, y }`.
- Decoded in `decode-trust-root-cbor.ts`; clients in `trust-root-client.ts`.

### KS256 verify (`grant/ks256-verify.ts`)

- `encodeSigStructure` → `keccak_256` (via `@noble/hashes/sha3`).
- EOA: `@noble/curves/secp256k1` ecrecover → 20-byte address compare.
- Contract: `eth_getCode` + ERC-1271 `isValidSignature` via `eth_call` (viem ABI encode).
- RPC from `UNIVOCITY_CONTRACT_RPC_URL` threaded through receipt authority resolver.

### Delegation verify

- When custody root is KS256 (`ParsedKs256RootKey`), delegation cert verify uses
  `verifyKs256DelegationCert` instead of Web Crypto ES256.

### Delegation coordinator

- `POST /api/logs/{logId}/public-root`: `alg` int + base64 `key` (20 or 64 bytes).
- Legacy ES256 JSON `{ alg: "ES256", x, y }` unchanged.
- GET CBOR emits v2 `{ alg, key }` for int alg roots.
- `validate-byok-material.ts`: KS256 root path for delegation certificate verify.

## Dependencies

- `@noble/hashes`, `@noble/curves` in `@canopy/api` (already present) and
  `@canopy/delegation-coordinator` (added).
- `viem` for ERC-1271 ABI encode in workers.

## Out of scope (other workstreams)

- Univocity Go service KS256 public-root emission (arbor).
- On-chain KS256-root delegation hook in `_Univocity.sol`.
- Receipt Sign1 verify with KS256 protected header (checkpoints still ES256-delegated).

## Verification

```sh
pnpm install
pnpm -r --filter './packages/**' typecheck
pnpm --filter @canopy/api test
pnpm --filter @canopy/delegation-coordinator test
```

KS256 chain-binding e2e against the Base Sepolia Safe deployment at
`0x7A4E8ad88D6Df29FEBEc0d546d148Ed4bea8Cb94` (genesis v2 POST + on-chain
`bootstrapConfig()` read). Set **`E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP`** and
**`E2E_UNIVOCITY_GENESIS_LOG_ID_KS256`** in Doppler **`canopy/dev`** (sync to GitHub
**`dev`** vars for CI). ES256 chain-binding uses
**`E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP`** / **`E2E_UNIVOCITY_GENESIS_LOG_ID_ES256`**
(see [univocity plan-0032](../../univocity/docs/plans/plan-0032-es256-immutable-deploy.md)).

```sh
pnpm install
pnpm -r --filter './packages/**' typecheck
pnpm --filter @canopy/api test
pnpm --filter @canopy/delegation-coordinator test

# KS256 genesis chain-binding (deployed stack + Doppler):
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/univocity-genesis-ks256-chain-binding.spec.ts
```
