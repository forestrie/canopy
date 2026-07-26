---
id: 2607-02
status: draft
created: 2026-07-26
refs: [ADR-0059, FOR-475]
---

# Plan 2607-02 — slice-01 (univocityInstanceId) review remediation

**Status:** DRAFT (revised 2026-07-26: R1 superseded by reservation-at-admission, D7/D8)
**Related:** [PR #176](https://github.com/forestrie/canopy/pull/176),
[devdocs plan-2607-43 slice 01](../../../devdocs/plans/plan-2607-43-instance-root-fee-accounts/01-identity-and-registry.md),
[devdocs plan-2607-43 slice 06](../../../devdocs/plans/plan-2607-43-instance-root-fee-accounts/06-bootstrap-key-attestation.md),
[devdocs ADR-0059 decision 8](../../../devdocs/adr/adr-0059-instance-root-fee-accounts.md),
[FOR-475](https://linear.app/forestrie/issue/FOR-475)

Review of PR #176. The original F1 remediation (reorder + compensating
rollback) was superseded during design review by a stronger model, now
ADR-0059 decision 8: **the onboard fee purchases the account reservation**
(claim taken at the money moment, completed by genesis), plus a
**bootstrap-key registrant attestation** (slice 06, flag-gated). Findings
below are re-assessed against that model.

## Findings, re-assessed under D7/D8

| ID | Sev | Finding | Status under D7/D8 |
| -- | --- | ------- | ------------------ |
| F1 | High | Instance-claim 409 at genesis burns the already-consumed onboard token | **Superseded, not just fixed**: with the reservation created at redeem/mint and genesis only *completing* it, the burn interleaving no longer exists — no reorder or rollback machinery needed. → R1 |
| F2 | High | Coordinator boot migration UPDATEs `instance_webhooks`' primary key unguarded → constructor crash-loop, all shards | **Unchanged** — orthogonal to D7/D8. Still blocks merge. → R2 |
| F3 | Med | Dual-field mismatch silently prefers `univocityInstanceId` | **Unchanged.** → R3 |
| F4 | Med | No claim release mechanism; break-glass/paid tokens can squat contracts they don't control | **Split.** The squat window is closed by the D8 attestation once its flag is on (interim exposure: lane A, placeholder price, ops remedy). The release route is **more** necessary, not less: D7 can produce dangling `reserved` records by construction (paid, never genesis'd), and the route now operates on a richer record (state, holder, age). → R4, R6 |
| F5 | Med | Compat shim covers the deprecated field name but not the legacy value form (coordinator-first deploy → genesis 503) | **Unchanged.** → R5 |
| F6 | Low | Auto-approved requests labelled `admittedBy: "ops"` | **Promoted into R1** — redeem is being rewritten anyway; add `admittedBy: "auto"`. |
| F7 | Low | `paid` ≡ `either`; unknown `ONBOARD_ADMISSION` values silently default | **Partially promoted into R1** — reject unknown values loudly at first use. `paid` ≡ `either` stays documented; D7 gives a natural future slot for a both-required mode (reservation at approval AND payment) if ever wanted. |
| F8 | Low | Claim-CAS atomicity assumption undocumented; conflict read can yield `claimedBy: ""` | **Absorbed by R1** — the record becomes structured JSON with a `holder`, the atomicity assumption gets its comment, and the unknown-holder wording falls out of the schema. |
| F9 | Low | Naming gate: no self-test, tracked-files-only, broad allowlist prefixes | **Unchanged** — defer to plan-2607-43 slice 05. |

## Remediation items

### R1 (F1, F6, F7-part, F8) — reservation at admission

Implements ADR-0059 decision 8 / plan-2607-43 D7 on the onboard path.

- **Record**: `forests/index/chain-binding/{id}` becomes JSON:
  `{ state: "reserved", holder, reservedAt }` →
  `{ state: "registered", holder, r }`. `holder` is `request:{requestId}` or
  `token:{hash}`. (PR #176 is unmerged — the bare-uuid value has zero
  deployed rows; the schema change is free now and only now.)
- **Redeem order (paid)**: verify → **claim payment auth single-use** →
  **reserve instance** → CAS approve → mint → enqueue settlement. The
  auth-before-reserve order is load-bearing: x402 *verify* is stateless, so
  reserving first would let a replayed, never-settling authorization buy
  reservations. On reserve conflict: 409, the burned-but-unsettled auth
  moves no money, the caller signs afresh. Vetted: code check → reserve →
  CAS transition → mint. Break-glass: reserve at mint.
- **Mandatory bindings**: break-glass mint requires `chainId`/`univocityAddr`
  (new CBOR fields); the genesis `if (tokenBinding && …)` conditional
  becomes unconditional.
- **Genesis completes**: read claim → require `reserved` by this token's
  holder (or `registered` with this R — idempotent retry) → CAS to
  `registered{r}` → *then* consume token → write registration. Legacy
  tokens minted pre-change (no reservation) fall back to a direct
  `registered` claim, still claim-before-consume.
- **Provenance**: `admittedBy: "ops" | "payment" | "auto"` — auto-approved
  requests stop masquerading as ops-vetted. Unknown `ONBOARD_ADMISSION`
  values are rejected loudly.

Acceptance: reserve-conflict at redeem returns 409 with **no** state
transition, no mint, no settlement, and a reusable (unclaimed) payment
situation for the caller; genesis conflict cannot consume a token (test
asserts token record after every conflict path); dangling-`reserved` retry
by the same holder completes; legacy-token genesis fallback covered;
`admittedBy` matrix (ops / payment / auto) round-trips to the registration.

### R2 (F2) — collision-safe, non-fatal migration rewrite

**Root cause, recorded so the fix is reviewed against it.** The hazardous
state (a legacy-keyed and a canonical-keyed `instance_webhooks` row for the
same instance) is produced by version skew during the rollout of the
migration itself: the parallel deploy matrix can put the new canopy-api
(which sends canonical values in the deprecated `instanceKey` field — our
own deploy-order shim) live ahead of the coordinator, whose **old** code
stores keys as opaque labels. The rewrite then UPDATEs a **primary key**
into a collision, and because `ensureSchema()` is constructor-fatal and
re-runs per instantiation, the failure is a self-sustaining crash loop
across **every** shard (`instance_webhooks` is replicated to all). The
migration argued idempotency per row; it never argued convergence over all
reachable data states. F5 is the same skew window seen from the other side.

**Changes** (one private method, `rewriteLegacyUnivocityInstanceIds`):

1. Select rewrite candidates by **"not canonical"** via the shared
   validator, not `NOT LIKE 'eip155:%'` — also closes the silent
   third-format (`eip155:{id}:{40hex}` without `0x`) and case-prefix skips.
2. On `instance_webhooks` PK collision, **DELETE the legacy row, keep the
   canonical one, warn**. Keep-canonical is provable, not a judgment call:
   old code never *generated* canonical values, so a canonical-keyed row can
   only have been written by post-cutover traffic and is strictly newer
   than any legacy row for the same instance.
3. Wrap the whole rewrite phase per-row in try/catch — **a data problem
   must degrade to a warning, never brick liveness.** This is the category
   rule, not just a patch: constructor-fatal `ensureSchema()` was safe
   while every migration was additive DDL (`ADD COLUMN` cannot collide);
   this migration crossed into data-rewriting DML, where any unhandled data
   shape becomes an outage that hides its own cause.

**Rule capture** (so the lesson outlives this fix): add to
`docs/agents/gotchas.md` — (a) a migration touching a unique/PK column must
handle target-exists; (b) DML (data-rewriting) migrations in a DO
constructor must be non-fatal per row; (c) data states producible by your
own compatibility shims during rollout are part of the migration's input
domain.

**Acceptance:** seeded legacy+canonical twin rows boot cleanly with the
canonical row surviving and a warning emitted; third-format row converted
(or warned, never silently skipped); a deliberately malformed value cannot
make the constructor throw (fuzz the rewrite with junk shapes); existing
migration suite (fresh / legacy / pre-FOR-468 DO) still green.

### R3 (F3) — reject dual-field mismatch *(unchanged)*

400 when both fields present with different values; deprecation warning
whenever the legacy field is used. Acceptance: mismatch 400, equal-values
200.

### R4 (F4-release) — reservation inspection and release for ops

Ops-token-gated `GET`/`DELETE /api/payments/chain-bindings/{id}` returning /
releasing the reservation record (state, holder, reservedAt, r). Runbook
paragraph: when to release (dangling reserved, squat before the D8 flag is
on, abandoned R) and that `Initialized` events are the reconciliation
check. Must land before plan-2607-43 slice 03 makes the index load-bearing.
Acceptance: release + re-claim e2e; 401 unauthenticated.

### R5 (F5) — value-form shim on the coordinator *(unchanged)*

Convert legacy-form values (either field name) to canonical on write for
the one-cycle window, with the deprecation warning; drops in slice 05.
Acceptance: legacy-value PUT stores canonical.

### R6 (F4-squat) — bootstrap-key registrant attestation

Spec and rollout in
[devdocs slice 06](../../../devdocs/plans/plan-2607-43-instance-root-fee-accounts/06-bootstrap-key-attestation.md):
COSE_Sign1/CWT by the `bootstrapConfig()` key, signed content type for
domain separation, alg-agile (ES256 / delegation-cose KS256 profile / PQ
via chain-declared alg), `aud` + freshness window, retained as dispute
evidence, `ONBOARD_REQUIRE_KEY_ATTESTATION` flag, counterfactual carve-out,
break-glass waiver. **Not PR-blocking** (mandate CLI coordination); tracked
here so the interim squat exposure is a recorded, bounded decision.

## Deferred (Low → plan-2607-43 slice 05)

F9 (gate self-test, allowlist tightening); documenting `paid` ≡ `either`;
missing-test backlog not covered by R1 acceptance: full admission matrix
(`paid`×pending, unknown-value rejection test), concurrent reserve race
including the vanished-object edge, coordinator-first-deploy genesis-503
regression (F5's user-visible symptom).

## Branch assignment

R1–R3, R5 gate merge and land as fix-up commits on `pipe-fees-2`
(PR #176). R4 rides the same PR (small) or follows immediately — hard
requirement before slice 03. R6 is a coordinated follow-up (devdocs slice
06) behind its flag.
