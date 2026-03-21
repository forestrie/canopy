# Plan 0007: Grant type and grant-commitment alignment with Univocity

**Status:** DRAFT  
**Date:** 2025-03-14  
**Related:** [Plan 0005](plan-0005-grant-receipt-unified-resolve.md), [Plan 0006](plan-0006-idtimestamp-separate-parameter.md), [Subplan 01](plan-0004-log-bootstraping/subplan-01-shared-encoding-univocity-alignment.md), [ARC-0001](../arc-0001-grant-verification.md)

## 1. Problem

1. **Grant type vs on-chain PublishGrant**  
   The contract type **PublishGrant** has: `logId`, `grant` (flags), `request`, `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`. Only those fields are first-class on-chain. **`grantData`** is the right place for opaque committed bytes (e.g. bootstrap ES256 public key); wire map keys 7–8 (`signer`, `kind`) and protocol fields (`version`, `exp`, `nbf`) are **not** part of `PublishGrant` and are modeled separately as **GrantAssembly** (hydration / transparent-statement payload). TypeScript **`Grant`** matches the chain shape; **`GrantAssembly`** extends it for API/auth and CBOR keys 1–8.

   Idtimestamp is a separate parameter everywhere; it is not part of the grant or grantData.

2. **“Inner hash” naming**  
   The module `inner-hash.ts` and names like `innerHashFromGrant` / `innerHashToHex` are misleading. The smart contracts specify a **grant commitment** (content hash) and a **leaf commitment** (idtimestamp + that hash). There is no first-class “inner hash” concept in the API; the 32-byte value is the **grant commitment hash** (the hash of the grant commitment preimage). TypeScript should:
   - Represent the required data for the commitment in a type-safe way.
   - Implement the same hashing scheme as the contracts and name it after the contract concept (grant commitment).

## 2. Contract alignment (reference)

From Plan 0005 and brainstorm-0001:

- **PublishGrant** (`univocity src/interfaces/types.sol`): `logId`, `grant` (flags), `request` (not in leaf), `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`. No idtimestamp. **grantData** is provided by the contracts for the purpose of encoding extra off-chain data that should be committed by the hash; version, signer, kind, exp, nbf are all appropriate to encode or represent in that context.
- **Leaf commitment** (`LibLogState.sol`):  
  `inner = sha256(abi.encodePacked(g.logId, g.grant, g.maxHeight, g.minGrowth, g.ownerLogId, g.grantData))`  
  `leaf = sha256(abi.encodePacked(grantIDTimestampBe, inner))`.  
  So the 32-byte value we use as ContentHash for grant-sequencing is the hash of the **grant commitment preimage** (logId, grant, maxHeight, minGrowth, ownerLogId, grantData). The contract does not name this “inner” in the public API; it is the content hash that feeds into the leaf. We call it **grant commitment hash** in canopy. **`request`** is on `PublishGrant` but omitted from this preimage (per contract).

## 3. Goals

- **`Grant`** in TypeScript aligns with **PublishGrant** only: `logId`, `grant` (8-byte wire flags), optional `request`, `maxHeight`, `minGrowth`, `ownerLogId`, `grantData` (bytes or structured **GrantData** union normalized before hashing).
- **`GrantAssembly`** is the type for decoded/encoded transparent-statement payload and staging: **`Grant` fields plus** `version`, `signer`, `kind`, optional `exp`/`nbf`. **`GrantRequest`** aliases **`GrantAssembly`** (POST body, CBOR keys 1–8).
- **`GrantData`**: union of shapes that serialize to bytes in `grantData`; **`grantDataToBytes`** feeds commitment and CBOR encoding.
- **Grant commitment**: preimage (logId, grant, maxHeight, minGrowth, ownerLogId, grantData — no idtimestamp) and SHA-256; module `grant-commitment.ts`.

## 4. Proposed changes

### 4.1 Grant, GrantAssembly, and grantData

- **`Grant`**: chain shape only (`PublishGrant`). Field `grant` replaces the old name `grantFlags` (same 8-byte wire bitmap). Optional `request?: bigint` for contract parity (not in commitment preimage).
- **`GrantAssembly`**: `Grant` + `version`, `signer`, `kind`, optional `exp`/`nbf`. Codec encode/decode of CBOR keys 1–8 uses **`GrantAssembly`**; **`GrantResult.grant`** is **`GrantAssembly`**.
- **`GrantData`**: `Uint8Array | { kind: "es256-xy"; xy: Uint8Array }` (extensible). **`grantData`** on **`Grant`** may be raw bytes or **`GrantData`** until normalized.
- **GrantRequest** = **GrantAssembly**.
- Commitment hashing accepts **`Grant`** (or **`GrantAssembly`**, which extends **`Grant`**); **`grantDataToBytes`** is applied inside **`grantCommitmentHashFromGrant`**.

### 4.2 Grant commitment (rename and clarify)

- **Rename** `inner-hash.ts` → `grant-commitment.ts`.
- **Rename** functions and exports:
  - `innerPreimage` → `grantCommitmentPreimage` (or keep internal; preimage of the commitment).
  - `innerHashFromGrant` → `grantCommitmentHashFromGrant` (async, returns 32-byte hash of preimage; matches contract “inner”).
  - `innerHashToHex` → `grantCommitmentHashToHex` (hex encoding of that hash for status URL, storage path, etc.).
- **Document** in the module: preimage = logId || grant32 || maxHeight_be || minGrowth_be || ownerLogId || grantData (bytes); hash = SHA-256(preimage); idtimestamp only at leaf (see `leaf-commitment.ts`).
- **Call sites**: update all imports and call sites (register-grant, receipt-verify, verify-grant-inclusion, grant-sequencing, leaf-commitment, tests) to use the new names. Public API exports from `grant/index.ts`: `grantCommitmentHashFromGrant`, `grantCommitmentHashToHex` (and remove old names).

### 4.3 Leaf commitment

- **leaf-commitment.ts**: parameter/comments currently say “inner”; change to “grant commitment hash” (the 32-byte content hash). Signature can stay `univocityLeafHash(idtimestamp, grantCommitmentHash)` with a short comment that the second argument is the grant commitment hash (contract “inner”).

### 4.4 Codec and encoding

- **codec.ts**: encode/decode **GrantAssembly**; **grantData** bytes for CBOR via **`grantDataToBytes`** when input is structured.
- **grant.ts** / **grant-assembly.ts** / **grant-data.ts**: split types per responsibility.
- **@canopy/encoding** `GrantRequestInput`: property **`grant`** (was `grantFlags`); wire key 3 unchanged.

### 4.5 Storage path and kinds

- Storage path uses **kind**; that remains on GrantRequest. Functions that need kind (e.g. `grantStoragePath(encodedGrantBytes, kind)`) continue to take GrantRequest or kind explicitly.

### 4.6 Backward compatibility and migration

- Export **aliases** during a transition if desired: e.g. `innerHashFromGrant` = `grantCommitmentHashFromGrant`, `innerHashToHex` = `grantCommitmentHashToHex`, and deprecate the old names; then remove in a follow-up. Or break once and update all call sites (preferred if scope is small).

## 5. Implementation steps (ordered)

| Step | Action | Notes |
|------|--------|--------|
| 5.1 | In **grant.ts**, add JSDoc on **Grant** and **grantData**: grantData is the contract field for off-chain data committed by the hash; version, signer, kind, exp, nbf are appropriate for that. Note that signer may be promoted to the formal contract type in a future update. Keep GrantRequest as alias of Grant. | No removal of fields; documentation only. |
| 5.2 | **Codec**: no structural type change. Ensure decoded/encoded type remains Grant (full wire shape). | All wire decode/encode stays keys 1–8. |
| 5.3 | Rename **inner-hash.ts** → **grant-commitment.ts**; rename innerPreimage → grantCommitmentPreimage (internal), innerHashFromGrant → grantCommitmentHashFromGrant, innerHashToHex → grantCommitmentHashToHex. Update JSDoc to refer to “grant commitment” and contract formula. | grantCommitmentPreimage takes Grant; preimage uses logId, grantFlags, maxHeight, minGrowth, ownerLogId, grantData. |
| 5.4 | Update **leaf-commitment.ts** and **receipt-verify.ts** to use grantCommitmentHashFromGrant and to refer to “grant commitment hash” in comments. | No signature change beyond parameter naming in comments. |
| 5.5 | Update all **call sites**: register-grant, verify-grant-inclusion, grant-sequencing, tests (inner-hash.test → grant-commitment.test), grant/index.ts exports. | Use new module and function names. |
| 5.6 | Remove deprecated aliases (if added) or old inner-hash.ts after migration. Add a short **alignment** note in docs (or in grant.ts): Grant ↔ PublishGrant + grantData role; signer future promotion. | Single source of truth for types and naming. |

## 6. Why CBOR key constants (e.g. `CBOR_KEY_GRANT_FLAGS`) are still required

The CBOR key constants are the **wire key numbers** for the grant map (keys 1–8). Key 3 remains the Solidity **`grant`** (flags) field; the constant name may still say `GRANT_FLAGS` in code for historical clarity.

## 7. Summary

- **`Grant`** = **PublishGrant** shape in TypeScript. **`GrantAssembly`** = wire/staging (**Grant** + version, signer, kind, exp/nbf). **`GrantRequest`** = **`GrantAssembly`**. **`GrantData`** = union normalized by **`grantDataToBytes`** for hashing and CBOR.
- **Grant commitment** = SHA-256(logId || grant_32 || maxHeight_be || minGrowth_be || ownerLogId || grantData); see `grant-commitment.ts`.
- Wire bytes are unchanged; only type names and field rename **`grantFlags` → `grant`** (TypeScript) align naming with the contract.
