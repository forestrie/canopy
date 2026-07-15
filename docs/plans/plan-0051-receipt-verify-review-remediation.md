# Plan 0051 — Receipt verify stack review remediation

**Status:** DRAFT  
**Date:** 2026-07-04  
**Related:** [plan-0030 offline receipt gates](https://github.com/forestrie/devdocs/blob/main/plans/plan-0030-offline-receipt-verification-gates.md),
[ADR-0045](https://github.com/forestrie/devdocs/blob/main/adr/adr-0045-receipt-verify-offline-contract.md),
FOR-285, FOR-288, FOR-289, FOR-287  
**Reviewed:** `main` @ `b178c16` (PR [#85](https://github.com/forestrie/canopy/pull/85);
stack includes [#84](https://github.com/forestrie/canopy/pull/84))

---

## 1. Scope summary

| Item | Value |
|------|-------|
| Repo | canopy (+ system-testing #34 for T3 tracer) |
| Graphite stack | No — two sequential squash merges |
| Spec | devdocs plan-0030 §2, ADR-0045 |
| PRs | canopy #84 (package+CLI), #85 (api refactor+T1); system-testing #34 (T3 subprocess) |

Review persona: distributed systems + applied crypto (offline SCITT receipt verify).

---

## 2. Remediation items

### R1 — Complete api → package dedup for verify paths

| Field | Value |
|-------|-------|
| ID | R1 |
| Severity | **Medium** |
| Branch | `robin/for-285-verify-path-dedup` (follow-up) |
| Location | `packages/apps/canopy-api/src/grant/receipt-verify.ts`, `@forestrie/receipt-verify` |

**Finding:** FOR-285 merged `parseReceipt` only. `verifyReceiptInclusion`,
`verifyReceiptInclusionFromParsed`, and leaf/commitment helpers remain
duplicated vs `@forestrie/receipt-verify`. Divergence risk for detached-peak
regression (ADR-0045 / plan-0030 AC).

**Tasks**

1. Extract shared `verifySignatureAndInclusion` (or delegate
   `verifyReceiptInclusionFromParsed` offline-equivalent stages to package with
   injected verify keys).
2. Keep Workers-only `RootVerifyKey` / `es256ReceiptVerifyKeys` resolution in
   api; pass `CryptoKey[]` into package.
3. Preserve detached-peak rule: signature failure must not report tautological
   inclusion-ok when payload is nil.

**Acceptance**

- `hydrate-receipt-from-mmrs.test.ts` and `multi-leaf-delegated-receipt.test.ts`
  unchanged behaviour.
- Package unit tests cover api wrapper equivalence for at least one golden
  vector.

---

### R2 — Restore detached-peak regression comments in api

| Field | Value |
|-------|-------|
| ID | R2 |
| Severity | **Low** |
| Branch | Same as R1 or docs-only PR |
| Location | `receipt-verify.ts` `verifyReceiptInclusionFromParsed` |

**Finding:** PR #85 removed inline comments documenting why detached-peak
signature failure must not return `signature-failed-inclusion-ok`. Logic
preserved; audit trail weakened.

**Acceptance:** Comments restored (or pointer to ADR-0045 § negative controls).

---

### R3 — T1 offline assert runs in CI system tier

| Field | Value |
|-------|-------|
| ID | R3 |
| Severity | **Medium** |
| Branch | canopy CI / `tests-system.yml` follow-up |
| Location | `grants-bootstrap.spec.ts`, canopy `tests-system.yml` |

**Finding:** FOR-288 assertion added to Playwright **system** project; PR #85
checklist item unchecked. Unit tests do not exercise live-stack offline verify.

**Acceptance**

- `grants-bootstrap` system job green on T2/T3 lane with Univocity provision.
- Failure message includes `stage`/`reason` from `verifyGrantReceiptOffline`.

---

### R4 — Move `forestrieGrantBase64ToBytes` to e2e-kit

| Field | Value |
|-------|-------|
| ID | R4 |
| Severity | **Low** |
| Branch | `@forestrie/canopy-e2e-kit` 0.4.0 slice (FOR-286) |
| Location | `grants-bootstrap.spec.ts`, T3 specs |

**Finding:** Duplicated url-safe grant base64 decode in T1 spec; kit already has
pattern in `bootstrap-grant-flow.ts` (private).

**Acceptance:** Single exported helper; T1 + system-testing specs import it.

---

### R5 — Golden `.cbor` fixtures (FOR-289 remainder)

| Field | Value |
|-------|-------|
| ID | R5 |
| Severity | **Medium** |
| Branch | `robin/for-289-golden-vectors` |
| Location | `packages/libs/receipt-verify/test/fixtures/` |

**Finding:** T0 tests use programmatic fixture only; plan-0030 AC requires
committed golden vectors from hydrate test export.

**Acceptance:** Vitest loads `.cbor` files; CI deterministic without re-sign.

---

### R6 — T3 orchestrator CLI wiring

| Field | Value |
|-------|-------|
| ID | R6 |
| Severity | **Medium** |
| Branch | system-testing / release-orchestrator (sibling repo) |
| Location | `system-e2e-run.yml`, `offline-grant-receipt-verification.spec.ts` |

**Finding:** T3 spec skips without `CANOPY_VERIFY_GRANT_RECEIPT_SCRIPT`.
Merged #34 does not wire canopy checkout or script path in orchestrator dispatch.

**Acceptance:** Lane A T3 runs spec green (not skip) after canopy main includes
CLI; tamper negative fails.

---

## 3. Deferred (Low)

- **L1:** `parseReceipt` returns `receiptCbor` in package but api type surface
  documents `coseSign1` only — align ADR-0045 §4.1 or trim export.
- **L2:** Remove `Co-Authored-By` from agent commits (commit conventions).

---

## 4. Branch assignment

| Item | Where |
|------|-------|
| R1, R2, R5 | canopy follow-up branches |
| R3 | canopy CI + deployed stack |
| R4, FOR-286 | canopy e2e-kit publish |
| R6, FOR-287 | system-testing + orchestrator |
| FOR-290 | canopy docs (`scitt-hackathon.md`) |
