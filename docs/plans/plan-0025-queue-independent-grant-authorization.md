# Queue-independent grant authorization (no perf regression)

**Status:** ACCEPTED
**Date:** 2026-05-31
**Related:** [plan-0024](plan-0024-byok-checkpoint-seal-rca.md),
[plan-0021](plan-0021-delegation-coordinator-apis.md),
[plan-0005](plan-0005-grant-receipt-unified-resolve.md),
[arbor plan-0003](https://github.com/forestrie/arbor/blob/main/docs/plan-0003-non-custodial-checkpoint-support.md),
[arbor plan-0006](https://github.com/forestrie/arbor/blob/main/docs/plan-0006-byok-checkpoint-seal-end-to-end.md)

## Goal and global policy

Two standing requirements drove this work:

1. **Authorization must not depend on Durable Object queue state.** No
   authorization decision may call `SequencingQueue.resolveContent` (the ephemeral
   operational cache). Authorization rests on the durable, cryptographic record: the
   SCITT receipt (MMR inclusion proof + checkpoint signature) and/or R2-sealed
   massif state.
2. **No performance regression** from satisfying (1). Where a regression is
   genuinely unavoidable, prefer feature completeness and call out the exact
   code/service made less efficient.

The DO queue remains in use for **non-authorization** purposes — enqueue/sequencing,
status polling (`query-registration-status`), and enqueue dedupe (`grant-sequencing`).

## Why this was mostly a removal, not a rebuild

`grantAuthorize` already performed full cryptographic verification
(`verifyReceiptInclusionFromParsed`) **before** the queue check. That function binds
**this exact grant** to the proven leaf
(`univocityLeafHash(idtimestamp, grantCommitmentHashFromGrant(grant))`), verifies the
receipt COSE Sign1 against the resolved owner-log authority (trust root + delegation),
and verifies MMR inclusion under the signed peak. The subsequent
`verifyGrantIncluded` DO check was the weaker, redundant leg — its own header
documented receipt/MMR verification as the intended "stronger defence" replacement.
Removing it after a passing receipt verification is security-neutral-to-positive and
removes one DO RPC.

## What changed (as built)

### Phase 1 — remove the redundant DO gate from `grantAuthorize`

- Deleted the `verifyGrantIncluded` block from
  [`auth-grant.ts`](../../packages/apps/canopy-api/src/scrapi/auth-grant.ts).
  Authorization is the receipt verification above it.
- `AuthGrantAuthorizeEnv.inclusionEnv` (a queue handle) was replaced with a plain
  `enforceInclusion: boolean` — a **configuration flag**, not queue state. Callers
  set it from binding presence: `Boolean(env.queueEnv)` in
  [`register-grant.ts`](../../packages/apps/canopy-api/src/scrapi/register-grant.ts)
  and `Boolean(sequencingQueue)` in
  [`register-signed-statement.ts`](../../packages/apps/canopy-api/src/scrapi/register-signed-statement.ts).
  It is false only in pool-test mode with incomplete bindings (auth skipped),
  preserving the prior escape hatch exactly.
- Security gate: a unit test
  ([`grant-authorize.test.ts`](../../packages/apps/canopy-api/test/grant-authorize.test.ts))
  proves a valid receipt for a **different** grant/leaf is rejected (the binding is
  load-bearing; the DO check was redundant).

### Phase 2 — queue-independent child-data-first parent gate

A child-data first grant (`O !== T`, data-log class) is gated on the parent
authority being **sealed**, branching on the parent's identity:

- **Parent is the root genesis log R** (`ownerLogId === bootstrap`): R legitimately
  owns its own first massif via the self-referential bootstrap grant, so readiness is
  `isLogInitializedMmrs(R)` (one R2 head, queue-free) and the data grant must be
  signed by **R's authority key (forest genesis x‖y)**. Root-owned data logs are a
  first-class supported topology.
- **Parent is an intermediate auth log A** (`ownerLogId !== bootstrap`): A has no own
  massif (its leaf is sealed on R), so `isLogInitializedMmrs(A)` is meaningless and
  was dropped. The caller presents **A's completed creation grant** in the new
  `Forestrie-Parent-Grant` header. The worker verifies that grant's **receipt** via
  `grantAuthorize` against R's receipt authority, confirms it created A
  (`logId === ownerLogId` of the child grant), and requires the data grant to be
  signed by the authority key A's creation grant established (its `grantData` x‖y).
  No DO read, no `isLogInitializedMmrs(A)`, no Custodian curator fetch.

> **Update (transport):** the parent evidence was subsequently moved from the
> `Forestrie-Parent-Grant` header to the register-grant CBOR request body
> (`{ parentGrant: <bytes> }`). The verification logic is unchanged. The authoritative
> description now lives in [grants.md §10–§11](../grants.md). References to the header
> below are historical.

This is exactly "wait for the initial grant to be sealed", proven cryptographically.
Genesis/root identity is treated as a **structural property** (self-referential
creation grant); trust still comes from the pinned genesis / trust-root via
`resolveReceiptAuthority`. The implementation uses `bootstrapUrlUuid` as a convenience
for the single-forest case and does not preclude a future parent→owner tree-walk.

E2e: the `postRegisterGrantExpect303RetryParentMmrs` MMRS-readiness retry crutch was
removed; `completeGrantRegistrationThroughReceipt` now accepts `parentGrantBase64`
(sent as `Forestrie-Parent-Grant`). `auth-data-log-chain.spec.ts` presents A's
completed creation grant. Unit coverage:
[`register-grant-child-data.test.ts`](../../packages/apps/canopy-api/test/register-grant-child-data.test.ts)
covers both parent kinds (root-owned accept/reject; intermediate accept,
missing-parent, wrong-receipt-authority, logId-mismatch, wrong-signer).

### Phase 3 — retire the queue authorization primitive

- Deleted `verify-grant-inclusion.ts` and the `InclusionEnv` plumbing (no remaining
  authz callers). `registerSignedStatement` no longer takes an `inclusionEnv` param.
- `SequencingQueue.resolveContent` remains only in `query-registration-status`
  (polling) and `grant-sequencing` (dedupe).
- Guard test
  ([`authz-no-queue-guard.test.ts`](../../packages/apps/canopy-api/test/authz-no-queue-guard.test.ts))
  asserts the authz modules (`auth-grant`, `register-grant`,
  `register-signed-statement`) reference neither `resolveContent`,
  `verifyGrantIncluded`, nor `verify-grant-inclusion` (via `?raw` source import).

## Performance

- `grantAuthorize` (entries + initialized-grant hot path): **−1 DO RPC**. No regression.
- Child-data-first under an intermediate A: replaced one Custodian curator
  `log-key` fetch + one DO `resolveContent` with receipt-crypto over the
  caller-supplied parent grant (CPU only). Strictly **fewer** network dependencies.
- Root-owned child-data: unchanged (one R2 head via `isLogInitializedMmrs(R)`).

No service path was made less efficient; the primary (header) design avoided the R2
seal-scan fallback entirely.

## Documented future phases (not built here)

Sequenced remaining plan-0003 arc work, confirmed against code status:

- **Univocity trust-root CBOR adapter** — replace the coordinator KV stop-gap; add
  CBOR `public-root`, switch `TRUST_ROOT_URL` selectors to Univocity-first, enable
  `chainId`/`contractAddress`/freshness checks.
- **SCRAPI non-custodial grant authoring** — `grantData` named profiles +
  validators/tests; `POST /api/grants/prepare`; completed-grant artifact GET.
- **On-chain publisher** — blocked on deployed Univocity contracts.
- **Mandate production COSE delegation cert assembly**.
- **Sealer horizontal scale-out (log-id-prefix sharding)** — only for scaling beyond
  `replicas: 1`; not a regression source.
- **Ops finalization** — sequence the coordinator/sealer token bootstrap so the
  deployed BYOK stretch path is reliably green.

## Verification

```sh
cd canopy
pnpm --filter @canopy/api test -- auth-grant register-grant receipt-verify authz-no-queue-guard
pnpm --filter @canopy/api typecheck
pnpm --filter @canopy/api-e2e typecheck
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e test:e2e:system   # auth-data-log-chain green, no queue dep
```
