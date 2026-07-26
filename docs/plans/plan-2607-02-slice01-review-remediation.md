---
id: 2607-02
status: draft
created: 2026-07-26
refs: [ADR-0059, FOR-475]
---

# Plan 2607-02 — slice-01 (univocityInstanceId) review remediation

**Status:** DRAFT · **Date:** 2026-07-26
**Related:** [PR #176](https://github.com/forestrie/canopy/pull/176),
[devdocs plan-2607-43 slice 01](../../../devdocs/plans/plan-2607-43-instance-root-fee-accounts/01-identity-and-registry.md),
[devdocs ADR-0059](../../../devdocs/adr/adr-0059-instance-root-fee-accounts.md),
[FOR-475](https://linear.app/forestrie/issue/FOR-475)

Review of PR #176 (canonical `univocityInstanceId`, genesis uniqueness claim,
admission policy, coordinator migration, naming gate). Two High findings block
merge; both fixes are small. Findings F1–F9 below; R-items carry the fixes.

## Findings summary

| ID | Sev | Finding |
| -- | --- | ------- |
| F1 | High | Genesis order is genesis-bytes → **token claim** → instance claim: every instance-claim 409 first consumes the presented onboard token, deterministically burning a possibly *paid* credential bound to an R that can never complete (`handle-forest-request.ts`). Plan slice 01 specified index-claim first. |
| F2 | High | Coordinator boot migration rewrites `instance_webhooks.univocity_instance_id` (**primary key**) with an unguarded UPDATE; a coexisting canonical row for the same instance → SQLITE_CONSTRAINT thrown from the DO **constructor** → crash-looping shard, and since `instance_webhooks` replicates to every shard, **all** shards wedge — signing routes and issuance included (`delegation-store.ts:626-654`). |
| F3 | Med | `PUT /api/logs/{logId}/webhook` with both `univocityInstanceId` and `instanceKey` set to different values silently binds the former; must 400 on mismatch (`put-webhook.ts:57-59`). |
| F4 | Med | No release mechanism for a chain-binding claim exists (no route, no script, no documented ops procedure); break-glass tokens carry no chainBinding so can claim **any** address, and the paid path's deployment probe deliberately does not prove contract control — a mistaken or hostile claim is permanent. |
| F5 | Med | The compat shim covers the deprecated field **name** but not the legacy **value form**; in the coordinator-first deploy window an old canopy-api's forward gets 400 → genesis-with-webhookUrl 503s. "Deploy order does not matter" holds only api-first. |
| F6 | Low | Auto-approved requests are labelled `admittedBy: "ops"` though no operator vetted them — overstates vetting for the credit-floor lever ADR-0059 hangs on this field. |
| F7 | Low | `ONBOARD_ADMISSION=paid` is behaviorally identical to `either`; unknown values silently fall back to `either`. |
| F8 | Low | Claim CAS atomicity assumption undocumented at call site; conflict fallback can produce `claimedBy: ""`. |
| F9 | Low | Naming gate: no self-test; `git ls-files` sees tracked files only; broad allowlist prefixes (`…/test/`, `docs/`). |

Also recorded (design notes, no action here): the 409 detail names the
claiming R to any token holder — an accepted contract→R enumeration oracle;
`LIKE 'eip155:%'` is case-insensitive in SQLite; the migration's third-format
skip (`eip155:{chainId}:{40hex}` without `0x`) is silent — subsumed by R2's
scan-broadening.

## Remediation items

### R1 (F1) — claim before consume, with compensation

In `handleForestRequest` onboard mode, run `claimUnivocityInstance` **between**
the token↔binding check and `claimOnboardTokenForestRCas`. This is safe against
free claim-planting because `resolveGenesisAuth` already 403s a token consumed
for a different R before any write. Residual interleaving (same token, two
concurrent requests for different Rs and different bindings): the token-claim
loser leaves an orphan instance claim — add a **best-effort claim rollback**
(read claim, delete when value == own rUuid) on token-claim failure, with R4's
release route as the backstop.

Acceptance: 409 path leaves the presented token unconsumed and reusable (test
asserts second token's record after conflict); losing-R retry keeps returning
409, not 500; token-claim-conflict path rolls its instance claim back.

### R2 (F2) — collision-safe, non-fatal migration rewrite

In `rewriteLegacyUnivocityInstanceIds`: (a) select candidates by "not
canonical" using the shared validator instead of `NOT LIKE 'eip155:%'`
(also fixes the silent third-format and case-prefix skips); (b) for
`instance_webhooks`, when the canonical target row already exists, DELETE the
legacy row and `console.warn` (the canonical row is newer by construction);
(c) wrap the per-row rewrite in try/catch so no data shape can ever throw out
of the DO constructor — warn and continue.

Acceptance: seeded legacy+canonical twin rows boot cleanly with the canonical
row surviving; seeded third-format row is converted (or warned, never
silently skipped); migration test suite still green.

### R3 (F3) — reject dual-field mismatch

400 when both fields are present with different values; deprecation warning
fires whenever the legacy field is used, even alongside the new one.
Acceptance: mismatch test; equal-values test still 200.

### R4 (F4) — claim release for ops

Ops-token-gated `DELETE /api/payments/chain-bindings/{univocityInstanceId}`
releasing the claim (and returning what it released); wire
`readUnivocityInstanceClaim` into a GET alongside it. One paragraph of ops
runbook: when to release (squat, abandoned R, mistaken claim) and that
`Initialized` events are the eventual reconciliation check. Note the
break-glass-token squat window in the route doc.
Acceptance: release + re-claim e2e; unauthenticated → 401.

### R5 (F5) — value-form shim on the coordinator

For the one-cycle window, `put-webhook.ts` converts a legacy-form value
(under either field name) to canonical via the migration converter, with the
deprecation warning — mirroring the name shim. Drops in slice 05 with the
rest. Acceptance: legacy-value PUT stores canonical; new-form behavior
unchanged.

## Deferred (Low — fold into plan-2607-43 slice 05 unless picked up earlier)

- F6: introduce `admittedBy: "auto"` for auto-approved requests (or record
  the auto-approve flag alongside), so `ops` means an operator acted.
- F7: reject unknown `ONBOARD_ADMISSION` values at startup or first use;
  document that `paid` ≡ `either` until ops-approval is ever disabled.
- F8: comment the R2 create-if-absent atomicity assumption; fall back to
  "unknown holder" wording when the conflict read returns nothing.
- F9: gate self-test fixture; tighten the coordinator-test and `docs/`
  allowlist prefixes when the shims drop.
- Missing-test backlog from review: paid-redeem `admittedBy: "payment"`
  round-trip; full admission matrix (`paid`×pending, unknown value);
  crash-window claim-orphan retry; concurrent-claim race including the
  empty-holder edge.

## Branch assignment

R1–R3, R5 land as fix-up commits on `pipe-fees-2` (PR #176) — they gate
merge. R4 may ride the same PR (small) or follow immediately; it must land
before plan-2607-43 slice 03 makes the index load-bearing for accrual.
