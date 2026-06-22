# Plan 0035: `delegation-cose` library (FOR-94)

**Status:** ACTIVE  
**Date:** 2026-06-21  
**Related:**
- [FOR-94](https://linear.app/forestrie/issue/FOR-94) (M3 — COSE delegation baseline)
- [arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md) (deferred COSE scope)
- [plan-0024](plan-0024-byok-checkpoint-seal-rca.md) (integer-key payload field 5)
- [plan-0031](plan-0031-ks256-forest-roots.md) (KS256 verify semantics)
- [arbor `delegationcert`](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert) (canonical wire shape)
- [plan-0003-encoding](plan-0003-encoding-redux.md) (shared COSE primitives)

## Purpose

Extract the ad-hoc Playwright/coordinator delegation certificate builders and
verifiers into a **framework-agnostic, publishable** TypeScript library at
`packages/libs/delegation-cose`. This is the single source of truth for
**assembly + verify** of Forestrie delegation COSE Sign1 certificates (ES256 and
KS256). It unblocks mandate-agent (FOR-98) and retires duplicate logic spread
across e2e helpers and `validate-byok-material.ts`.

**Parallelism:** Independent of M2 webhook work (FOR-92/93). No coordinator
webhook APIs required. Optional follow-up: coordinator adopts package verify
instead of inlined `validate-byok-material.ts`.

## Canonical spec (do not invent)

Wire format matches arbor `delegationcert`:

| Piece | Rule |
|-------|------|
| Outer | Untagged COSE_Sign1 `[protected_bstr, {}, payload_bstr, signature_bstr]` |
| Protected | int-key map: `1` alg, `3` cty=`application/forestrie.delegation+cbor`, `4` kid |
| ES256 kid | 16-byte `SHA-256(raw P-256 pubkey)[0:16]` |
| KS256 kid | 20-byte Ethereum root signer address |
| Payload | int-key map labels `1,3,4,5,6,7,8,9,10` per Go constants |
| Field `5` | **Inline** int-key COSE_Key map (EC2 P-256), never a nested bstr |
| ES256 sig | 64-byte IEEE P1363 `r‖s`; digest = `SHA-256(Sig_structure)` |
| KS256 sig | 65-byte `r‖s‖v`; digest = `keccak256(Sig_structure)` |
| Sig_structure | `["Signature1", protected, h'', payload]` via `@canopy/encoding` |

Reference implementations today:

- **Build/verify (e2e):** `packages/tests/canopy-api/tests/utils/coordinator-delegation-helpers.ts`
- **Payload field 5 contract:** `delegation-cbor-contract.ts`
- **Coordinator validate:** `packages/apps/delegation-coordinator/src/validate-byok-material.ts`
- **Receipt verify (KS256):** `packages/apps/canopy-api/src/grant/ks256-verify.ts`
- **Go truth:** `arbor/services/pkgs/delegationcert/`

## Package layout

```
packages/libs/delegation-cose/
  package.json          # name: @forestrie/delegation-cose
  src/
    index.ts            # barrel re-export only
    delegation-input.ts
    delegation-tbs.ts   # ToBeSigned result type
    payload-labels.ts   # int label constants
    cose-key.ts         # delegated EC2 COSE_Key build/parse
    encode-int-map.ts   # integer-key CBOR (mapsAsObjects: false)
    build-tbs-es256.ts
    build-tbs-ks256.ts
    assemble-certificate.ts
    verify-es256.ts
    verify-ks256.ts
    parse-certificate.ts
    ks256-verify-hooks.ts   # optional ERC-1271 callbacks (no viem)
  test/
    round-trip-es256.test.ts
    round-trip-ks256.test.ts
    golden-vectors.test.ts
    payload-field-5.test.ts
```

**Workspace:** add `packages/libs/*` to `pnpm-workspace.yaml`.

**Dependencies (allowed):**

- `@canopy/encoding` — `encodeSigStructure` only (shared, not app-internal)
- `cbor-x` — decode + `Encoder({ mapsAsObjects: false })` for int-key maps
- `@noble/curves`, `@noble/hashes` — KS256 ecrecover path

**Forbidden dependencies:** `@canopy/api`, `delegation-coordinator`, Playwright,
`node:crypto` in library source (signing keys passed in via Web Crypto /
callbacks). *Tests* may use `node:crypto` for PEM import fixtures.

## Public API (minimal surface)

Design for **sign externally, assemble locally** (mandate BYOK) and **one-shot
build** (e2e):

```typescript
/** Shared input; logId is 32-char hex (Forestrie log id). */
export interface DelegationInput { ... }

/** Protected + payload bytes + Sig_structure bytes for signing. */
export interface DelegationToBeSigned { ... }

// --- Build ---
export function buildDelegationToBeSignedEs256(input, rootKid: Uint8Array): DelegationToBeSigned
export function buildDelegationToBeSignedKs256(input, rootAddress: Uint8Array): DelegationToBeSigned
export function assembleDelegationCertificate(tbs: DelegationToBeSigned, signature: Uint8Array): Uint8Array

/** Convenience: supply async sign over tbs.sigStructureBytes */
export async function buildDelegationCertificateEs256(input, sign: SignEs256): Promise<Uint8Array>
export async function buildDelegationCertificateKs256(input, sign: SignKs256): Promise<Uint8Array>

// --- Verify ---
export async function verifyDelegationCertificateEs256(
  certificate: Uint8Array,
  rootPublicKey: CryptoKey,
): Promise<boolean>

export function verifyDelegationCertificateKs256(
  certificate: Uint8Array,
  rootSignerAddress: Uint8Array,
  hooks?: Ks256VerifyHooks,  // optional ERC-1271; EOA-only when omitted
): Promise<boolean>

// --- Parse (for coordinator / receipt consumers) ---
export function parseDelegationCertificate(certificate: Uint8Array): CertificateInfo
export function parseDelegatedCoseKeyFromPayload(field5: unknown): ParsedDelegatedKey
```

Keep types **one per file** per repo convention; `index.ts` re-exports.

## Implementation slices (TDD)

Work vertically: one behavior test → minimal code → refactor. Do **not** port all
helpers before the first green test.

### Slice 1 — ES256 round-trip (tracer bullet)

**Behaviors:**

- `buildDelegationToBeSignedEs256` + external Web Crypto sign + `assemble` →
  `verifyDelegationCertificateEs256` returns true.
- Parsed payload: `logId`, `mmrStart`, `mmrEnd`, `issuedAt`, `expiresAt` match
  input.
- Field `5` is inline int-key EC2 map (`kty=2`, `crv=1`, 32-byte x/y).

**Implementation notes:**

- Move integer-key CBOR helper from e2e `cbor-int-key.ts` into package
  `encode-int-map.ts`.
- ES256 kid: match `buildByokDelegationMaterial` (SHA-256 of uncompressed
  P-256, first 16 bytes).
- `delegationId` (payload `10`): 16 random bytes if caller omits.

### Slice 2 — KS256 EOA round-trip

**Behaviors:**

- `buildDelegationCertificateKs256` with secp256k1 EOA key → verify with
  20-byte address.
- Protected alg `-65799`; kid is root address bytes.
- Signature 65 bytes; recovery bit handling matches existing helper
  (`v >= 27` → subtract 27).

**Out of scope for slice 2:** ERC-1271 (add in slice 3).

### Slice 3 — KS256 ERC-1271 verify hooks

**Behaviors:**

- When `hooks.hasContractCode(address)` true, verify delegates to
  `hooks.isValidSignature(address, hash, sig)` instead of ecrecover.
- Port logic from `ks256-verify.ts` / `validate-byok-material.ts` without
  importing `viem` in the library (callers inject RPC-backed hooks).

### Slice 4 — Golden / cross-impl vectors

**Behaviors:**

- Freeze byte fixtures: ES256 + KS256 certs produced by **current**
  `coordinator-delegation-helpers.ts` (capture in test `beforeAll` or check in
  hex fixtures file).
- New package `verify*` accepts old fixtures.
- `assertGoCompatibleDelegatedKeyInCertificate` equivalent lives in package
  (`parseDelegatedCoseKeyFromPayload` throws on string keys / bstr field 5).

Optional stretch (not required for FOR-94): Go test in arbor that loads TS
fixture file — defer unless easy.

### Slice 5 — Adopt in canopy e2e (acceptance)

**Replace** in `coordinator-delegation-helpers.ts`:

- `buildByokDelegationMaterial` → thin wrapper over
  `@forestrie/delegation-cose`
- `buildKs256BootstrapDelegationMaterial` → thin wrapper
- `verifyByokDelegationCertificate` → delegate to package
- `verifyKs256BootstrapDelegationCertificate` → delegate to package

**Delete or merge:**

- `delegation-cbor-contract.ts` → package `parseDelegatedCoseKeyFromPayload`
- Duplicate parse constants in helpers

**Keep in e2e helpers (out of library scope):** coordinator HTTP upload/fetch,
custodian POST, PEM import, ephemeral key generation — orchestration only.

### Slice 6 — Coordinator adoption (recommended, same PR if small)

Refactor `validate-byok-material.ts` to call
`verifyDelegationCertificateEs256` / `verifyDelegationCertificateKs256` +
`parseDelegatedCoseKeyFromPayload`. Removes third copy of verify logic.

`canopy-api` `ks256-verify.ts` **may** delegate KS256 delegation-cert branch to
package in a follow-up (receipt path has broader KS256 surface); not blocking
FOR-94 acceptance.

## Out of scope

- On-chain delegation proof shape (univocity ADR-0006) — publisher follow-up
- mandate-agent adoption — FOR-98 / Mandate project
- npm publish workflow — package is publishable-shaped (`exports`, no private
  apps deps) but registry release is later
- Changing arbor Go `delegationcert` or Custodian issuance
- Statement / receipt / grant COSE (separate encoding workstream)
- Replacing mandate `ks256-payload.ts` stub (FOR-98; note its protected header
  placeholder is **wrong** — new library supersedes that approach)

## Verification

```sh
pnpm install
pnpm --filter @forestrie/delegation-cose test
pnpm --filter @forestrie/delegation-cose typecheck
pnpm run check
pnpm -r --filter './packages/**' typecheck
pnpm --filter @canopy/api-e2e test:e2e:system -- tests/system/coordinator-delegation-issuance.spec.ts
pnpm --filter @canopy/api-e2e test:e2e:system -- tests/coordinator/coordinator-byok-material.spec.ts
```

Existing `byok-delegation-cbor.test.ts` must stay green after helper refactor.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| CBOR map key encoding drift vs Go | Golden vectors from current green e2e; integer-key encoder only |
| Web Crypto unavailable in some Node tests | Vitest with `webcrypto` global; sign callbacks in tests |
| ERC-1271 coupling | Hooks interface; viem stays in canopy-api/coordinator callers |
| Scope creep into receipt verify | Library = delegation **certificate** only |

## Acceptance mapping (FOR-94)

| Criterion | Slice |
|-----------|-------|
| Unit tests ES256 assemble+verify round-trip | 1 |
| Unit tests KS256 assemble+verify round-trip | 2–3 |
| Cross-impl vector check | 4 |
| canopy e2e uses package; ad-hoc helper removed | 5 |
| Framework-agnostic / no app deps | package layout + dependency rules |

## Suggested branch

`feat/delegation-cose` — can land independently while FOR-92/93 proceed on
`main` or parallel branches; merge conflicts likely only in
`validate-byok-material.ts` if both touch coordinator (coordinate or do slice 6
after M2 lands).
