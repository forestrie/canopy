# Plan 0003: Consistent encoding, signing and verification support

**Status**: DRAFT  
**Date**: 2026-03-08  
**Related**: [Plan 0001](plan-0001-register-grant-and-grant-auth-phase.md), [arc-statement-cose-encoding](../arc-statement-cose-encoding.md)

---

## 1. Goal

Ensure there is **one implementation per artifact** for encoding (and, where applicable, decoding, signing, and verification). The only acceptable reason for multiple implementations of the same artifact is **tooling restrictions** (e.g. incompatible runtimes or build systems). Where multiple implementations are unavoidable, they must be **minimal**, **documented**, and **aligned by a single contract/spec** with tests that verify conformance.

---

## 2. Purpose and scope

Across tests, performance tests, and the API we have multiple encoders (and some decoders) for the same logical artifacts, including:

- **API request/response content**: CBOR bodies (grant request, register-statement body, problem details).
- **SCITT signed statements**: COSE Sign1 used at register-statement (with or without kid in protected header).
- **Grants**: CBOR encode/decode (grant format, grant request).
- **Problem details**: CBOR problem details (Concise Problem Details).
- **Other COSE**: Delegation certificates (delegation-signer), SCITT receipts (resolve-receipt, decode-receipt script).

Principles:

1. **One implementation per artifact** unless tooling forces otherwise (e.g. k6 cannot use Node/TS; then one canonical spec + minimal second implementation).
2. **One file per primitive; one file per artifact** (e.g. `encode-cose-sign1-statement.ts`), unit-testable in isolation.
3. **Shared primitives**: Common patterns (CBOR bstr, CBOR map with int keys, COSE protected header layout) live in **single-responsibility** modules (e.g. `encode-cbor-bstr.ts`, `encode-cose-protected.ts`), not in a monolithic `utils.ts`.
4. **Same discipline for signing and verification**: One place per “sign” or “verify” concern; shared verification helpers where multiple call sites need the same check.

**In scope**: All of the above — statement COSE, grant (and grant request) CBOR, problem details CBOR, receipt COSE, delegation COSE. Priority: grant request first; refactor statement COSE as needed. **Cryptographic verification** of COSE Sign1 with a public key is in scope (encode → sign → verify).

**Out of scope**: Changing wire format or API contracts.

---

## 3. Current state (summary)

See [arc-statement-cose-encoding](../arc-statement-cose-encoding.md) for the full map. Summary:

| Artifact | Decode / verify | Encode (locations) | Single source? |
|----------|------------------|----------------------|----------------|
| Statement COSE (kid + bstr sig) | `grant-auth.ts`: getSignerFromCoseSign1, signerMatchesGrant | k6 `cose.js`; test `cose-sign1-k6-encoder.ts`; scrapi-flow + api.spec with ad-hoc cbor/cbor-x | No (multiple encoders) |
| Grant CBOR | `grant/codec.ts`: decodeGrant, encodeGrant | Same; grant request in generate-grant-pool.mjs (custom CBOR), tests (cbor-x) | Decode/encode grant: yes. Grant **request** CBOR: no |
| Problem details CBOR | Various (consumers) | cbor-response, delegation-signer problem-details, scripts | No (multiple) |
| Receipt / checkpoint COSE | resolve-receipt.ts, decode-receipt.mjs | N/A (read-only) | Decode only; not consolidated |

---

## 4. Decisions

- **Artifacts and priority**: All in scope — statement COSE, grant (and grant request) CBOR, problem details CBOR, receipt COSE, delegation COSE. **Priority**: (1) Grant request first; (2) refactor statement COSE as needed to achieve that.
- **Shared code**: New **shared package** (e.g. `packages/shared/cose`, `packages/shared/cbor`) consumable by canopy-api, tests, and perf where tooling allows.
- **k6 and spec**: **One canonical spec** (e.g. CDDL or TypeScript types + doc). Two implementations (TS + JS) with **contract tests** that prove byte-for-byte equality for the same inputs (known-answer tests).
- **Module shape**: One file per **primitive**; one file per **artifact** that composes primitives (Option B).
- **Signing and verification**: **Cryptographic verification** of COSE Sign1 with a public key is in scope. Goal: stable encode → sign → verify; verification must use the public key.
- **Rollout**: **Big-bang**; change all call sites in one go; no compatibility layer.
- **Problem details**: Separate implementations are acceptable. They must **re-use common primitives and constants** and a **generic set of interfaces** so callers can use them consistently without duplication.
- **Test keys for COSE Sign1**: Use **well-known public/private key pairs** for unit and conformance tests so results are reproducible. Prefer **RFC 8152 Appendix C** (e.g. C.2.1 Single ECDSA, C.7 COSE Keys) test vectors where they match our algorithm (ES256); otherwise a single in-repo test fixture (e.g. P-256) documented as test-only.

---

## 5. Task order and verification (agent-optimised)

Execute the following steps in order. Each step is **independently verifiable**.

**Dependency note**: Business priority is grant request; we do statement COSE first because the register flow depends on it. Steps 1–2: statement COSE contract and encoders. Steps 3–4: grant request CBOR. Step 5: problem details (shared primitives and interfaces). Steps 6–7: cleanup and docs.

---

### Step 1: Statement COSE — contract and canonical encoder (TS)

**Scope**:

- Define the **statement COSE** wire contract (4-element array; protected = bstr with map { 4: kid }; payload bstr; signature bstr). Document in code and in `docs/` (or extend arc-statement-cose-encoding).
- Add a **single TypeScript encoder** for “statement COSE with kid” (e.g. `encodeCoseSign1Statement(payload: Uint8Array, kid: Uint8Array): Uint8Array`) in the shared package, in a single file. Encoder must produce signature as **CBOR bstr** (not raw bytes).
- Add **unit tests**: round-trip with API decoder (getSignerFromCoseSign1); byte-equality with a known-answer fixture. Use well-known test key pairs (see §4) for signing and verification tests.

**Re-use**: Existing `getSignerFromCoseSign1` and `signerMatchesGrant` in `grant-auth.ts` as the canonical decoder/signer-check.

**Verification**:

- Unit tests: round-trip (encode → getSignerFromCoseSign1 → equals kid; signerMatchesGrant(decoded, kid) true); **byte-equality** with a known-answer fixture.
- Add **cryptographic verification** of the statement signature (verify COSE Sign1 with public key); one place for sign/verify.
- Migrate all tests that build statement COSE to use this encoder (big-bang; no compatibility layer).

---

### Step 2: Statement COSE — k6 conformance to contract

**Scope**:

- Keep the k6 encoder in `perf/k6/canopy-api/lib/cose.js` as the **only** JS implementation (no duplicate elsewhere).
- Add a **conformance test** (known-answer): same payload + kid → TS encoder yields bytes A, k6 yields bytes B; require **byte-for-byte equality** (A = B) per canonical spec.
- Ensure the “Verify COSE signature bstr in bundle” CI step remains (bundle must encode signature as bstr).

**Depends on**: Step 1 (canonical contract and TS encoder).

**Verification**:

- Conformance test passes: same input → TS and k6 encoders produce byte-identical output; TS encode → decode round-trip.
- Perf workflow still passes the signature-bstr bundle check.
- No new ad-hoc statement COSE encoders; tests and perf use Step 1 encoder or k6 only.

---

### Step 3: Grant request CBOR — single encoder and contract

**Scope**:

- Define **grant request** CBOR contract (map with int keys 3,4,5,8,9,10 etc.; values bstr; key 9 = signer). Document.
- Implement **one** grant-request encoder (e.g. `encodeGrantRequest(...): Uint8Array`) in a single file. Use shared CBOR primitives from the shared package. Replace or remove duplicate logic in `generate-grant-pool.mjs` and test helpers (e.g. grant-pool-cbor-encoder.ts) by either (a) calling a shared Node/TS implementation from the script (if the script can import from the repo), or (b) keeping the script’s minimal encoder but adding a **contract test** that script output decodes via API’s parseGrantRequest to the same signer/logId/etc.
- Ensure **decode** path remains single source (already in register-grant.ts + grant/codec).

**Verification**:

- Unit test: encode grant request → parseCborBody + parseGrantRequest → same signer and required fields.
- generate-grant-pool.mjs (and any test) either uses the shared encoder or passes a conformance check against it.

Encoder lives in the shared package; script imports from there where tooling allows.

---

### Step 4: Grant request — perf script and tests alignment

**Scope**:

- If the grant request encoder is in a Node-importable package, **refactor** `perf/scripts/generate-grant-pool.mjs` to use it (and remove duplicate CBOR encoding). Otherwise, keep the script’s encoder but add a **conformance test** (see Step 3) and document the script as the “minimal mirror” for grant request.
- Tests (grant-pool-signer-chain, etc.) use the canonical grant-request encoder or the same contract.

**Depends on**: Step 3.

**Verification**:

- generate-grant-pool.mjs runs successfully in CI; grant pool produced works with k6 (no signer_mismatch attributable to grant request encoding).
- All tests that build grant requests use the single encoder or pass conformance.

---

### Step 5: Problem details CBOR — shared primitives and interfaces

**Scope**:

- Define **problem details** CBOR shape (Concise Problem Details; status, title, detail, optional reason, etc.) and **generic interfaces** for encoding/decoding. Shared **primitives and constants** in the shared package; call sites may keep separate implementations that **re-use** them.
- Provide e.g. `encodeProblemDetailsCbor(problem: ProblemDetail): Uint8Array` (and decode if needed) so callers use the same interfaces without duplication.

**Verification**:

- Unit tests: round-trip or fixture-based; all current problem-detail responses still decode correctly.
- All problem-detail encoders use the shared primitives and interfaces.

---

### Step 6: Remove or deprecate redundant encoders

**Scope**:

- Remove or deprecate any encoder that is **replaced** by Steps 1–5: e.g. ad-hoc COSE in scrapi-flow.test.ts and api.spec.ts (replace with Step 1 encoder); duplicate grant-request encoding in test helpers if Step 3 provides one.
- **gen-cose-sign1.mjs**: Either (a) add a mode that outputs “statement COSE with kid” (and document), or (b) mark as legacy and document that it does not satisfy the current statement contract (no kid).

**Depends on**: Steps 1–4 and 5.

**Verification**:

- No remaining duplicate implementations for the in-scope artifacts except the explicitly allowed “minimal mirror” (k6) and, if applicable, script grant-request encoder with conformance test.
- CI (lint, format, unit tests, perf bundle check) passes.

---

### Step 7: Documentation and acceptance

**Scope**:

- Update [arc-statement-cose-encoding](../arc-statement-cose-encoding.md) (or replace with a single “Encoding and verification” doc) to list **canonical** modules per artifact and where “mirrors” (k6, scripts) exist and how conformance is ensured.
- Add a short **ADR** or plan section that records: (1) one implementation per artifact except tooling mirrors, (2) one file per primitive and per artifact, (3) shared primitives only when reused, (4) signing/verification in one place per concern, (5) cryptographic verification of COSE Sign1 in scope.

**Verification**:

- Doc is linked from this plan and from relevant API docs (register-statement, register-grant).
- Agent run: all steps 1–6 verified; doc updated; no open “TODO: use canonical encoder” left in code for in-scope artifacts.

---

## 6. Acceptance criteria (consolidated)

- [ ] **Statement COSE**: One canonical TS encoder; k6 encoder is the only JS mirror; byte-for-byte conformance test; cryptographic verification with public key; all tests use canonical or k6 (Steps 1–2, 6).
- [ ] **Grant request CBOR**: One encoder and contract; script and tests aligned or conformance tested (Steps 3–4, 6).
- [ ] **Problem details**: Shared primitives and interfaces; all call sites use them (Step 5).
- [ ] **No redundant encoders** for in-scope artifacts; gen-cose-sign1.mjs documented or updated (Step 6).
- [ ] **Docs**: Encoding and verification map updated; decisions recorded (Step 7).

---

## 7. Deferred / out of scope

- **Receipt COSE** and **delegation COSE**: in scope for consolidation (same pattern: canonical spec, shared package, conformance); detailed steps may follow in this plan or a follow-on. **Caution**: Delegation is working (Arbor's signer signatures are accepted); the current implementation is likely correct. Be very careful if changing it. Before any refactor: add or ensure **equivalence tests** exist and pass (e.g. round-trip or compare output to current implementation); only then consider changes. Ideally equivalence tests exist and pass before any change.
- Changing **wire format** or API contracts.

---

## 8. Next step for implementer

**Execute Steps 1–7 in order,** running verification after each step. Decisions are in section 4; this plan is the single source of truth.
