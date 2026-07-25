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

| ID  | Sev             | Dim           | Location                                                                                                         | Finding                                                                                                                                                                                                                                                      | Invariant / rule                                                                                              |
| --- | --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| H1  | Medium (fixed)  | Security      | `delegation-coordinator/src/handlers/put-webhook.ts:39`                                                          | A log can bind itself to **any** univocity instance with no proof it belongs to that instance; leaks that instance's webhook URL and aims signed events at it. No authority escalation — the certificate is bound to its logId and the log's registered root | ARC-0017 dual-token authority: an issuer token is authority over _its_ log                                    |
| H2  | **Medium-High** | Liveness      | `canopy-api/src/forest/handle-forest-request.ts:145`                                                             | Genesis now makes two blocking, untimed coordinator calls on a path documented as best-effort                                                                                                                                                                | Genesis is the primary onboarding path                                                                        |
| M1  | Medium          | Correctness   | `forest/instance-key.ts` · `payments/resolve-payment-ancestor.ts` · `delegation-coordinator/src/instance-key.ts` | One concept, three renderings, three disagreeing validators (`0x` stripped / kept, CAIP-2 accepted / rejected). Adopt **CAIP-10** as the single canonical form                                                                                               | One spelling per identity — a second spelling silently splits a namespace                                     |
| M2  | Medium          | Liveness      | `delegation-coordinator/src/handlers/instance-webhook.ts:55`                                                     | Re-point and delete fan out non-atomically, report the first failure only, and self-repair only if the caller retries                                                                                                                                        | Revocation must not half-apply                                                                                |
| M3  | Medium          | Scale         | `delegation-store.ts` `handlePutInstanceWebhook`                                                                 | A re-point is one unbounded synchronous `UPDATE` plus two `COUNT(*)` per shard                                                                                                                                                                               | Motivating case is an owner operating _many_ logs                                                             |
| M4  | Medium          | Correctness   | same files                                                                                                       | `univocityInstanceId` (authority hierarchy) and `univocityPaymentInstanceId` (payment graph) are different entities; under CAIP-10 they share a format, so branded types and column naming must carry the distinction                                        | ARC: the two graphs must stay separate; glossary: "Avoid: conflating with the per-forest authority hierarchy" |
| L1  | Low             | Best practice | `delegation-store.ts:358`                                                                                        | New columns live only in the migration path, not the base `CREATE TABLE`                                                                                                                                                                                     | Inconsistent with the neighbouring `ensureEnabledAuthorityColumns`                                            |
| L2  | Low             | Best practice | `delegation-store.ts` `countInstanceMemberLogs`                                                                  | `webhook_source` interpolated into SQL rather than bound                                                                                                                                                                                                     | Every other predicate in the file is bound                                                                    |
| L3  | Low             | Correctness   | `instance-webhook.ts:124`                                                                                        | `Math.min(createdAt ?? Infinity, shardResult.createdAt ?? 0)` collapses to `0` if any shard omits `createdAt`                                                                                                                                                | Latent only                                                                                                   |
| L5  | Low             | Best practice | `canopy-api/src/scrapi/auth.ts`                                                                                  | Dead API-key stub returning `true` unconditionally, with no importers                                                                                                                                                                                        | Fail-open code should not sit unused in the tree                                                              |
| L4  | ~~Low~~         | Docs          | _superseded by M1/M4_                                                                                            | "CAIP-2 style" wording — the format now **becomes** CAIP-10 rather than being redescribed                                                                                                                                                                    | Folded into M1/M4                                                                                             |

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

### M1 — one canonical identifier format: CAIP-10

**Decision (2026-07-26):** both identifiers adopt **CAIP-10**, and both are
renamed off "key" — see M4. This section covers the format; M4 covers keeping
the two apart once they share it.

Today one concept has three renderings and three disagreeing validators:

| Producer                                     | Emits                 | `0x`       | CAIP-2 chain id                               |
| -------------------------------------------- | --------------------- | ---------- | --------------------------------------------- |
| `liableAccountKey` (payments)                | `84532:4242…`         | **throws** | **throws**                                    |
| `instanceKeyFromStoredChainBinding` (forest) | `84532:4242…`         | strips     | accepts → _third_ format `eip155:84532:4242…` |
| `normalizeInstanceKey` (coordinator)         | whatever it was given | **keeps**  | accepts                                       |

There is no design reason for the divergence. `liableAccountKey` was written
strict, with a docstring explaining why. `instanceKeyFromStoredChainBinding`
came later and is commented "Mirrors the coordinator's accepted instance-key
shape" — it mirrored the coordinator's loose validator instead of the strict
sibling in its own worker. The coordinator is loosest because it treats the
value as "an opaque label"; but opacity means _do not interpret it_, not _accept
several spellings of it_, and accepting several is what manufactures a split
namespace.

**Target form.** CAIP-10 account identifier — `namespace:reference:address`:

```
eip155:84532:0x4242424242424242424242424242424242424242
```

CAIP-10 is chosen over the ad-hoc `{decimal}:{hex40}` because it is
standard, self-describing, and **chain-agnostic by construction** — which is
what the coordinator's "opaque label" instinct was reaching for. The coordinator
can validate the shape without knowing what `eip155` means.

**Canonicalization rules — one spelling, no exceptions.**

- Namespace and reference per CAIP-2 (`[-a-z0-9]{3,8}` : `[-_a-zA-Z0-9]{1,32}`).
- For `eip155`, the reference is a bare decimal chain id and the address is
  `0x` + 40 hex.
- **Lowercase the address on normalize.** Mixed-case input is accepted and
  lowercased so an EIP-55 checksummed address cannot split an account — the same
  hazard `liableAccountKey` already guards, carried forward rather than dropped.
- Everything else is **rejected** with a `400` naming the canonical form. No
  silent repair: stripping `0x` in one place and not another is the bug, and a
  second repair site just moves the seam.

**Adapter from stored records.** `chainBinding { chainId: "84532",
univocityAddr: "4242…" }` renders as `eip155:84532:0x4242…` through a single
documented function. The bare-decimal → `eip155` mapping is an EVM assumption
and should be explicit and asserted, not implied, so a future non-EVM instance
fails loudly rather than being mislabelled.

**Acceptance criteria**

- One canonical form, one parser per worker, agreeing against a **shared test
  vector table** so drift fails CI. Duplicated rule, shared vectors — a shared
  publishable lib drags in the FOR-401 version-bump gate for one regex.
- Non-canonical input (`84532:4242…`, missing `0x`, CAIP-2 chain id with no
  address, mixed separators) is rejected with a message naming the canonical
  form, at **both** canopy-api and the coordinator.
- Checksummed and lowercase addresses resolve to one identifier.
- The `canopy-api/test/instance-key.test.ts` case pinning
  `eip155:84532:4242…` — the accidental third format — is deleted and replaced
  with rejection and canonicalization cases.
- `PUT /api/instances/{id}/webhook` returning `memberLogs: 0` is documented as
  the signal of a mistyped identifier.

**Do it now, before #174 merges.** Nothing is stored under the current format in
production: `ReceivablesDO` is deployed but inert (FOR-435 steps 3–5 unbuilt),
and `instance_webhooks` does not exist yet because #174 is unmerged. This is a
definition change today and a live-data migration afterwards.

### M4 — two identifiers, one format: keep them apart by type

Adopting CAIP-10 for both (M1) buys one parser and one spelling, and gives up
the structural separation a differing representation would have provided. The
two are now visually near-identical, so the separation has to be carried by
naming, types, and column names instead.

They remain **different entities**, and the ARC calls keeping the two graphs
apart "the crux of the model":

|                              | Reads                                                                       | Graph                                                           | Answers                            |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `univocityInstanceId`        | the log's **own** chain binding (genesis), or its **parent's** (prepare)    | univocity authority hierarchy, within one forest / one contract | who holds this log's signing keys  |
| `univocityPaymentInstanceId` | the **payment-authoritative ancestor's** binding, via the `endorsedBy` walk | payment-registration graph, across forests                      | who reimburses canopy for this log |

For a **regular** forest these resolve to different univocity instances. They
coincide only when the root is itself payment-authoritative — which is exactly
the case a test is most likely to cover, so a swap can pass CI.

FOR-468's choice is **correct**: `delegation.required` must reach whoever holds
custody of the log's keys, which is the authority hierarchy, not the payer. An
earlier draft of this review proposed unifying the two; withdrawn.

**Renames.** Neither is a cryptographic key, and this codebase is saturated with
real ones (root, delegate, custody, COSE, `delegatedPublicKey`, `bootstrapKey`),
so "key" meaning _map key_ is not the default reading:

- `instanceKey` → **`univocityInstanceId`**
- `liableAccountKey` → **`univocityPaymentInstanceId`**

The glossary term is "payment-authoritative", which the second name shortens;
prose should say "the payment-authoritative root's instance" explicitly so the
tie to the glossary survives.

**Acceptance criteria**

- Branded (nominal) TypeScript types so the two cannot be passed
  interchangeably, minted only by their own constructors:

  ```ts
  export type UnivocityInstanceId = string & {
    readonly __brand: "UnivocityInstanceId";
  };
  export type UnivocityPaymentInstanceId = string & {
    readonly __brand: "UnivocityPaymentInstanceId";
  };
  ```

- The **format parser is shared**; the **constructors are not**.
  `univocityPaymentInstanceId` is mintable only from a `resolvePaymentAncestor`
  result, so it cannot be produced from a log's own binding by accident.
- The distinction survives where the brand is erased — at SQLite columns, DO
  ids, JSON wire fields and route segments. Name them accordingly
  (`log_delegation_config.univocity_instance_id`, and a receivables DO id that
  names the payment graph), because a `string` at those boundaries carries no
  type.
- ADR-0005 records that instance webhooks follow the authority hierarchy and are
  deliberately **not** the payment graph, pointing at ADR-0058.
- ADR-0058 §2 is amended: the account is the **payment-authoritative
  ancestor's** instance, not simply "the log's instance" — and the format is
  **CAIP-10**, not "CAIP-2" as currently written. This batches with the
  correction already queued for that section.

**New consequence of choosing CAIP-10 for both — record it.** `one contract ↔
one rootLogId` is asserted by the ARC but **not enforced**; there is no
uniqueness constraint on `chainBinding` anywhere. Under a chain-derived
`univocityInstanceId`, two roots sharing a contract collapse to **one** instance
and therefore share one instance webhook. That is almost certainly the intent —
same contract implies same operator — but it is now load-bearing on an
unenforced invariant. Either enforce uniqueness at registration, or state the
assumption in the ARC.

**Branch:** M1 and M4 ship together — same files, and strictness without the
renaming leaves two identical-looking identifiers that merely validate the same.
The ADR-0058 §2 half batches with the pending devdocs correction.

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
- **L4** _Superseded by M1/M4_ — the format becomes CAIP-10, so the wording is rewritten rather than corrected. Original note: correct "CAIP-2 style" in the coordinator's `instance-key.ts` docstring
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

| Item    | Where                                                                      |
| ------- | -------------------------------------------------------------------------- |
| H1      | Follow-up branch off `main`; does not block #174                           |
| H2      | Fold into #174 — it is the branch that introduced the blocking call        |
| M1 + M4 | One branch, together — same files, before #174 merges (nothing stored yet) |
| M2, M3  | Follow-up branch off `main`                                                |
| L1–L3   | Follow-up branch, batched                                                  |
| L4      | Superseded by M1/M4                                                        |
| L5      | Follow-up branch, batched with L1–L3                                       |

## Deferred

- No admin UI for the re-point; it stays an app-token API call (already recorded
  as deferred in the ADR).
- Grandchild instance resolution beyond one level.
