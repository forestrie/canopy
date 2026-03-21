# Statement encoding, decoding, signing and verification

**Status**: DRAFT  
**Date**: 2026-03-19  
**Related**: [Plan 0001](plans/plan-0001-register-grant-and-grant-auth-phase.md), [Plan 0005](plans/plan-0005-grant-receipt-unified-resolve.md), [ARC-0001](arc-0001-grant-verification.md), [register-statement](api/register-statement.md), [register-grant](api/register-grant.md)

This document maps all places in the canopy repo that encode, decode, sign, or verify **statements** (COSE Sign1 used at register-statement), and distinguishes **pre–register-grant** behaviour from **register-grant** additions. It does not cover delegation certificates or SCITT receipts (separate COSE uses).

---

## 1. Summary

| Concern                  | Pre–register-grant                                                  | Register-grant addition                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Statement format**     | COSE Sign1 (4 elements: protected, unprotected, payload, signature) | Same; **kid in protected header** (label 4) required for grant auth                                                                      |
| **Auth at /entries**     | (Previously x402 or other)                                          | Forestrie-Grant **v0** in **Authorization: Forestrie-Grant**; **`isStatementRegistrationGrant`**; **kid** must equal **`statementSignerBindingBytes(grant)`** (**committed `grantData`** only; [ARC-0001 §6](arc-0001-grant-verification.md)) |
| **Cryptographic verify** | Not done at register-statement (payload accepted as-is)             | **In scope** (Plan 0003): verify COSE Sign1 with public key in `@canopy/encoding`; API still uses kid extraction + signer match for auth |
| **Encoding**             | Multiple ad‑hoc encoders (scripts, k6, tests)                       | **Canonical** encoder in `@canopy/encoding`; k6 JS mirror; one **decoder** in API                                                        |

---

## 2. Decoding and “verification” (API side)

All decoding and signer-checking for **incoming statements** at register-statement lives in the **canopy-api** package.

### 2.1 Single source of truth (decode + signer check)

| Location                                                           | Purpose                                                                                                                                                                               | When added                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/apps/canopy-api/src/scrapi/grant-auth.ts`                | **getSignerFromCoseSign1**: decode COSE Sign1, read protected header, return kid (label 4) as `Uint8Array`. **signerMatchesGrant**: byte-equal compare statement kid vs binding bytes (from **`statementSignerBindingBytes`** in register-statement path). | **Register-grant**                                                                     |
| `packages/apps/canopy-api/src/scrapi/register-signed-statement.ts` | **validateCoseSign1Structure**: minimal structural check (array of 4, first byte 0x84/0x98). Calls **getSignerFromCoseSign1** and **signerMatchesGrant** before enqueue.              | **Register-grant** (statement handling was refactored to require grant; see Plan 0001) |

So for “decode statement and verify signer binding” the **single source of truth** is:

- **Decode COSE / read kid**: `grant-auth.ts` → `getSignerFromCoseSign1`
- **Verify signer vs grant**: `grant-auth.ts` → `signerMatchesGrant`
- **Use in request path**: `register-signed-statement.ts` only

No other code in canopy decodes **statement** COSE for auth.

### 2.2 Receipts and other COSE (not statements)

These decode or build COSE Sign1 but **not** for register-statement signer verification:

| Location                                                 | Purpose                                                                                        | When                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| `packages/apps/canopy-api/src/scrapi/resolve-receipt.ts` | Decode **checkpoint** and **peak receipts** (COSE_Sign1), unwrap tags, assemble response.      | **Pre–register-grant** |
| `packages/apps/delegation-signer/src/cose/sign1.ts`      | **Build** delegation certificates (COSE Sign1 with real ECDSA signature).                      | **Pre–register-grant** |
| `scripts/decode-receipt.ts` (@canopy/scripts)            | CLI to decode a SCITT receipt file (COSE_Sign1); uses `decodeCoseSign1` from @canopy/encoding. | **Pre–register-grant** |

---

## 3. Encoding (who produces statement COSE)

**Canonical encoder** (Plan 0003): `packages/shared/encoding` (`@canopy/encoding`) — **encodeCoseSign1Statement(payload, kid, signature)** in a single file; signature must be CBOR bstr. Tests and any Node/TS caller use this. k6 cannot use Node/TS, so it keeps a **JS mirror** that must match the same contract (byte-for-byte conformance where possible).

### 3.1 Register-grant–era encoders (kid in protected, signature as bstr)

| Location                                                 | Role                                                                                                                                                       | Used by                                            | Notes                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| **`packages/shared/encoding`**                           | **encodeCoseSign1Statement(payload, kid, signature)**. Canonical TS encoder; produces 4-element array, protected = bstr(map { 4: kid }), signature = bstr. | canopy-api tests (via re-export), scrapi-flow.test | **Single source of truth** for TS.                         |
| `packages/apps/canopy-api/test/cose-sign1-k6-encoder.ts` | Re-exports **encodeCoseSign1WithKid** using canonical encoder with 64-byte placeholder.                                                                    | Unit tests                                         | Same bytes as k6 for same input (placeholder sig).         |
| `perf/k6/canopy-api/lib/cose.js`                         | **encodeCoseSign1WithKid(payload, kid)**. JS mirror for k6 (no Node/TS).                                                                                   | k6 perf scenario `write-constant-arrival.js`       | **Only** JS implementation; must conform to same contract. |
| `perf/k6/canopy-api/lib/cbor.js`                         | **encodeBstr**, **encodeArrayHeader**, **encodeEmptyMap**, etc.                                                                                            | `cose.js` (k6)                                     | k6 has no Node/cbor-x; minimal CBOR only.                  |

So for **register-grant statement encoding**:

- **Canonical (TS)**: `@canopy/encoding` → `encodeCoseSign1Statement`; tests use it (directly or via cose-sign1-k6-encoder).
- **k6**: `perf/k6/canopy-api/lib/cose.js` is the only JS encoder; conformance test ensures same input → same output where applicable.

### 3.2 Pre–register-grant or dual-use encoders

| Location                                      | Role                                                                                                                     | Used by                                       | Notes                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------- |
| `scripts/gen-cose-sign1.ts` (@canopy/scripts) | Builds COSE Sign1 with **empty** protected (0x40), empty signature; uses `encodeCborBstr` from @canopy/encoding. No kid. | CLI / ad‑hoc testing                          | **Pre–register-grant**; will **not** pass current grant auth (no kid). |
| `perf/k6/canopy-api/lib/cose.js`              | **encodeCoseSign1(payload)** (no kid), **encodeCoseSign1String**, **generateUniquePayloadBytes**.                        | k6 (e.g. if a scenario didn’t use grant flow) | Same file as 3.1; “no kid” variants are legacy.                        |

### 3.3 Tests that build statement COSE

| Location                                                        | How they build COSE                                                                            | Intended to match                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `packages/apps/canopy-api/test/scrapi-flow.test.ts`             | **encodeCoseSign1Statement** from `@canopy/encoding` (payload, kid, 64-byte placeholder).      | Grant flow.                                |
| `packages/tests/canopy-api/tests/api.spec.ts`                   | `cbor.encode([...])` with kid in protected.                                                    | Grant flow; ensure fourth element is bstr. |
| `packages/apps/canopy-api/test/api.test.ts`                     | **Skipped** test: empty protected (legacy).                                                    | Would fail grant auth.                     |
| `packages/apps/canopy-api/test/grant-auth-cose.test.ts`         | **cose-sign1-k6-encoder** (re-exports canonical) and cbor-x-built COSE for compatibility test. | Roundtrip, signer match, crypto verify.    |
| `packages/apps/canopy-api/test/grant-pool-signer-chain.test.ts` | **cose-sign1-k6-encoder** + grant-pool CBOR (from @canopy/encoding).                           | Full chain.                                |

---

## 4. Grant commitment preimage vs COSE headers

Canopy **does** own the Forestrie-Grant **wire v0** payload schema (CBOR map keys **1–6** only), so decoding that payload is expected. From the decoded **`Grant`**, the API **already derives** the **grant commitment preimage** and hashes it—see `packages/apps/canopy-api/src/grant/grant-commitment.ts` (`grantCommitmentPreimage` → SHA-256). Callers send the **signed transparent statement** whose **payload** is that grant map; they do **not** send the raw preimage bytes separately, because the preimage is a **fixed-layout concat** (padded `logId`, 32-byte flags, `maxHeight`/`minGrowth` BE, `ownerLogId`, `grantData`) that **differs** from the wire CBOR encoding. There is no obstacle to “referencing” the preimage **internally**: it is **recomputed** whenever the chain-shaped fields are present.

**What the preimage does *not* contain** (by [Plan 0007](plans/plan-0007-grant-type-and-commitment-alignment.md) / contract rules):

- **`request`** (`GC_*` codes) — omitted from the commitment preimage.
- **Wire v0:** no **`version`**, **`signer`** (CBOR 7), **`kind`** (CBOR 8), **`exp`**, or **`nbf`** on the grant map; decoders **reject** keys **7** and **8**. **`grantData`** is the issuer attestation for statement-signer binding.
- **Idtimestamp** — only combined at **leaf** commitment time, never in the grant preimage.
- **Receipt** (MMR proof) — not part of **`PublishGrant`** at all.

So the preimage is **not** a universal serialization of “everything about this grant artifact,” and it **cannot** replace metadata that lives **outside** that hash.

**Transparent-statement COSE labels** ([Plan 0005 §9.4](plans/plan-0005-grant-receipt-unified-resolve.md)) therefore stay **non-redundant**:

| Label / use | Role | Why preimage / payload alone is insufficient |
|---------------|------|-----------------------------------------------|
| **Unprotected −65537** | **Idtimestamp** (8-byte bstr) after sequencing | Value does not exist when the grant payload is first signed; must not be in the signed payload per SCITT-style semantics ([Plan 0005](plans/plan-0005-grant-receipt-unified-resolve.md)). |
| **Unprotected 396** | **Receipt** (inclusion proof map) | Produced **after** the leaf exists; not in grant preimage or `PublishGrant`. |
| **Protected header label 4 (`kid`) — transparency entry** | Standard COSE: identifies key for the **entry** Sign1 | The **entry** is a **different** COSE object from the **grant** transparent statement. **`grantData`** (in the grant preimage) authorizes **which** keys may sign entries; **`kid`** on the entry states **which** key **did** sign—both are needed for the binding check ([ARC-0001 §6](arc-0001-grant-verification.md)). |

**If the hash alone were the API input:** Verifiers could not recover preimage or fields without the full grant bytes (preimage resistance). So production flows keep the **decodable payload** (or equivalent) plus **post-sequencing** headers.

---

## 5. Grant signer and pool (register-grant only)

These are not statement COSE encoders but define the **signer** that must match the statement kid.

| Location                                                   | Role                                                                                                                                                     | When added                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `perf/scripts/generate-grant-pool.ts` (@canopy/perf)       | Bootstrap + **Forestrie-Grant** register flow; writes **grant-pool.json** with **`signer`** hex (binding from **`grantData`** key 6, pool metadata only) and **`grants[]`** with **`grantBase64`**. k6 uses that hex as COSE **kid**. | **Perf / load test**       |
| `perf/k6/canopy-api/scenarios/write-constant-arrival.js`   | **signerToBytes(pool.signer)**: hex (or base64) → 32 bytes. Passes to **encodeCoseSign1WithKid(payload, signerBytes)**.                                  | **Register-grant**         |
| `packages/apps/canopy-api/test/grant-pool-cbor-encoder.ts` | Re-exports **encodeGrantRequest** from `@canopy/encoding`; **hexToSignerBytes** / **signerBytesToHex** for pool ↔ k6.                                   | **Register-grant** (tests) |

---

## 6. Single source of truth and coverage

### 6.1 Decode and signer verification (API)

- **Single source of truth**: `packages/apps/canopy-api/src/scrapi/grant-auth.ts`
  - `getSignerFromCoseSign1(coseSign1Bytes)`
  - `signerMatchesGrant(statementSigner, grantSigner)`
- **Coverage**:
  - `grant-auth-cose.test.ts`: roundtrip, signer match, null/invalid COSE, empty protected, cbor-x-built COSE.
  - `grant-pool-signer-chain.test.ts`: grant request CBOR → kid → COSE → decode → signer match; pool hex path.
  - `scrapi-flow.test.ts`: E2E with grant in R2 and COSE with kid.
  - Playwright `api.spec.ts`: “registers a COSE statement (grant flow)” with cbor-encoded COSE.

### 6.2 Statement encoding

- **Canonical implementation**: `@canopy/encoding` — **encodeCoseSign1Statement** (Plan 0003, [ADR-0001](adr-0001-encoding-one-per-artifact.md)).
- **Contract**: COSE Sign1 = 4-element CBOR array; element 0 = protected bstr (map { 4: kid }); element 3 = signature **bstr**.
- **Mirrors**: k6 `perf/k6/canopy-api/lib/cose.js` (only JS encoder); tests use canonical via **cose-sign1-k6-encoder.ts** re-export.
- **Coverage**: grant-auth-cose (roundtrip, signer match, crypto verify), grant-pool-signer-chain (full chain), scrapi-flow (E2E); CI perf bundle check.

### 6.3 Gaps / recommendations

1. **gen-cose-sign1.mjs**: Documented as **legacy** (no kid; does not satisfy current statement contract). Use `@canopy/encoding` for grant flow.
2. **api.test.ts** skipped "should register a COSE statement": uses empty protected; leave skipped or update to use canonical encoder with kid.

---

## 7. Quick reference: file roles

| File                                                 | Encode statement            | Decode statement | Signer / grant check                              | Pre / Post register-grant        |
| ---------------------------------------------------- | --------------------------- | ---------------- | ------------------------------------------------- | -------------------------------- |
| `canopy-api/src/scrapi/grant-auth.ts`                | No                          | Yes (kid only)   | Yes (signerMatchesGrant)                          | Register-grant                   |
| `canopy-api/src/scrapi/register-signed-statement.ts` | No                          | Uses grant-auth  | Calls getSignerFromCoseSign1 + signerMatchesGrant | Register-grant                   |
| `perf/k6/canopy-api/lib/cose.js`                     | Yes (with/without kid)      | No               | No                                                | Both (kid path = register-grant) |
| `canopy-api/test/cose-sign1-k6-encoder.ts`           | Re-exports @canopy/encoding | No               | No                                                | Register-grant                   |
| `packages/shared/encoding`                           | Yes (canonical)             | verifyCoseSign1  | signCoseSign1Statement                            | Register-grant                   |
| `scripts/gen-cose-sign1.ts`                          | Yes (no kid, **legacy**)    | No               | No                                                | Pre–register-grant               |
| `canopy-api/src/scrapi/resolve-receipt.ts`           | No                          | Yes (receipts)   | No                                                | Pre–register-grant               |
| `delegation-signer/src/cose/sign1.ts`                | Yes (delegation cert)       | No               | N/A                                               | Pre–register-grant               |
