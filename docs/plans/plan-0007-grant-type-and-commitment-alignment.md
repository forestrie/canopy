# Plan 0007: Grant type and grant-commitment alignment with Univocity

**Status:** DRAFT  
**Date:** 2025-03-14  
**Related:** [Plan 0005](plan-0005-grant-receipt-unified-resolve.md), [Plan 0006](plan-0006-idtimestamp-separate-parameter.md), [Subplan 01](plan-0004-log-bootstraping/subplan-01-shared-encoding-univocity-alignment.md), [ARC-0001](../arc-0001-grant-verification.md)

## 1. Problem

1. **Grant type vs on-chain PublishGrant**  
   The contract type **PublishGrant** has: `logId`, `grant` (flags), `request`, `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`. The contract provides **grantData** for the purpose of encoding extra off-chain data that should be committed by the hash. So version, signer, kind, exp, nbf are all **appropriate** as off-chain data that is committed via grantData (or carried on the wire and reflected in what gets committed). The TypeScript type and wire shape should make this role of grantData clear and keep version, signer, kind, exp, nbf as first-class fields where they are needed for API and auth, while the commitment preimage on the contract remains logId, grant, maxHeight, minGrowth, ownerLogId, grantData (with grantData as the opaque blob that commits that extra data).

   **Future contract change:** A future contracts update may **promote signer to the formal contract-level type** (a first-class field on PublishGrant). The TypeScript shape should keep signer as a first-class field now so we remain aligned when that change lands.

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
  So the 32-byte value we use as ContentHash for grant-sequencing is the hash of the **grant commitment preimage** (logId, grant, maxHeight, minGrowth, ownerLogId, grantData). The contract does not name this “inner” in the public API; it is the content hash that feeds into the leaf. We will call it **grant commitment hash** in canopy. A future contract update may promote **signer** to a formal field on PublishGrant; the TypeScript type keeps signer first-class so we stay aligned.

## 3. Goals

- **Grant** in TypeScript aligns with the on-chain PublishGrant and the wire format: logId, ownerLogId, grantFlags, maxHeight, minGrowth, grantData, signer, kind, and optionally version, exp, nbf. **grantData** is the contract field for encoding extra off-chain data that is committed by the hash; version, signer, kind, exp, nbf are all appropriate for that purpose (carried on the wire and reflected in what is committed via grantData). **Signer** is kept as a first-class field so that when a future contract update promotes signer to the formal PublishGrant type, the TypeScript shape is already aligned.
- **GrantRequest** can remain an alias of Grant or the same wire shape (POST body, decoded CBOR keys 1–8); no need to strip version, signer, kind, exp, nbf from the main type.
- **Grant commitment** is the single name for the contract-specified content hash: preimage (logId, grant, maxHeight, minGrowth, ownerLogId, grantData — no idtimestamp) and its SHA-256. Naming and module reflect “grant commitment” instead of “inner hash”; implementation continues to match the contract formula.

## 4. Proposed changes

### 4.1 Grant type and grantData

- **Grant** interface: keep the full wire shape that matches CBOR keys 1–8 and supports API/auth:
  - `logId`, `ownerLogId`, `grantFlags`, `maxHeight?`, `minGrowth?`, `grantData`, `signer`, `kind`, and optionally `version`, `exp`, `nbf`.
- **grantData** is the contract field for encoding extra off-chain data that is committed by the hash. Version, signer, kind, exp, nbf are all **appropriate** for that purpose: they are carried as first-class fields on the wire and in TypeScript, and the committed value (preimage) includes grantData as the opaque blob that carries or reflects that data. No need to remove these from the Grant type.
- **Signer** stays a first-class field. A future contract update may promote signer to the formal PublishGrant type; keeping it first-class in TypeScript ensures we remain aligned when that change lands.
- **GrantRequest** can remain an alias of Grant (same shape) for the POST body and decoded wire form.
- Codec and encoding continue to encode/decode the full wire shape (keys 1–8). Commitment hashing uses the same Grant type; the preimage formula (logId, grant, maxHeight, minGrowth, ownerLogId, grantData) is unchanged and matches the contract.

### 4.2 Grant commitment (rename and clarify)

- **Rename** `inner-hash.ts` → `grant-commitment.ts`.
- **Rename** functions and exports:
  - `innerPreimage` → `grantCommitmentPreimage` (or keep internal; preimage of the commitment).
  - `innerHashFromGrant` → `grantCommitmentHashFromGrant` (async, returns 32-byte hash of preimage; matches contract “inner”).
  - `innerHashToHex` → `grantCommitmentHashToHex` (hex encoding of that hash for status URL, storage path, etc.).
- **Document** in the module: this implements the grant commitment formula specified by the smart contracts (preimage = logId || grantFlags32 || maxHeight_be || minGrowth_be || ownerLogId || grantData; hash = SHA-256(preimage)); idtimestamp is not part of the grant commitment and is combined only at leaf level (see `leaf-commitment.ts`).
- **Call sites**: update all imports and call sites (register-grant, receipt-verify, verify-grant-inclusion, grant-sequencing, leaf-commitment, tests) to use the new names. Public API exports from `grant/index.ts`: `grantCommitmentHashFromGrant`, `grantCommitmentHashToHex` (and remove old names).

### 4.3 Leaf commitment

- **leaf-commitment.ts**: parameter/comments currently say “inner”; change to “grant commitment hash” (the 32-byte content hash). Signature can stay `univocityLeafHash(idtimestamp, grantCommitmentHash)` with a short comment that the second argument is the grant commitment hash (contract “inner”).

### 4.4 Codec and encoding

- **codec.ts** (canopy-api): continues to build the full grant object (version, logId, ownerLogId, grantFlags, maxHeight, minGrowth, grantData, signer, kind). Decoded type is **Grant**; encode accepts **Grant**. No structural change to the type; add JSDoc on **grantData** that it is the contract field for off-chain committed data (version, signer, kind, exp, nbf are appropriate for that).
- **grant.ts**: **Grant** keeps all current fields (including version, signer, kind, exp, nbf). Add a short comment that grantData is for off-chain data committed by the hash and that signer may be promoted to the contract type in a future update. **GrantRequest** remains an alias of Grant.
- **@canopy/encoding** `GrantRequestInput`: no change to wire; already aligned.

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

## 6. Why keys like CBOR_KEY_GRANT_FLAGS are still required

The CBOR key constants (e.g. `CBOR_KEY_GRANT_FLAGS`) are the **wire key numbers** for the grant map (keys 1–8). They are required for correct encode/decode and for maintaining a single definition of the wire format. They were previously reported as “unused” only because the code used literal numbers instead of the constants; after rationalisation they are used. The **Grant** type carries the full wire shape; the codec encodes/decodes it. So the constants remain necessary and used.

## 7. Summary

- **grantData** is the contract field for encoding extra off-chain data that is committed by the hash. **Version, signer, kind, exp, nbf** are all appropriate for that purpose; we keep them as first-class fields on **Grant**. **Signer** may be promoted to the formal contract type in a future update; keeping it first-class keeps TypeScript aligned.
- **Grant** = full wire/API type (logId, ownerLogId, grantFlags, maxHeight?, minGrowth?, grantData, signer, kind, and optionally version, exp, nbf). **GrantRequest** = alias of Grant.
- **Grant commitment** = contract-specified content hash: preimage (logId, grant, maxHeight, minGrowth, ownerLogId, grantData; no idtimestamp) + SHA-256; implemented in `grant-commitment.ts` with `grantCommitmentHashFromGrant` and `grantCommitmentHashToHex`.
- Codec and encoding continue to work with Grant. Commitment hashing uses the same Grant type; the preimage formula matches the contract. This aligns TypeScript with the overall architecture and the Univocity contracts while keeping the wire format and API behaviour unchanged.
