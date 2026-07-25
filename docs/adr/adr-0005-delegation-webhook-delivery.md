# ADR-0005 — Delegation webhook notification delivery mechanism

**Status:** IMPLEMENTED
**Date:** 2026-06-21
**Related:**
[arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md),
[arc-checkpoint-delegation-isolation.md](../arc/arc-checkpoint-delegation-isolation.md),
[ARC-0015 x402 settlement architecture](../../../devdocs/arc/arc-0015-x402-settlement-architecture.md),
[plan-0021 delegation coordinator APIs](../plans/plan-0021-delegation-coordinator-apis.md)

---

## Context

### What "delivery" is, and where it goes

When Sealer (via the custodian proxy) calls `POST /api/delegations` on the
**delegation-coordinator** and there is **no stored material**, the coordinator
inserts a `pending` row and returns `202`. "Delivery" is the coordinator then
performing an **outbound HTTP POST of a `delegation.required` event** to the
**operator-registered `webhook_url`** (the `mandate-agent` endpoint). That is
the only thing this ADR concerns.

It is **not** the delegation material. Material flows the **other** direction:
operator → coordinator via the existing `POST /api/delegations/material`. That
path is unchanged.

```
Sealer ─POST /api/delegations─▶ coordinator   (miss → insert pending, 202)
coordinator ─POST delegation.required─▶ operator webhook_url   ← THIS ADR
operator ─POST /api/delegations/material─▶ coordinator         (unchanged)
Sealer ─POST /api/delegations─▶ coordinator   (now hit → 200 cert)
```

### Properties that shape the decision

- **The payload is not sensitive** (delegation binds Sealer's ephemeral key; see
  [isolation ARC](../arc/arc-checkpoint-delegation-isolation.md)). Delivery needs
  integrity + source auth, not confidentiality.
- **Polling is first-class.** `GET /api/logs/{logId}/pending-delegation` and
  `GET /api/delegations/pending` already let an operator discover pending work
  without any webhook. So a **lost webhook delivery is not fatal** — the
  operator's poller backstops it. This materially lowers the delivery-reliability
  bar.
- The coordinator is a **sharded Durable Object** worker; `pending` already
  lives in the DO. x402 settlement (ARC-0015) established the
  **Cloudflare Queue + consumer** pattern in this codebase for *at-least-once*
  async work.
- The hook is **stored but not invoked** in the current work; this ADR decides
  the **target** delivery design so the storage schema and ops are right.

## Options

### A. Synchronous `fetch` in the issue hot path
POST the event before returning `202`.
- − Adds operator-endpoint latency/failure into Sealer's request path; couples
  Sealer liveness to a third-party endpoint. Rejected.

### B. `ctx.waitUntil()` best-effort, after returning `202`
Fire the POST in the background of the same invocation.
- + Trivial; no new infra; off the hot path.
- − Single attempt; a transient operator outage drops the notification (polling
  recovers it).

### C. Durable Object alarm-backed retry
Record the pending notification; the DO `alarm()` retries delivery a few times
with backoff, then gives up (polling remains the backstop).
- + No new infra (the coordinator is already a DO); retries + bounded state
  co-located with `pending`; good latency.
- − Slightly more DO logic; retry budget is per-DO.

### D. Cloudflare Queue producer + consumer (mirror x402-settlement)
Enqueue a delivery job; a consumer worker delivers with retries + DLQ.
- + Strong at-least-once, DLQ, independent scaling/observability; matches an
  existing pattern.
- − New queue + consumer worker to provision/operate for a notification that
  polling already backstops; heaviest option.

## Decision

Adopt **B + C**: deliver best-effort via `ctx.waitUntil()` from the issue path,
then **retry on a bounded DO-alarm ladder** recorded in `DelegationStoreDO`.
**Do not** stand up a Cloudflare Queue (option D) for this purpose unless a
future webhook-delivery SLO demands DLQ + independent scaling.

B + C is **directionally aligned with a future queue-based delivery** (option
D) — same event, same idempotency key, same retry semantics — **without
provisioning the queue + consumer infrastructure now**. Escalating to D later
changes only the transport, not the event or the receiver contract.

Rationale: because **polling is first-class**, the notification is an
*optimization*, not a system-of-record event; at-least-once infrastructure is
not justified. B+C keeps delivery co-located with the `pending` state that
triggers it, adds no new infrastructure, and degrades gracefully to polling.
Revisit (escalate to D) only if operators come to depend on webhook delivery
SLAs.

### Retry ladder configuration

Delivery retry is **worker-configurable** (per-deployment, not per
registration):

- **`retryLadder`** — a list of integers; the per-step backoff multipliers
  (e.g. `[1, 2, 4, 8]`). Its **length bounds the retry budget** — after the
  ladder is exhausted the coordinator gives up and polling backstops.
- **`retryScale`** — the base backoff unit in **milliseconds** (e.g. `1000`).

The wait before retry *n* (0-indexed into the ladder) is:

```
wait(n) = retryLadder[n] * retryScale + jitter
jitter  = uniform random in [0, retryScale / 2)   // recomputed per attempt
```

Worked example — `retryLadder = [1, 2, 4, 8]`, `retryScale = 1000`:

| Retry | Base wait | + jitter range |
|-------|-----------|----------------|
| 1     | 1000 ms   | [0, 500) ms    |
| 2     | 2000 ms   | [0, 500) ms    |
| 3     | 4000 ms   | [0, 500) ms    |
| 4     | 8000 ms   | [0, 500) ms    |

i.e. ~1 s, then ~2 s, then ~4 s, then ~8 s between attempts, each padded by up
to half a scale unit of jitter to avoid thundering-herd retries against a
recovering operator endpoint. The initial `ctx.waitUntil()` POST is **attempt
0** (no wait); the DO `alarm()` schedules attempts `1..len(retryLadder)`.

## Consequences

- Storage must retain enough per-pending state for bounded retry (retry-ladder
  index, attempt count, next-attempt time) — fits in the DO alongside `pending`
  / `signing_routes`.
- `retryLadder` / `retryScale` are worker configuration; sensible defaults are
  `[1, 2, 4, 8]` / `1000` ms (≈15 s total budget before falling back to
  polling).
- Receiver must be **idempotent** on `requestKey` (the deterministic key from
  the registration ARC; B+C ⇒ at-most-a-few deliveries).
- This ADR governs **invocation**, which is **out of scope** for the
  current "register + store, do not invoke" milestone; it is the committed
  target for when invocation lands.
- If escalated to D later, the event schema (in the registration ARC) is
  unchanged — only the transport differs.

---

## Amendment — 2026-07-25: role, identity, and instance-level inheritance

Status of this amendment: **Accepted**. Settles questions that were open or
ambiguous when this ADR was first written. Nothing in the delivery decision
(B+C, DO alarm-backed retry) changes.

### The webhook's role is delegation signing, and only that

The coordinator emits exactly one event type, `delegation.required`
(`delegation-coordinator/src/webhook/build-delegation-required-event.ts`), fired
from `DelegationStoreDO`. There is no second role.

**It is not the "sealer nudge".** That name belongs to a different mechanism in
a different service: ranger publishing seal hints to the sealer, specified in
[arbor ADR-0007 low-latency-sealer-trigger](https://github.com/forestrie/arbor/blob/main/docs/adr/adr-0007-low-latency-sealer-trigger.md)
and arbor plan-2607-01. The two are unrelated, and the naming collision has been
corrected in `canopy-api/src/forest/forward-coordinator-registration.ts`.

### The webhook is not an identity dimension

It was considered as a source of account identity for canopy receivables (the
registration's webhook domain). **Rejected.** Account identity is
`chainBinding { chainId, univocityAddr }`, already carried on
`RegistrationRecord`. The webhook is a delivery endpoint, not a principal, and
overloading it would have coupled billing identity to an operational callback
that an owner may legitimately never configure.

### Absence is a supported configuration, not a gap

A log with **no** webhook is never sent `delegation.required` —
`enqueueWebhookDelivery` returns when `webhook_url` is absent or the log is not
enabled. That is the deliberate other half of a trade-off available to every log
owner:

- **Register a webhook** and be asked when a delegation is needed; or
- **Pre-supply the delegation** ahead of need and never be asked.

Child logs registering without a webhook (ADR-0053 auto-forward / prepare) are
exercising the second option, not hitting a limitation.

### Instance-level webhooks, inherited by copy

A univocity instance owner may operate many logs and hold custody of most or all
of their signing keys. Requiring a separate webhook registration per log is
friction with no benefit, so an **instance-level webhook serves every log of
that instance**.

Two things already support this and are unchanged:

- The event **already identifies the log** — `DelegationRequiredEvent` carries
  `logId`, `authLogId`, the MMR range, `delegatedPublicKey` and
  `certificateSubmitUrl`. **No payload change.**
- Absence still means pre-supply-only, per above.

**Mechanism: inherit by copy.** Webhook config is a per-log row
(`readDelegationConfigRow`) inside a *shard-addressed* Durable Object, with logs
routed to shards by log id (`delegation-coordinator/src/handlers/handler.ts`).
Sibling logs of one instance therefore land in **different shards**, so an
instance-level value is not locally reachable from a given log's shard. The
instance webhook is therefore **written into each log's config row at
registration time**.

*Rejected alternative — inherit by reference* (look up an instance-level record
when the log row is empty): single source of truth and trivially re-pointed, but
it adds a cross-shard hop plus a cache decision to the delegation request path.
That path is the **primary** one — delegate signing is the only model serving
operator-hosted sealing at scale, with direct-key signing reserved for the
far-future self-host path or the current custodian — so a rare fan-out write is
the better trade than a hop on every request.

**Accepted cost:** re-pointing an instance's webhook requires a fan-out update
across that instance's logs. An explicit re-point operation is required.

### Receiver obligation

A receiver serving many logs from one endpoint **must verify the event's `logId`
is a log it owns** before signing, rather than signing whatever arrives. The
blast radius is bounded — it can only sign with keys it holds — but "I hold this
key" and "I should sign for this log now" are different assertions, and an
instance-level webhook widens the set of logs a single endpoint is asked about.
This is in addition to the existing JWKS signature check and `requestKey` dedup.

*Tracked as FOR-468.*

### What shipped (FOR-468)

Recording the realization; the decision above is unchanged.

**Instance registry, replicated per shard.** `instance_webhooks (instance_key,
webhook_url, …)` is written to **every** shard, the same way delegate-key
registration already fans out. A log's own shard can therefore read its
instance's URL locally and copy it into `log_delegation_config` at registration,
so even the copy costs no cross-shard hop.

**Provenance decides what a re-point may overwrite.**
`log_delegation_config.webhook_source` is `'log'` for a URL set directly on the
log, `'instance'` for a copy, and NULL for rows that pre-date instances or whose
owner cleared the webhook. `PUT /api/instances/{instanceKey}/webhook` rewrites
only `'instance'` rows — so an explicit per-log webhook survives a re-point, and
a deliberate `DELETE /api/logs/{logId}/webhook` is not undone by one. A log
re-opts in with `PUT /api/logs/{logId}/webhook { instanceKey }`.

**Instance key.** `{chainId}:{univocityAddr}` — a rendering of the
`chainBinding` already carried on `RegistrationRecord`, so no second notion of
account is introduced. The coordinator treats it as an opaque label and never
resolves it on chain.

**Where the binding gets registered.** canopy-api sends `instanceKey` on the
genesis coordinator forward, and `POST /api/forest/{child}/prepare` derives it
from the **parent's** registration record — which is what makes ADR-0053 child
logs inherit with no per-child registration. Genesis with no explicit
`webhookUrl` now forwards the binding **best-effort**: that path forwarded
nothing at all before, so a coordinator failure leaves genesis no worse off and
is reported in `coordinator.webhook` rather than being fatal. An explicit
`webhookUrl` keeps its existing strict behaviour. The webhook step reports
`inherited` when only a binding was registered — the log takes whatever the
instance has, which may legitimately be nothing.

**Receiver.** The in-repo reference receiver
(`packages/tests/e2e-kit/src/mode-c-webhook-receiver.ts`) now checks the event's
`logId` against the set of logs it owns and answers `403` otherwise, in addition
to the JWKS signature check and `requestKey` dedup, and signs for the log the
event names rather than a single configured one.

**Deferred.** No admin UI for the re-point — it is an app-token API call.
`prepare` resolves the instance one level up, so a grandchild whose parent has
no registration record of its own gets no instance binding; that log registers
against the instance explicitly, or pre-supplies.
