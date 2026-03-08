# Statement encoding, decoding, signing and verification

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Plan 0001](plans/plan-0001-register-grant-and-grant-auth-phase.md), [register-statement](api/register-statement.md), [register-grant](api/register-grant.md)

This document maps all places in the canopy repo that encode, decode, sign, or verify **statements** (COSE Sign1 used at register-statement), and distinguishes **pre–register-grant** behaviour from **register-grant** additions. It does not cover delegation certificates or SCITT receipts (separate COSE uses).

---

## 1. Summary

| Concern | Pre–register-grant | Register-grant addition |
|--------|---------------------|--------------------------|
| **Statement format** | COSE Sign1 (4 elements: protected, unprotected, payload, signature) | Same; **kid in protected header** (label 4) required for grant auth |
| **Auth at /entries** | (Previously x402 or other) | Grant location + **signer match**: kid from COSE must equal grant.signer |
| **Cryptographic verify** | Not done at register-statement (payload accepted as-is) | Still **not** done; we only **extract kid** and compare to grant.signer (no signature verification) |
| **Encoding** | Multiple ad‑hoc encoders (scripts, k6, tests) | Same encoders extended for kid; one **decoder** in API |

---

## 2. Decoding and “verification” (API side)

All decoding and signer-checking for **incoming statements** at register-statement lives in the **canopy-api** package.

### 2.1 Single source of truth (decode + signer check)

| Location | Purpose | When added |
|----------|---------|------------|
| `packages/apps/canopy-api/src/scrapi/grant-auth.ts` | **getSignerFromCoseSign1**: decode COSE Sign1, read protected header, return kid (label 4) as `Uint8Array`. **signerMatchesGrant**: byte-equal compare statement kid vs grant.signer. | **Register-grant** |
| `packages/apps/canopy-api/src/scrapi/register-signed-statement.ts` | **validateCoseSign1Structure**: minimal structural check (array of 4, first byte 0x84/0x98). Calls **getSignerFromCoseSign1** and **signerMatchesGrant** before enqueue. | **Register-grant** (statement handling was refactored to require grant; see Plan 0001) |

So for “decode statement and verify signer binding” the **single source of truth** is:

- **Decode COSE / read kid**: `grant-auth.ts` → `getSignerFromCoseSign1`
- **Verify signer vs grant**: `grant-auth.ts` → `signerMatchesGrant`
- **Use in request path**: `register-signed-statement.ts` only

No other code in canopy decodes **statement** COSE for auth.

### 2.2 Receipts and other COSE (not statements)

These decode or build COSE Sign1 but **not** for register-statement signer verification:

| Location | Purpose | When |
|----------|---------|------|
| `packages/apps/canopy-api/src/scrapi/resolve-receipt.ts` | Decode **checkpoint** and **peak receipts** (COSE_Sign1), unwrap tags, assemble response. | **Pre–register-grant** |
| `packages/apps/delegation-signer/src/cose/sign1.ts` | **Build** delegation certificates (COSE Sign1 with real ECDSA signature). | **Pre–register-grant** |
| `scripts/decode-receipt.mjs` | CLI to decode a SCITT receipt file (COSE_Sign1). | **Pre–register-grant** |

---

## 3. Encoding (who produces statement COSE)

There is **no single shared encoder** for statement COSE. Multiple encoders exist for different environments; they must all produce the same layout the API expects.

### 3.1 Register-grant–era encoders (kid in protected, signature as bstr)

These are the encoders that target the **current** register-statement behaviour (kid in protected header; signature must be CBOR bstr).

| Location | Role | Used by | Notes |
|----------|------|--------|-------|
| `perf/k6/canopy-api/lib/cose.js` | **encodeCoseSign1WithKid(payload, kid)**. Builds COSE Sign1 with protected = map { 4: kid }, signature = **encodeBstr(64 bytes)**. | k6 perf scenario `write-constant-arrival.js` | **Primary** perf path; bundled by esbuild. |
| `perf/k6/canopy-api/lib/cbor.js` | **encodeBstr**, **encodeArrayHeader**, **encodeEmptyMap**, etc. | `cose.js` (k6) | k6 has no Node/cbor-x; minimal CBOR only. |
| `packages/apps/canopy-api/test/cose-sign1-k6-encoder.ts` | **encodeCoseSign1WithKid** (TypeScript) matching k6 layout byte-for-byte. | Unit tests only | Ensures API decoder and tests use same format as k6. |

So for **register-grant statement encoding**:

- **Production/perf**: `perf/k6/canopy-api/lib/cose.js` (+ `cbor.js`) is the source of truth for k6.
- **Tests**: `test/cose-sign1-k6-encoder.ts` is the test-side mirror; tests should use it (or cbor-x with the same structure) so they stay aligned with k6 and the API.

### 3.2 Pre–register-grant or dual-use encoders

| Location | Role | Used by | Notes |
|----------|------|--------|-------|
| `scripts/gen-cose-sign1.mjs` | Builds COSE Sign1 with **empty** protected (0x40), empty signature (0x40). No kid. | CLI / ad‑hoc testing | **Pre–register-grant**; will **not** pass current grant auth (no kid). |
| `perf/k6/canopy-api/lib/cose.js` | **encodeCoseSign1(payload)** (no kid), **encodeCoseSign1String**, **generateUniquePayloadBytes**. | k6 (e.g. if a scenario didn’t use grant flow) | Same file as 3.1; “no kid” variants are legacy. |

### 3.3 Tests that build statement COSE by hand

| Location | How they build COSE | Intended to match |
|----------|----------------------|-------------------|
| `packages/apps/canopy-api/test/scrapi-flow.test.ts` | `encodeCbor([protectedHeader, new Map(), payload, new Uint8Array(64)])` with `protectedHeader = encodeCbor(new Map([[4, signerKid]]))`. | Grant flow (kid in protected). **Signature**: 64 raw bytes in array; cbor-x encodes as bstr when value is Uint8Array, so **correct**. |
| `packages/tests/canopy-api/tests/api.spec.ts` | `cbor.encode([protectedHeader, new Map(), Buffer.from("Hello"), new Uint8Array(64)])` with `protectedHeader = cbor.encode(new Map([[4, signerKid]])`. | Grant flow. Uses `cbor` (not cbor-x); must ensure fourth element is bstr(64) (e.g. Uint8Array) so API decoder consumes full buffer. |
| `packages/apps/canopy-api/test/api.test.ts` | **Skipped** test: raw bytes `0x84 0x40 0xa0 ... 0x40` (empty protected, empty signature). | Old behaviour (no grant); would fail grant auth today. |
| `packages/apps/canopy-api/test/grant-auth-cose.test.ts` | Uses **cose-sign1-k6-encoder** and cbor-x-built COSE. | Explicit roundtrip and signer-match tests. |
| `packages/apps/canopy-api/test/grant-pool-signer-chain.test.ts` | Uses **cose-sign1-k6-encoder** + grant-pool CBOR encoder. | Full chain: grant request → kid → COSE → getSignerFromCoseSign1 → signerMatchesGrant. |

---

## 4. Grant signer and pool (register-grant only)

These are not statement COSE encoders but define the **signer** that must match the statement kid.

| Location | Role | When added |
|----------|------|------------|
| `perf/scripts/generate-grant-pool.mjs` | Creates grants via API; writes **grant-pool.json** with `signer` (hex) and `grants[]`. Same signer used as kid in k6 COSE. | **Register-grant** |
| `perf/k6/canopy-api/scenarios/write-constant-arrival.js` | **signerToBytes(pool.signer)**: hex (or base64) → 32 bytes. Passes to **encodeCoseSign1WithKid(payload, signerBytes)**. | **Register-grant** |
| `packages/apps/canopy-api/test/grant-pool-cbor-encoder.ts` | Encodes grant-request CBOR (keys 3,4,5,8,9,10) like script; **hexToSignerBytes** / **signerBytesToHex** for pool ↔ k6. | **Register-grant** (tests) |

---

## 5. Single source of truth and coverage

### 5.1 Decode and signer verification (API)

- **Single source of truth**: `packages/apps/canopy-api/src/scrapi/grant-auth.ts`
  - `getSignerFromCoseSign1(coseSign1Bytes)`
  - `signerMatchesGrant(statementSigner, grantSigner)`
- **Coverage**:
  - `grant-auth-cose.test.ts`: roundtrip, signer match, null/invalid COSE, empty protected, cbor-x-built COSE.
  - `grant-pool-signer-chain.test.ts`: grant request CBOR → kid → COSE → decode → signer match; pool hex path.
  - `scrapi-flow.test.ts`: E2E with grant in R2 and COSE with kid.
  - Playwright `api.spec.ts`: “registers a COSE statement (grant flow)” with cbor-encoded COSE.

### 5.2 Statement encoding

- **No single shared implementation**: k6 (JS), tests (TS mirror + cbor-x), and scripts (gen-cose-sign1.mjs) each have their own.
- **Contract**: All encoders used for **grant-based** register-statement must produce:
  - COSE Sign1 = 4-element CBOR array.
  - Element 0: protected = bstr containing CBOR map with **label 4 (kid)** = bstr(signer bytes).
  - Element 3: signature = **bstr** (e.g. 64 bytes), not raw bytes.
- **Strong coverage**:
  - **grant-auth-cose.test.ts** + **cose-sign1-k6-encoder.ts**: k6-compatible encoder vs API decoder.
  - **grant-pool-signer-chain.test.ts**: full chain including pool hex and grant request CBOR.
  - CI step in perf workflow: bundle must contain `signatureBstr` (signature as bstr).

### 5.3 Gaps / recommendations

1. **scrapi-flow.test.ts** and **api.spec.ts** build COSE with cbor-x / cbor; ensure the fourth element is always a **bstr** (e.g. `Uint8Array(64)`), not raw bytes, so the contract is explicit and consistent with k6.
2. **gen-cose-sign1.mjs**: Either document as “legacy, no kid” or add a mode that outputs COSE with kid so CLI testing matches grant flow.
3. **api.test.ts** skipped “should register a COSE statement”: uses empty protected; update or remove so it doesn’t imply support for non-grant flow.
4. **Single encoder for tests**: Prefer **cose-sign1-k6-encoder.ts** (and/or cbor-x with the same structure) everywhere in canopy-api tests so all tests share one encoding contract.

---

## 6. Quick reference: file roles

| File | Encode statement | Decode statement | Signer / grant check | Pre / Post register-grant |
|------|------------------|-------------------|----------------------|----------------------------|
| `canopy-api/src/scrapi/grant-auth.ts` | No | Yes (kid only) | Yes (signerMatchesGrant) | Register-grant |
| `canopy-api/src/scrapi/register-signed-statement.ts` | No | Uses grant-auth | Calls getSignerFromCoseSign1 + signerMatchesGrant | Register-grant |
| `perf/k6/canopy-api/lib/cose.js` | Yes (with/without kid) | No | No | Both (kid path = register-grant) |
| `canopy-api/test/cose-sign1-k6-encoder.ts` | Yes (k6 mirror) | No | No | Register-grant |
| `scripts/gen-cose-sign1.mjs` | Yes (no kid) | No | No | Pre–register-grant |
| `canopy-api/src/scrapi/resolve-receipt.ts` | No | Yes (receipts) | No | Pre–register-grant |
| `delegation-signer/src/cose/sign1.ts` | Yes (delegation cert) | No | N/A | Pre–register-grant |
