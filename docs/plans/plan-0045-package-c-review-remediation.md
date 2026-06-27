# Plan 0045 — Package C delegation console review remediation

**Status:** DRAFT  
**Date:** 2026-06-27  
**Related:**

- [FOR-115](https://linear.app/forestrie/issue/FOR-115) Package C umbrella (mandate, merged)
- [mandate PR #17](https://github.com/forestrie/mandate/pull/17) (`572b8e4…28465b9`)
- [mandate plan-0044](https://github.com/forestrie/mandate/blob/main/docs/plans/plan-0044-package-c-delegation-console.md)
- [arc-checkpoint-delegation-isolation.md](../arc/arc-checkpoint-delegation-isolation.md)
- [plan-0021](plan-0021-delegation-coordinator-apis.md)
- [plan-0044 Package D e2e](plan-0044-package-d-cross-stack-e2e.md)
- [FOR-200](https://linear.app/forestrie/issue/FOR-200) deferred audit endpoint

---

## Review scope summary

**Cross-repo review (canopy-primary).** Package C shipped in **mandate**
([PR #17](https://github.com/forestrie/mandate/pull/17)); no canopy code changed.
Reviewed mandate diff `572b8e4…28465b9` against delegation-coordinator contracts,
[arc-checkpoint-delegation-isolation](../arc/arc-checkpoint-delegation-isolation.md),
and arbor sealer lease verification (`delegation_lease_verify.go`).

Graphite: N/A (canopy on untracked `docs/plan-0040-onboard-backlog`; mandate merged
to `main`).

**Verdict:** Package C is merge-worthy. Mandate UI now submits verifiable KS256 COSE
Sign1 certificates with agent parity tests. Remaining gaps are coordinator
defense-in-depth and cross-stack e2e confidence (Package D).

---

## Remediation items

### R1 — Coordinator rejects submit-body timestamp drift (Medium)

| Field | Value |
| ----- | ----- |
| Severity | Medium |
| Repo | canopy |
| Branch | New stack branch above `main` |

**Problem:** `handlePutCertificate` persists `body.issuedAt` / `body.expiresAt` into
`delegation_certificates` without checking they match
`parseDelegationCertificate(certificate)`. Sealer uses issue-response
`expiresAt` (from DB columns) for lease TTL checks while also parsing COSE
payload expiry. A malicious submitter could store inflated DB expiry while the
cert expires sooner — confusing operators and risking premature sealer deny.

Mandate UI fixed client-side (FOR-198); coordinator should enforce.

**Tasks**

1. In `validateByokDelegationCertificate` or `handlePutCertificate`, require
   `body.issuedAt === info.issuedAt` and `body.expiresAt === info.expiresAt`.
2. Unit test: valid cert + mismatched body timestamps → 400.
3. Unit test: aligned timestamps → 200 (existing happy path).

**Acceptance criteria**

- Mismatched body vs COSE payload timestamps rejected with 400.
- `pnpm -r --filter @canopy/delegation-coordinator test` green.

---

### R2 — Package D e2e: browser KS256 cert submit path (Medium)

| Field | Value |
| ----- | ----- |
| Severity | Medium |
| Repo | canopy (+ mandate opt-in spec) |
| Branch | `robin/for-202-e2e-prerequisites` or child of FOR-201 stack |

**Problem:** C1 acceptance listed optional gated live submit to dev coordinator.
No Playwright/system test proves mandate BFF → coordinator certificate route for
KS256 roots end-to-end.

**Tasks**

1. Extend Package D cross-stack plan (FOR-201) with a stretch or system spec:
   pending webhook → mandate-style cert assembly (agent or headless signer) →
   POST `/api/delegations/certificate` → sealer issue returns 200 CBOR.
2. Document Doppler env for `KS256_RPC_URL` on coordinator dev.

**Acceptance criteria**

- Opt-in system test documents env vars and passes on dev when enabled.
- Linked from FOR-201 / plan-0044 Package D.

---

### R3 — Mandate: remove legacy `buildSubmitCertificateBody` 86400 default (Low)

| Field | Value |
| ----- | ----- |
| Severity | Low |
| Repo | mandate |
| Branch | Post-merge chore PR |

**Problem:** `buildSubmitCertificateBody` retains independent 24h TTL default;
production path uses `buildSubmitCertificateBodyFromCert`. Legacy helper risks
future misuse.

**Tasks**

1. Delete `buildSubmitCertificateBody` if no callers remain, or mark
   `@deprecated` and narrow tests to cert-parsed path only.

**Acceptance criteria**

- `signAndSubmit` and tests use cert-parsed timestamps only.

---

## Branch assignment

| Item | Assignment |
| ---- | ---------- |
| R1 | **New canopy branch** `robin/for-205-coordinator-cert-timestamp-bind` ([FOR-205](https://linear.app/forestrie/issue/FOR-205)) |
| R2 | **Package D stack** (FOR-201 children); see [plan-0044](plan-0044-package-d-cross-stack-e2e.md) |
| R3 | **Mandate post-merge** chore; not on current canopy branches |

---

## Deferred (Low)

- **N+1 enabled fetches:** `refreshEnabledForLogs` calls per unique log on each
  pending load; acceptable for M4 scale; batch endpoint is FOR-200+ territory.
- **localStorage row history:** mandate-scoped by design; durable history is
  FOR-200.
- **Gated Privy live sign test:** manual QA only unless Package D adds headless
  wallet harness.
