# ADR-0005 — Delegation webhook notification delivery mechanism

**Status:** ACCEPTED
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
