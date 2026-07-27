---
id: 2607-06
status: complete
created: 2026-07-27
refs: [FOR-479, FOR-496, plan-2607-04, plan-2607-43, ADR-0058]
---

# plan-2607-06 — nightly metering canary (liveness probe)

Scheduled end-to-end probe of the metering pipeline on lane A: delegation →
sealer → publisher → chain → indexer → accrual. **Explicitly a liveness
canary, not the integrity test** (grilling 2026-07-27): the ADR-0058 §7
reconciliation job is the completeness backstop and, once built, subsumes
this canary's accrual-count assertion — but reconciliation can never detect
*silence* (a dead pipeline publishes nothing and reconciles perfectly, the
2026-07-26 incident shape), and on a traffic-less dev lane the canary is
the only traffic. The two are complementary; this is the cheap half.

## Shape

**Pinned canary instance** (not fresh-per-night): nightly cost is one
register — no gas, no deploy, and an onboarding regression cannot
false-fail the metering canary (onboarding has per-PR CI and the demo
acceptance). Seed: the plan-2607-04 qualification instance
`eip155:84532:0x9d56cbce6f142bf3c52358c52a643d5c6d2a7bde` (root
`9d56cbce-6f14-2bf3-c523-58c52a643d5c`) — already delegated to the
standing sealer, reusable self-referential root grant minted, currently
frozen at −2 credits, which the first run's top-up clears.

**The freeze interaction is handled in-loop.** Enforcement is armed on
lane A, so a pinned account accruing nightly would freeze itself. Each run
starts with a conditional x402 credits purchase, which doubles the canary
across the whole revenue loop: pay → unfreeze → register → accrue.

## Work items

### 1. `POST /admin/sweep` on x402-settlement (enabler)

Ops-authed route calling `runCheckpointIndexer(env)`, returning the run
summary. R4-safe (the indexer is read-only on `R2_GRANTS`). Earns its keep
twice: removes the 5-min cron wait from the poll budget, and makes the
top-up → unfreeze step deterministic (the kill-switch reconciles on sweep,
so the canary can force the unfreeze rather than wait for cron).

### 2. Canary script (`scripts/metering-canary.sh`)

Fetches the released `forestrie` CLI (the ietf-126-demo preflight
pattern; pin via `FORESTRIE_VERSION`). Steps:

1. Read `GET /admin/receivables/{id}` → `before` (accrued, balance,
   frozen).
2. If `creditsBalance < 5`: buy 10 credits
   (`POST /api/payments/credits/{id}`, x402 flow, payer
   `CANOPY_X402_DEV_PRIVATE_KEY || DEPLOY_KEY`); `POST /admin/sweep`;
   assert unfrozen.
3. `forestrie sign-statement` + `register` with the standing grant;
   assert a receipt comes back (publish liveness, ~15 s when
   pre-delegated).
4. Poll: `POST /admin/sweep` then read receivables, every 60 s up to
   15 min (safe-head lag ~6 min is inherent); assert
   `checkpointsAccrued > before` and balance decremented to match.
5. Emit one summary line (before/after, blocks, elapsed) for the run log.

### 3. Workflow (`.github/workflows/metering-canary.yml`)

Canopy's first `schedule:` workflow — `cron: "17 3 * * *"` plus
`workflow_dispatch`; GitHub Environment `dev`; `timeout-minutes: 25`.
Alerting v1 is the scheduled-workflow failure notification itself —
no custom channel (minimal scope).

Config: vars `CANARY_INSTANCE_ID`, `CANARY_LOG_ID`, `CANARY_GRANT_B64`,
`FORESTRIE_BASE_URL`; secrets `CANARY_LOG_PEM` (the seed instance's
bootstrap PEM), `CANOPY_OPS_ADMIN_TOKEN`, payer key (existing env
secrets). `gh variable set` is operator-run, not agent-run.

## Non-goals

- Completeness/integrity assertions — the §7 reconciliation job (its own
  issue; `registrationBlock` from plan-2607-04 is its per-account sweep
  floor, which is what made it cleanly buildable).
- Custom alert routing, dashboards, multi-lane coverage.
- Fresh-per-night onboarding coverage.

## Acceptance

- Dispatch run green end-to-end against lane A twice in a row.
- A deliberately broken run (e.g. wrong grant) fails loudly within the
  timeout.
- Nightly schedule enabled; failure notifications reach the repo watchers.
- `/admin/sweep` covered by a unit test (auth, summary shape) and used by
  the script.

## Delivery record (2026-07-27)

Shipped in canopy#191 (+ env fix #192). Four green end-to-end runs:
local pre-merge (exercised the frozen → top-up → settle → cron-unfreeze
path and the sweep-404 degradation; PASS accrued 2→3), branch dispatch
30308454375 (sweep live; PASS 3→4), main dispatch 30308887860 (PASS
4→5). Loud-failure criterion evidenced by dispatch 30308206530 (env
misconfiguration → red run within seconds). Nightly schedule active
(03:17 UTC).
