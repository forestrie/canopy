---
id: 2607-03
status: implemented
created: 2026-07-26
refs: [ADR-0059, FOR-435]
---

# Plan 2607-03 — slice-03 (accrual indexer) review remediation

**Status:** IMPLEMENTED (R1–R6; Lows in §Deferred remain open) · **Date:** 2026-07-26
**Related:** [canopy #179](https://github.com/forestrie/canopy/pull/179) (merged `242eb94`),
[devdocs plan-2607-43 slice 03](../../../devdocs/plans/plan-2607-43-instance-root-fee-accounts/03-accrual-observe-only.md),
[FOR-435](https://linear.app/forestrie/issue/FOR-435)

Post-merge review of the observe-only accrual indexer. **Verified sound:**
the accrual/watermark protocol (no awaits between SQL statements — atomic
under the DO input gate; `from = lastBlock + 1` against inclusive getLogs
bounds skips and double-scans nothing; monotonic upsert; empty-range
advance), the ABI decode (head layout independently computed AND
corroborated by the demo doc's real chain capture: data word 2 = logKind,
word 3 = size), fail-closed admin gates, cron-only indexer reachability,
correct deploy ordering (runtime config → secrets → deploy) with triggers
preserved and the prod var injection empirically exercised. The adapter
discipline the build-vs-buy decision demands is genuinely observed.

**Nothing found corrupts existing data.** The findings below are about the
soak's *trustworthiness* and slice-04 arming safety.

## Findings

| ID | Sev | Finding |
| -- | --- | ------- |
| B2 | **High** (gates slice 04) | One malformed log (short `data`, non-hex `logIndex`, >2^53 word) throws inside `fetchCheckpointEvents`, aborting the account's range before apply — watermark parks just before the poisoned range and every sweep re-throws: **permanent per-account stall** with no ops remediation (no watermark tool). Adversarial angle: a contract owner can emit one topic0-matching log with short data to freeze their own meter — fee evasion once armed. Observe-only: a stall, not corruption; but arming must never act on stale arrears. |
| B3 | Medium | Head and getLogs are separate RPC calls across a failover list and a load-balanced replica pool; a getLogs node whose head is below `to` can return silently-partial results, after which the monotonic watermark advances **past blocks that node never saw** — permanently missed accruals. 6-block lag on the *unsafe* head is thin cover for replica skew and OP-stack reorgs. The soak exists to check meter-vs-chain; silent gaps poison exactly that comparison. |
| A1 | Medium | `parseSupportedChainsRpc` and `listRegisteredAccounts` sit outside any try/catch; a malformed config or R2 hiccup becomes an unhandled rejection inside `ctx.waitUntil` every tick — sweep-level failure with no app-level log, no summary line, visible only in platform exception telemetry. |
| G1 | Medium | `SUPPORTED_CHAINS_RPC` is not in the x402-settlement deploy's required-keys list, and `setStringProperty` silently no-ops on an empty value — a prod lane missing the GitHub var **deploys green and skips every sweep**. Combined with A1: a soak can run for weeks producing zero data. The lane-wiring guard never asserts the injected var. |
| C1 | Medium | The static-word decode has no layout self-check. topic0 pins the signature, not indexed-ness: a contract revision changing which params are indexed keeps topic0 but shifts data words — silently recorded garbage kind/size while counts stay plausible. Data word 4 is structurally `0xe0` for exactly this layout — a free assert. |
| D1 | Medium | The `R2_GRANTS` binding grants x402-settlement full **write** capability over the registration bucket (CF has no read-only bindings); the discipline is comment-only, and this worker fronts internet-facing proxy + admin surfaces. The slice doc's "read-only binding" is not satisfiable on CF as written. |
| E5 | Medium | `INDEXER_BACKFILL_FROM_BLOCK` is deployment-global and latching: while set, every first-seen account on every chain backfills from that one number — cross-chain heights aren't comparable, and a stale var silently commits each new account to weeks of chunked scanning. |
| B4 | Low | Watermark read is `SELECT last_block … LIMIT 1` with no key predicate — correct only under one-binding-per-DO; the schema explicitly invites per-chain cursors later. |
| D3 | Low | Ops-token posture asymmetry: canopy-api fails the deploy without it, x402-settlement warns and deploys with `/admin/**` permanently 401 — a lane can silently lack its soak observability. |
| E1 | Low | `eth_blockNumber` per account instead of per chain — N calls per sweep and intra-sweep head skew (widens B3's window). |
| E2/E3/E4 | Low | R2 list+get per record per sweep (linear in total reservations — a named build-vs-buy revisit trigger); admin status probes persist empty DOs per probed id (ops-gated); `payment_events` has no retention path (slice-04 concern, flagged only). |

Design notes worth acting on: `accrueCheckpoints` duplicates the accrual
core of `applyCheckpointEvents` (drift here is a future double-count — the
single-event form should delegate); the 7-day dedup retention is safe *only
because* watermarks are monotonic — document that coupling before any
watermark-rewind tool exists.

## Remediation items

### R1 (A1 + G1) — the sweep must fail loudly, and prod config must be guarded

Wrap `runCheckpointIndexer`'s body: config parse + enumeration inside the
guard, `console.error` with a `sweep failed` line, and the summary line
emitted from a `finally`-shaped path so every tick logs *something*. Deploy
side: add `SUPPORTED_CHAINS_RPC` to the x402-settlement required-keys check,
echo it in the `resolved:` lines, and assert the injected var in
`assert-lane-wiring.mjs`.
Acceptance: malformed-config sweep logs `sweep failed` and resolves (no
unhandled rejection, test); deploy fails without the var (workflow); lane
guard asserts it for both lanes.

### R2 (B2 + C1) — decode quarantine with a structural tripwire

Two distinct failure classes, two behaviors: (a) **structural layout
violation** — assert data word 4 == `0xe0`; on failure, throw the range
(loud stall — if the layout moved, every event is suspect and stalling is
correct); (b) **per-event malformation** (short data, bad logIndex, unsafe
ints) — `console.warn` + skip the event, still apply the range and advance
the watermark (a permanently missed event is the ADR-0058 §7 trade, and the
reconciliation backstop's job — strictly better than a permanent stall that
also blocks every later event). Pre-arming requirement recorded: slice 04
must add an ops watermark-set tool before `ENFORCEMENT_ARMED` flips, so a
stalled account is remediable without a deploy.
Acceptance: poisoned-log fixtures (short data / bad index / huge word) skip
with warnings while the range applies; shifted-layout fixture (word 4 ≠
0xe0) stalls the account loudly; both tested.

### R3 (B3 + B4 + E1) — scan bound from the safe head, per chain

Replace `eth_blockNumber` with `eth_getBlockByNumber("safe", false)` for
the scan bound (fall back to `latest` minus confirmations when a chain
doesn't serve the tag), fetched **once per chain per sweep** and shared
across that chain's accounts (also removes intra-sweep skew). Key the
watermark read by `(chain_id, univocity_addr)` while touching the area.
Residual replica-skew on getLogs itself is accepted and documented: the
safe tag puts the bound behind every honest node's view, which is the
practical fix.
Acceptance: RPC stub asserts one head call per chain and the safe-tag
request shape; watermark read keyed; boundary test asserts the exact
`fromBlock`/`toBlock` hex params sent to getLogs (closes missing-test #5).

### R4 (D1) — contain the write-capable binding

Now: a unit guard asserting the indexer package's only `R2_GRANTS` member
uses are `list`/`get` (cheap tripwire against drift), plus an explicit
blast-radius note in the slice doc replacing the unsatisfiable "read-only
binding" wording. Later (revisit with slice 05 or the build-vs-buy
triggers): a dedicated reservation-index bucket or ops-authed enumeration
endpoint, removing the capability instead of disciplining it.

### R5 (E5) — scope the backfill knob per chain

`INDEXER_BACKFILL_FROM_BLOCK` becomes a JSON map `{chainId: block}`;
accounts on unlisted chains use observe-forward. Documented as a one-shot
ops action to unset after use.

### R6 (design note) — single accrual core

`accrueCheckpoints` delegates to the same private core as
`applyCheckpointEvents` so the dedup/balance/retention logic exists once.
Document the retention↔monotonic-watermark coupling at the retention
constant.

## Deferred (Low)

D3 (align the deploy posture — recommend x402-settlement also failing
without the ops token once the soak route is load-bearing), E2 enumeration
cost (named revisit trigger), E3 probe-persisted DOs, E4 payment_events
retention (slice 04). Missing-test backlog not covered by R-acceptance:
`ensureV3Columns` legacy rename (needs a dedicated allowlisted test file —
the naming gate currently discourages exactly this test), multi-range
chunking resume, `scheduled()` handler invocation, R2 pagination,
chain-without-RPC skip, cross-bind defensive throws.

## Branch assignment

R1–R3 (+R6 riding along) land promptly as one fix-up PR — B3 in particular
degrades the *soak data being collected right now*. R4's guard rides the
same PR; its bucket-level fix is deferred. R5 small, same PR. The ops
watermark tool is a recorded slice-04 gate, not this PR.
