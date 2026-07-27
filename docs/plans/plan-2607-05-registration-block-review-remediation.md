---
id: 2607-05
status: complete
created: 2026-07-27
refs: [FOR-477, plan-2607-04]
---

# plan-2607-05 — registration-block review remediation

Review of the plan-2607-04 implementation (uncommitted `mandate-1` working
tree, pre-PR), per forestrie-agents `review-changes.md`. Backend lens.
Findings R1–R5; R1 was the only Medium.

**Outcome:** R1a, R2, and R3 implemented in the same PR as plan-2607-04;
R4 and R5 deferred by design (accepted noise/latency bounds).

## R1 (Medium, liveness/correctness) — explicit-null floor races its own repair

`registrationBlock: null` (genesis-time observation failed) is treated by
the indexer identically to a legacy absent field: observe-forward at first
sight. The cron sweeps every few minutes, so the watermark is initialised
long before any plausible ops PATCH — and the watermark is forward-only, so
the repair the null posture depends on is inert in exactly the case it
exists for. The FOR-477 miss window reopens for every null-floor account.

The wire already distinguishes `null` (recent registration, observation
failed, repair pending) from absent (legacy, nothing to wait for).

**Remediation options** (pick one):

- **R1a (recommended)**: indexer holds first sight for explicit-null
  records while `now - reservedAt < grace` (e.g. 1h), logging
  `awaiting registrationBlock repair`; after grace, observe-forward as
  today. Bounded, no new config beyond the grace constant, and the hold
  mechanism already exists (floor-above-bound path).
- **R1b**: accept the race; document that a null floor means "repair
  within one cron tick or rely on ADR-0058 §7 reconciliation". Zero code;
  honest runbook.

Acceptance (R1a): unit test — explicit-null record younger than grace is
not watermark-initialised; older than grace observe-forwards; absent field
observe-forwards immediately.

## R2 (Low, correctness) — completion can overwrite a repaired floor with null

`completeUnivocityInstanceReservation` writes its own observation
unconditionally on the CAS path: a reservation PATCHed before genesis
(rare but permitted) loses the repair if the genesis-time observation
fails. Fix: `registrationBlock: registrationBlock ?? record.registrationBlock ?? null`.
One line plus a test.

## R3 (Low, test coverage)

- No route-level test that a genesis POST records an observed block
  (registry-level plumbing is covered; the `observeRegistrationBlock` →
  `completeInstanceClaim` wiring is exercised only with RPC unavailable →
  null).
- The ops PATCH test repairs a `reserved` record only; the primary use is
  a `registered` record post-genesis.

## R4 (Low, observability) — held-account log noise

While a floor sits above the scan bound, each sweep re-logs
`first sight from registrationBlock N` and `granted N starter credits`
(grant itself is idempotent). One line per held account per sweep,
window is minutes. Fix if it grates: log only when the watermark advances.

## R5 (Low, latency, note only) — genesis observation worst case

`observeRegistrationBlock` fails over sequentially: worst case
~2s × #RPC URLs on the genesis path when all endpoints are down. Bounded
and rare; no action recommended.

## Branch assignment

R1–R4 fit the current `mandate-1` branch before the PR. R5 is a note.
