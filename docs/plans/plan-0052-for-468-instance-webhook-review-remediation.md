# plan-0052 — FOR-468 instance webhooks: review remediation

**Status:** DRAFT
**Date:** 2026-07-25
**Related:**

- Spec: [ADR-0005 amendment 2026-07-25](../adr/adr-0005-delegation-webhook-delivery.md),
  "Instance-level webhooks, inherited by copy"
- Design: [ARC univocity instance registration](../arc/arc-univocity-instance-registration.md)
- Linear: FOR-468
- PR under review: [canopy#174](https://github.com/forestrie/canopy/pull/174),
  branch `robin/webhook-instance-inherit`, diff `main...HEAD` (+1619/−56, 22 files)
- Review lens: distributed systems / applied cryptography (backend implementation)

## Scope summary

Single branch, not Graphite-tracked, reviewed against `origin/main` at `43437ba`.

The change is sound in its central claim. Inheritance by copy — replicating
`instance_webhooks` to every shard and copying the URL into
`log_delegation_config` at registration — genuinely keeps the delegation request
path inside one shard, and `readDelegationConfigRow` confirms delivery reads the
copy with no cross-shard hop. The convergence property is also correct: because
each shard's Durable Object serializes its own writes, a log registering
concurrently with an instance fan-out ends up with the current URL regardless of
which lands first.

The delegation certificate also authenticates itself — it is verified against
the target log's registered public root and carries that log's id inside the
signed payload — so misdirected delivery is a disclosure and a nuisance, not an
authority risk. That single fact bounds the severity of H1 below.

**Which graph the instance webhook follows, since this review got it wrong
once.** A webhook must reach whoever holds custody of a log's signing keys, so
instance webhooks follow the **univocity authority hierarchy** — the log's own
forest and contract. They are deliberately _not_ the **payment-registration
graph**, which answers a different question (who reimburses canopy) and resolves
to a different univocity instance for any regular forest. FOR-468 reads the
log's own chain binding, which is correct. An earlier draft of this review
proposed unifying it with `liableAccountKey`; that would have merged the two
graphs the ARC calls "the crux of the model", and it is withdrawn. What remains
is that the two keys look identical without being the same thing — M4.

What follows are the gaps: one unverified binding, a key-shape collision, and a
set of operational and correctness issues around the fan-out.

## Findings

| ID  | Sev             | Dim           | Location                                                                                         | Finding                                                                                                                                                                                                                                                      | Invariant / rule                                                                                               |
| --- | --------------- | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| H1  | Medium (fixed)  | Security      | `delegation-coordinator/src/handlers/put-webhook.ts:39`                                          | A log can bind itself to **any** univocity instance with no proof it belongs to that instance; leaks that instance's webhook URL and aims signed events at it. No authority escalation — the certificate is bound to its logId and the log's registered root | ARC-0017 dual-token authority: an issuer token is authority over _its_ log                                     |
| H2  | **Medium-High** | Liveness      | `canopy-api/src/forest/handle-forest-request.ts:145`                                             | Genesis now makes two blocking, untimed coordinator calls on a path documented as best-effort                                                                                                                                                                | Genesis is the primary onboarding path                                                                         |
| M1  | Medium          | Correctness   | `delegation-coordinator/src/instance-key.ts` vs `canopy-api/src/forest/instance-key.ts`          | Instance-key normalization diverges on the `0x` address prefix; a mismatched key silently matches no logs                                                                                                                                                    | One canonical rendering per key (see M4 — this is _within_ the instance key, not a merge with the payment key) |
| M2  | Medium          | Liveness      | `delegation-coordinator/src/handlers/instance-webhook.ts:55`                                     | Re-point and delete fan out non-atomically, report the first failure only, and self-repair only if the caller retries                                                                                                                                        | Revocation must not half-apply                                                                                 |
| M3  | Medium          | Scale         | `delegation-store.ts` `handlePutInstanceWebhook`                                                 | A re-point is one unbounded synchronous `UPDATE` plus two `COUNT(*)` per shard                                                                                                                                                                               | Motivating case is an owner operating _many_ logs                                                              |
| M4  | Medium          | Correctness   | `canopy-api/src/forest/instance-key.ts` vs `canopy-api/src/payments/resolve-payment-ancestor.ts` | `instanceKey` (authority hierarchy) and `liableAccountKey` (payment graph) are different entities rendered as the same `{chainId}:{univocityAddr}` string, with disagreeing validation                                                                       | ARC: the two graphs must stay separate; glossary: "Avoid: conflating with the per-forest authority hierarchy"  |
| L1  | Low             | Best practice | `delegation-store.ts:358`                                                                        | New columns live only in the migration path, not the base `CREATE TABLE`                                                                                                                                                                                     | Inconsistent with the neighbouring `ensureEnabledAuthorityColumns`                                             |
| L2  | Low             | Best practice | `delegation-store.ts` `countInstanceMemberLogs`                                                  | `webhook_source` interpolated into SQL rather than bound                                                                                                                                                                                                     | Every other predicate in the file is bound                                                                     |
| L3  | Low             | Correctness   | `instance-webhook.ts:124`                                                                        | `Math.min(createdAt ?? Infinity, shardResult.createdAt ?? 0)` collapses to `0` if any shard omits `createdAt`                                                                                                                                                | Latent only                                                                                                    |
| L5  | Low             | Best practice | `canopy-api/src/scrapi/auth.ts`                                                                  | Dead API-key stub returning `true` unconditionally, with no importers                                                                                                                                                                                        | Fail-open code should not sit unused in the tree                                                               |
| L4  | Low             | Docs          | `delegation-coordinator/src/instance-key.ts`, `canopy-api/test/instance-key.test.ts`             | Key described as "CAIP-2 style"; it is `{decimal chainId}:{40-hex, unprefixed}`                                                                                                                                                                              | Same inaccuracy already known in ADR-0058 §2                                                                   |

## Remediation items

### H1 — binding a log to an instance is unverified (disclosure only) — **FIXED**

**Shipped** in `054abc6` on `robin/webhook-instance-inherit` (#174): `instanceKey`
on `PUT /api/logs/{logId}/webhook` now requires `COORDINATOR_APP_TOKEN` and
answers `403` to a per-log `issuerToken`; `url` still takes either. Covered by
`webhook.test.ts` "refuses an instanceKey presented with a per-log issuerToken",
verified to fail (200 instead of 403) with the guard removed. ADR-0005 and the
ARC CRUD table record the rule and why the coordinator cannot check the claim
itself.

`PUT /api/logs/{logId}/webhook` authenticates with the coordinator app token
**or** the log's own `issuerToken`, and now accepts an arbitrary `instanceKey`.
The coordinator "treats it as an opaque label and never resolves it on chain",
and the key is `{chainId}:{univocityAddr}` — both public. Nothing anywhere in
the coordinator relates an `instanceKey` to a registered chain binding. So a
caller holding one log's issuer token can name any other operator's instance.

**What this actually costs, and what it does not.**

The consequence is confined to disclosure and unsolicited traffic:

1. **The victim instance's webhook URL leaks.** `handlePutWebhookConfig` copies
   `readInstanceWebhookRow(instanceKey)?.webhook_url` into the caller's own log
   row, and `GET /api/logs/{logId}/webhook` — same dual auth — returns it as
   `webhookUrl`.
2. **Coordinator-signed events can be aimed at that endpoint.**
   `delegation.required` events naming the _caller's_ log are delivered to the
   victim's receiver with a valid JWKS signature, so a receiver that checks only
   the signature will sign a certificate it had no reason to sign.

**There is no authority escalation, because the delegation certificate
authenticates itself.** The inbound path does not care who posts it:
`delegation-store.ts` loads the target log's own `public_roots` row and calls
`validateByokDelegationCertificate({ logIdHex32, …, publicRoot })`, and
`validate-byok-certificate.ts:127` rejects unless the logId parsed **from the
certificate payload** equals the target log. So a certificate produced by a
victim's root key over the attacker's logId fails against the attacker's
registered root, and cannot be replayed onto the victim's own log either, since
logId is bound inside the signed payload. The artifact is inert. This is the
right design — a valid delegation is valid regardless of who carries it — and it
is what keeps this finding out of the High band.

What remains for the receiver's `logId` ownership check is therefore hygiene
rather than an authority boundary: it stops a receiver being used as a signing
oracle over attacker-chosen `(logId, mmrStart, mmrEnd, delegatedPublicKey)`
tuples, and stops foreign events consuming receiver state. Its placement ahead
of the `requestKey` dedup is correct. ADR-0005 should describe it that way
rather than as load-bearing.

**Current exploitability is limited further:** nothing in `canopy-api/src`
provisions a per-log `issuerToken` — it is set only through a signing-route PUT
— so today the sole caller able to reach this is the app-token holder, which is
already fully privileged.

The fix is cheap and worth taking anyway, since the field has no legitimate
issuer-token caller.

**Acceptance criteria**

- `instanceKey` on `PUT /api/logs/{logId}/webhook` is accepted only from a
  `COORDINATOR_APP_TOKEN` caller; a request authenticated by per-log
  `issuerToken` that carries `instanceKey` is rejected `403`. This preserves the
  canopy-api-brokered flow (canopy-api derives the key from the registration
  record it already holds) and closes the direct path.
- A test asserts an issuer-token caller cannot bind to an instance.
- ADR-0005 records the receiver ownership check as defence in depth against
  signing-oracle use, and records explicitly that certificate validity is bound
  to the logId in its payload and to the log's registered public root, so
  delivery to the wrong endpoint is not an authority risk.

**Branch:** follow-up branch off `main`; does not need to block #174.

### H2 — bound the new best-effort coordinator call on genesis

The new `else if (instanceKey && isCoordinatorForwardConfigured(env))` branch
awaits `coordinatorStatusForGenesis`, which issues **two** sequential coordinator
fetches — the public-root PUT and then the webhook PUT (the rewritten test
asserts `calls` has length 2). `forward-coordinator-registration.ts` sets no
`AbortSignal` and no timeout. This path previously made no coordinator call at
all, so every genesis with a derivable chain binding now blocks on coordinator
availability, and the result is discarded rather than acted on.

Two things follow that the PR body understates. First, a slow or hung
coordinator now adds latency to — or stalls — genesis, which is precisely the
outcome "best-effort, non-fatal" is meant to avoid; non-fatal is not the same as
non-blocking. Second, the branch registers the log's **public root** with the
coordinator for the first time on this path, creating one coordinator DO row per
genesis. That is a larger behaviour change than "forwards the binding" and is
worth stating explicitly.

**Acceptance criteria**

- The best-effort forward is bounded by an `AbortSignal.timeout`, or moved to
  `ctx.waitUntil` so genesis does not wait on a result it ignores.
- A test asserts genesis still returns `201` when the coordinator does not
  respond within the bound.
- ADR-0005 "What shipped" records that this path now also registers the public
  root, not only the instance binding.

### M1 — one canonical instance-key normalization

`instanceKeyFromStoredChainBinding` (canopy-api) strips a leading `0x` and
lowercases. `normalizeInstanceKey` (coordinator) only trims and lowercases, and
its pattern `/^[0-9a-z][0-9a-z._:-]*$/` happily accepts `84532:0xabc…` as a key
distinct from `84532:abc…`. An operator registering an instance the natural way,
with a `0x`-prefixed address, creates a record no log will ever match: the PUT
returns `200` with `memberLogs: 0` and nothing errors.

The two implementations are kept in step only by a comment — "Mirrors the
coordinator's accepted instance-key shape" — with no shared module and no test
asserting the mirror holds. canopy-api has a test named "tolerates a 0x-prefixed
address"; the coordinator has no counterpart.

**Acceptance criteria**

- `normalizeInstanceKey` strips a `0x` prefix from the address segment, or
  rejects it with a message naming the canonical form.
- A shared module, or a test that exercises both implementations over the same
  vector table so drift fails CI.
- `PUT /api/instances/{k}/webhook` returning `memberLogs: 0` is at minimum
  called out in the ADR as the signal of a mistyped key.

### M4 — two different entities are rendered as the same key

`instanceKey` and `liableAccountKey` are **not** the same key, and must not be
unified — but today they are indistinguishable strings, which is how a reviewer
came to propose unifying them.

Canopy maintains two graphs, and
[the ARC](../arc/arc-univocity-instance-registration.md) calls keeping them
apart "the crux of the model":

|                               | Reads                                                                       | Graph                                                           | Answers                            |
| ----------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `instanceKey` (FOR-468)       | the log's **own** chain binding (genesis), or its **parent's** (prepare)    | univocity authority hierarchy, within one forest / one contract | who holds this log's signing keys  |
| `liableAccountKey` (ADR-0058) | the **payment-authoritative ancestor's** binding, via the `endorsedBy` walk | payment-registration graph, across forests                      | who reimburses canopy for this log |

For a **regular** forest these resolve to **different univocity instances**: the
forest is its own instance, but its receivables are billed to its sponsor's.
They coincide only when the root is itself payment-authoritative, which is
exactly the case most likely to be exercised in a test.
`resolve-payment-ancestor.test.ts` pins the distinction — "bills the
payment-authoritative ancestor's chainBinding, not the leaf's".

FOR-468's choice is **correct**: `delegation.required` must reach whoever holds
custody of the log's keys, which is the authority hierarchy, not the payer.

The defect is presentational, and it is a live trap:

- Both render as `{chainId}:{univocityAddr}`, lowercased. Nothing in either name
  or shape says which graph a given value came from.
- Their validation disagrees, so they are not even reliably the same format.
  `liableAccountKey` **throws** on a CAIP-2 chain id or an `0x` prefix
  (`BARE_CHAIN_ID`, `UNIVOCITY_ADDR`). `instanceKeyFromStoredChainBinding`
  **accepts** CAIP-2 — there is a test pinning `eip155:84532:4242…` — and strips
  `0x`. The coordinator's `normalizeInstanceKey` accepts both and normalizes
  neither.
- ADR-0058 §2 reads as though any log's own instance is its account: "The root
  log is one per univocity instance, so the instance address plus chain id _is_
  the account." True of the payment-authoritative root's instance; misleading
  for a regular forest.

No functional conflation exists today — `liableAccountKey` is used only by
x402-settlement's `ReceivablesDO` and `instanceKeyFrom*` only by the coordinator
webhook binding, and they never meet. This is about preventing the first time
they do.

**Acceptance criteria**

- The two keys are distinguishable on sight: distinct naming (e.g.
  `custodyInstanceKey` vs `liableAccountKey`) and, preferably, a distinct
  rendering or prefix so a value carries its graph.
- Neither module's helper is reachable from the other's call path without a type
  that names the graph.
- ADR-0058 §2 is amended to say the account is the **payment-authoritative
  ancestor's** instance, not simply "the log's instance" — alongside the CAIP-2
  correction already queued for that section.
- ADR-0005 records that instance webhooks follow the authority hierarchy and are
  deliberately **not** the payment graph, with a pointer to ADR-0058 so the next
  reader does not merge them.

**Branch:** follow-up; the ADR-0058 §2 half batches with the devdocs correction
already pending.

### M2 — make the fan-out's partial state visible and repairable

`fanOutToShards` issues `Promise.all` across shards; the aggregation loop returns
the first non-ok response verbatim. Shards that already succeeded keep their
write. A partial failure therefore returns an error while leaving some shards
re-pointed and others stale, with no per-shard detail. `Promise.all` also
rejects wholesale if any stub fetch throws, so `internalError` returns `500` and
the partial state is entirely invisible.

The code comment says a partial fan-out "is repaired by retrying the same PUT",
which is true and relies wholly on the caller doing so. This matters most for
`DELETE`, the revocation path: a partial delete leaves some member logs still
delivering `delegation.required` to an endpoint the owner just revoked, while
the caller sees an error. The delivery path already has alarm-backed durable
retry; the control path has none.

**Acceptance criteria**

- PUT and DELETE responses carry per-shard outcomes (`shardsOk`, `shardsFailed`,
  or a per-index array) instead of collapsing to the first failure.
- Partial failure returns a status that distinguishes "nothing applied" from
  "partially applied" — `207`, or `200` with an explicit failure list.
- Either the fan-out is driven from a durable retry, or the caller's repair
  obligation is stated in the ADR and in the handler docstring.
- A test covers a shard failing mid-fan-out and asserts the response names it.

### M3 — bound the re-point write

`handlePutInstanceWebhook` and `handleDeleteInstanceWebhook` run
`UPDATE log_delegation_config … WHERE instance_key = ? AND webhook_source = ?`
with no bound, plus two `COUNT(*)` scans, inside a single DO request. The
motivating use case is an owner who "may operate many logs"; at tens of
thousands of member logs in one shard this is a large synchronous write against
DO CPU and time limits, with no batching, pagination, or cursor.

**Acceptance criteria**

- Rows touched per call are capped and continued via alarm, **or** a supported
  ceiling on member logs per instance is documented in the ADR with the
  behaviour above it stated.
- `idx_log_delegation_config_instance` is confirmed to serve the re-point
  predicate (it covers `instance_key`; `webhook_source` filters after).

### L1–L5 — hygiene

- **L1** Add `instance_key` and `webhook_source` to the base
  `CREATE TABLE IF NOT EXISTS log_delegation_config`. Today even a brand-new DO
  reaches them through the legacy `ensureLogConfigInstanceColumns` ALTER path,
  whereas the neighbouring `user_enabled`/`operator_enabled` appear in both the
  CREATE TABLE and a migration. Keep the migration for existing databases.
- **L2** Bind `webhook_source` as a parameter in `countInstanceMemberLogs`. Not
  injectable — it is a module constant — but every other predicate in the file
  is bound.
- **L3** Use `?? Infinity` on both sides of the `createdAt` `Math.min`.
- **L5** Delete `canopy-api/src/scrapi/auth.ts`. It exports `validateApiKey`, which
  logs `"[AUTH] API key validation stub - returning true"` and returns `true`
  unconditionally. It has no importers anywhere in the tree, so it is harmless
  today and a landmine the moment anyone wires it. SCRAPI's real auth is
  `Authorization: Forestrie-Grant`.
- **L4** Correct "CAIP-2 style" in the coordinator's `instance-key.ts` docstring
  and the canopy-api test name. The key is a bare decimal chain id and a 40-hex
  unprefixed address. ADR-0058 §2 carries the same error and is already queued
  for correction — fix both together so they do not drift.

## Design holes and non-obvious details

- **Shard-count changes have no backfill.** `instance_webhooks` joins
  `delegate_keys` as per-shard replicated state written only at registration
  time. Raising `COORDINATOR_SHARD_COUNT` gives new shards no instance replica,
  and `shardIndexForLog` remaps logs — so a remapped log silently loses its
  inherited webhook and reverts to pre-emptive supply with no error anywhere.
  Pre-existing pattern, newly widened by this change. Worth an explicit
  "changing shard count requires a rebuild" note in the ARC.
- **Provenance asymmetry is deliberate but easy to misread.** A per-log DELETE
  clears `webhook_source`, so a later instance re-point does not resurrect the
  URL. An instance DELETE leaves `webhook_source = 'instance'`, so a later
  instance PUT _does_ re-point those logs. Both are correct per the ADR; the
  contrast deserves a line in the handler docstrings.
- **`prepare` adds a `readRegistration` to the child-preparation path**, one per
  child. Cheap, but it is a new dependency of prepare on the registration store.
- **The grandchild gap is documented** — `prepare` resolves the instance one
  level up, so a grandchild whose parent holds no registration record of its own
  gets no binding. Recorded under "Deferred" in the ADR.
- **The convergence property is load-bearing and untested.** Correctness of a
  log registering concurrently with a fan-out rests on per-shard DO
  serialization. It holds, but no test pins it.

## Test coverage gaps

Existing coverage is good — 14 new coordinator cases including cross-shard
re-point, explicit-URL survival, delete semantics, case normalization, and an
end-to-end `delegation.required` delivery to an inherited webhook. Missing:

1. A log binding to an instance it does not own — absent because it is not
   rejected (H1).
2. Partial fan-out failure (M2).
3. Coordinator-side `0x`-prefixed instance key (M1).
4. Genesis when the coordinator is unreachable or slow on the new best-effort
   branch (H2).

## Branch assignment

| Item           | Where                                                                |
| -------------- | -------------------------------------------------------------------- |
| H1             | Follow-up branch off `main`; does not block #174                     |
| H2             | Fold into #174 — it is the branch that introduced the blocking call  |
| M1, M2, M3, M4 | Follow-up branch off `main`; M4's ADR-0058 half batches with devdocs |
| L1–L3          | Follow-up branch, batched                                            |
| L4             | Batch with the pending ADR-0058 §2 CAIP-2 correction in devdocs      |

## Deferred

- No admin UI for the re-point; it stays an app-token API call (already recorded
  as deferred in the ADR).
- Grandchild instance resolution beyond one level.
