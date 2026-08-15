# Plan 0051 — pipe-fee receivables review remediation

**Status:** DRAFT
**Date:** 2026-07-25
**Related:** [ADR-0058](https://github.com/forestrie/devdocs/blob/main/archive/2607/adr/adr-0058-pipe-fee-receivables-root-liability.md),
FOR-435, FOR-465, FOR-469, canopy#173, branch `pipe-fees-1`

## Scope

Review of `pipe-fees-1` (3 commits, single-branch — not Graphite-tracked):
`b1f0ba9` payTo config, `75b8f5e` liable-account resolution, `261db21`
ReceivablesDO. Backend implementation lens: correctness, idempotency, identity
stability, and scale of the 402 read path.

## Remediation items

### R1 (High) — idempotent accrual

`ReceivablesDO.accrueCheckpoints` increments unconditionally. Queue delivery is
at-least-once, and the sibling `X402SettlementDO` in the same directory already
carries `settled_jobs (idempotency_key PRIMARY KEY)` for exactly this reason.

Because ADR-0058 §7 deliberately declines precise accounting, **nothing
downstream will notice** a double-count — that makes the omission worse, not
more tolerable.

_Acceptance:_ accrual takes an idempotency key; replaying the same key twice
leaves the count unchanged; covered by test.

_Branch:_ current stack, before any accrual caller lands (step 4).

### R2 (High) — pin the account-key format

`liableAccountKey()` builds `<chainId>:<univocityAddr>` from
`chainBinding.chainId`, which is a **bare numeric** string
(`forest/genesis-cache.ts` writes `String(legacyChains[0])`). Code comments,
commit message and ADR-0058 all call this "CAIP-2-shaped". CAIP-2 would be
`eip155:84532`.

The hazard is not the label. If any writer ever emits the CAIP-2 form, one
operator silently becomes **two accounts** with split receivables and no
detection path.

_Acceptance:_ the format is pinned and validated where the key is derived;
a non-conforming `chainId` is rejected rather than silently keyed; ADR-0058 §2
and the code comments corrected to describe the real format.

_Branch:_ current stack (code), plus a devdocs PR for the ADR.

### R3 (Medium) — bind DO instance identity to its account

One DO instance per account, but the schema is keyed by `account_key` and every
method takes it as a parameter, unchecked. A routing bug writes a second account
row _inside the wrong instance_ and reads back cleanly.

_Acceptance:_ the instance pins its account on first use and rejects a
mismatched key, or the parameter is removed and identity taken from the DO.

_Branch:_ current stack.

### R4 (Medium) — tests for ReceivablesDO

The class ships with none, in a package that already has `test/settlement.test.ts`
and `test/cdp-jwt.test.ts`.

_Acceptance:_ coverage for accrual (incl. R1 replay), arrears transitions,
subtree counters, and the **null-means-nothing-owed** contract that is currently
only a docstring promise.

_Branch:_ current stack.

### R5 (Medium) — decide the sharding posture

One instance per account serialises that account's 402 reads through a single
DO. `X402SettlementDO` shards via `DO_SHARD_COUNT` to avoid exactly this. For a
large operator at high checkpoint rate this is head-of-line blocking on the
**request** path.

_Acceptance:_ an explicit decision — per-account is correct because contention
is per-account and reads are cheap, **or** a shard scheme. Recorded in ADR-0058
§5 either way. Interacts with FOR-469.

_Branch:_ new issue; decision precedes code.

## Deferred (Low)

- `arrears` column has no `CHECK` constraint and is cast with `as ArrearsState`
  on read; an invalid write surfaces as a typed-but-invalid value.
- `this.row(...)!` in `accrueCheckpoints` masks an upsert failure as a
  `TypeError` rather than a clear error.
- `requirePayTo` throws per-request, so a misconfigured deployment yields a 500
  per request. The commit claimed "refuse to issue a 402 **or fail startup**";
  only the former is implemented.

## Design holes

- **The null-means-nothing-owed contract is unenforced.** Documented as a MUST
  for callers, but step 3 (the 402 read) is unwritten, so no caller honours it
  yet. A caller that reads null as "unknown, therefore refuse" would refuse
  every new customer at their first 402.
- **The meter is write-capable but unwritten.** ADR-0058 §3 makes the checkpoint
  count the metered unit; nothing increments it until step 4. The DO can be
  deployed in a state where it reports zero owed for active accounts.
- **No reconciliation hook, by design** (§7). That is a deliberate choice, but it
  is what removes the safety net under R1.
