---
id: 2607-07
status: implemented
created: 2026-07-28
refs:
  - FOR-497
  - FOR-485
  - devdocs/adr/adr-0059-instance-root-fee-accounts.md (D6, D8)
  - devdocs/arc/arc-0015-x402-settlement-architecture.md
  - canopy PR #195
---

# Plan 2607-07 — FOR-497 account-read review remediation

**Status:** IMPLEMENTED · **Created:** 2026-07-28

> Delivery: R1, R2, R3, R5 landed on the PR #195 branch (2026-07-28).
> R4 re-triaged to [FOR-498](https://linear.app/forestrie/issue/FOR-498)
> (security, unparented, deliberately deferred). Flip to COMPLETE when
> #195 merges.

## Context

`/review-changes` findings for canopy [PR #195](https://github.com/forestrie/canopy/pull/195)
(FOR-497: attestation-authed fee-account read,
`GET /api/payments/accounts/{univocityInstanceId}`). Review scope:
`origin/main...mandate-1` (`be4d40e`, `f1e2d6a`), single branch, no Graphite
stack. Worst finding: **Medium**. The route's cryptographic design upholds
ADR-0059 D8 (chain-anchored trust, alg agility, signed-content-type domain
separation — tested in both replay directions); the gaps are operational.

## Goal

Close the Medium finding before (or with) the PR #195 merge; record the Lows
with owners so they are deliberate deferrals, not omissions.

## Remediation items

### R1 (Medium — fix on current branch): rate-limit the unauthenticated probe path

`handleAccountRead` runs the chain probe (`verifyUnivocityDeployment`,
2 × `eth_call` per gate-cache miss) _before_ signature verification —
necessarily, since the trust anchor is chain-declared. The gate cache only
bounds repeats for the **same** instance; an attacker sweeping distinct
deployed addresses gets two metered RPC calls per address with no valid
signature required. The onboarding create route fronts the identical shape
with `ONBOARD_CREATE_RATE_LIMITER` (per-IP, `onboard-create-guard.ts`); the
account read has no equivalent, so FOR-497's "rate-limit the verify path"
requirement is only partially met by cache reuse.

**Fix:** apply the same per-IP limiter (reuse the existing
`ONBOARD_CREATE_RATE_LIMITER` binding — one knob, same failure mode — or a
sibling `ACCOUNT_READ_RATE_LIMITER` if read QPS must not contend with
onboarding) as the first step of `handleAccountRead`.

**Acceptance:** a rate-limited request returns 429 before any `eth_call`;
unit test stubs the limiter and asserts fetch is never called; existing
tests unaffected.

### R2 (Low — current branch or fast-follow): preserve the registrationBlock tri-state

The route collapses `registrationBlock ?? null`, conflating the DO's
`null` ("genesis observation failed, ops repair pending") with absent
("legacy record, observe-forward"). If the FOR-485 console renders `null`
as "repair pending", legacy accounts are mislabeled. Either omit the field
when absent (pass the tri-state through) or document the collapse in the
route doc and FOR-485 handoff.

### R3 (Low — docs): acknowledge the owner-read exception in the D6 comment

`receivables.ts` still asserts flatly "there is **no** canopy-api binding:
the data plane never reads entitlement" (ADR-0059 D6 / plan-2607-02 D4).
Both remain literally true (HTTP not a DO binding; data-plane admission
untouched), but FOR-497 adds the first canopy-fronted entitlement read.
Amend the comment (and, if ADR-0059 gets a consequences touch-up, one line
there) so the invariant reads "the **data plane** never reads entitlement;
the owner-facing control-plane read goes through the ops HTTP surface" —
preventing both misreading it as violated and silent erosion later.

### R4 (Low — hardening, deferred to FOR-498): dedicated read-domain aud override

The route reuses `ONBOARD_ATTESTATION_AUD` as the accepted-aud override. If
an operator ever points the onboarding override at a ceremony-specific
origin, read attestations for that origin verify too. A dedicated
`ACCOUNT_READ_ATTESTATION_AUD` (defaulting to the onboard value) completes
the domain separation the content types already provide. Defer until any
operator actually diverges the auds.

### R5 (Low — test coverage, deferrable): route-level KS256 + wrong-aud vectors

Route tests exercise ES256 only and cover aud rejection only at the verifier
unit level (shared core is KS256/aud-covered by the onboarding suite). Add a
KS256 route vector and a wrong-aud route vector when touching the file next.

## Deferred / ops notes (no code change)

- **Replay-within-window** is accepted by design (self-contained credential,
  interactive read): producer guidance (FOR-485 console, CLI verb) should
  mint with short windows (60–120 s) and never log the Authorization header.
- **Prod lane config:** `X402_SETTLEMENT_URL` must be set in the prod GitHub
  Environment before the route serves on lane B (it is dev-only today, via
  the metering canary). Fail-closed 503 until then — deliberate.

## Verification

R1 lands with its unit test green in `pnpm --filter @canopy/api test`;
R2/R3 are doc/shape changes verified by review; `pnpm check` + typecheck
stay green. Plan flips to `complete` when R1–R3 are merged and R4/R5 are
either done or re-triaged.
