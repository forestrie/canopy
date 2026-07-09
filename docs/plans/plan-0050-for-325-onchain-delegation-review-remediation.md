# Plan 0050 — FOR-325 on-chain delegation proof: review remediation

**Status:** IMPLEMENTED · **Date:** 2026-07-09
**Related:** [devdocs plan-2607-10](../../../devdocs/plans/plan-2607-10-byok-onchain-delegation-proof.md),
FOR-325, canopy [#92](https://github.com/forestrie/canopy/pull/92) (merged
`ffabff5`), arbor [#39](https://github.com/forestrie/arbor/pull/39) (open),
arbor-flux [#39](https://github.com/forestrie/arbor-flux/pull/39) (open),
FOR-332

## Scope summary

Review of the BYOK on-chain delegation proof work (KS256 + uniform ES256):
`@forestrie/delegation-cose` on-chain TBS/sign/verify, coordinator
`onchainSignature` validation/storage and `onchainProof` issue responses,
e2e-kit material builders, publisher revert-ABI additions, and the
arbor-flux publisher `LOG_LEVEL` default.

No High findings. The cryptographic invariants check out against the
contract: domain separation (`forestrie.univocity.delegation.v1`),
Sig_structure byte layout (pinned by Go fixtures for both headers), packed
payload ordering, header-by-root-alg dispatch (`extractAlgorithm` gates in
`delegationVerifier.sol`), and low-s normalization (OZ `P256.verify` rejects
`s > N/2`).

## Remediation items

### R1 (Medium, correctness) — bind stored proof to the validating root — DONE

`DelegationStoreDO.onchainProofFromStored` selected the protected header from
`rootAlgForLog(logIdHex32)` **at issue time**, but the signature was
validated against the root **at submission time**. `POST /public-root`
permits overwrite, so a root rotated between submission and issue yielded a
proof whose header/signature cannot verify against the live root.

**Fix landed:** persist `onchain_root_alg` alongside `onchain_signature` at
validation time; on issue, if the stored alg no longer matches the current
public root, omit the proof and `console.warn`. Legacy rows (null alg) fall
back to the live root.

**Acceptance:** unit test — submit cert + onchainSignature under a KS256
root, replace the root with ES256, issue → response omits `onchainProof`
and a warn log records the mismatch. Happy path unchanged.

**Branch:** `robin/for-325-onchain-delegation-remediation` (canopy).

### R2 (Medium, testability) — randomized log ids in coordinator unit tests — DONE

Hard-coded log UUIDs collided across coordinator test files sharing one
workerd runtime.

**Fix landed:** `randomUUID()` per test in `kill-switch`, `webhook-delivery`,
`pending-delegation`, `public-root`, `wallet-challenge`, `onchain-proof`,
and the remaining fixed id in `route-boundary-auth`. Full suite green in 3
consecutive runs (80 tests).

**Branch:** same canopy follow-up branch as R1.

### R3 (Medium, test coverage) — contract acceptance of TS-signed proofs — DONE

**Fix landed:**

- canopy `delegation-cose` exports deterministic vectors via
  `scripts/export-onchain-vectors.mjs` →
  `testdata/onchain-delegation-vectors.json` (both algs); unit tests pin
  the checked-in file still verifies.
- univocity `TsOnchainDelegationVectors.t.sol` drives both vectors through
  `verifyDelegationProofKS256` / `verifyDelegationProofES256` (FOR-332
  branch `robin/for-332-ts-onchain-delegation-vectors`).

**Acceptance:** forge suite passes; canopy vector parity tests pass.

## Deferred (Low) — all landed

- **L1** DONE — `verifyOnchainDelegationSignatureEs256` rejects high-s
  (require already-low-s so "verifies" ⇒ "contract-acceptable").
- **L2** DONE — `verifyOnchainDelegationSignatureKs256` accepts only
  recovery ids `{0, 1}`.
- **L3** DONE — `onchainProofFromStored` / issue path `console.warn` on
  unknown alg, parse failure, and root-alg rotation omit.
- **L4** DONE — arbor #39 (`robin/for-325-publisher-revert-labels`):
  `TestUnivocityErrorsABISelectorsPinned` pins every
  `univocityErrorsABI` fragment to its keccak selector.
