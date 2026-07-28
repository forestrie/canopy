---
id: 2607-08
status: complete
created: 2026-07-28
refs: [ADR-0059, FOR-478, FOR-493]
---

# plan-2607-08 — FOR-478 ops enumeration: review remediation

**Related:** [FOR-478](https://linear.app/forestrie/issue/FOR-478) ·
canopy [#198](https://github.com/forestrie/canopy/pull/198) (merged `015ec77`) ·
consumer: [FOR-493](https://linear.app/forestrie/issue/FOR-493)

Review of `GET /api/payments/chain-bindings` (ops enumeration of the instance
registry with the x402-settlement receivables join), performed post-merge with
the backend/distributed-systems lens of
`forestrie-agents/workflow/commands/review-changes.md`. Live evidence gathered
against lane A (4 registered accounts; malformed-cursor probe returned 400).

## Scope summary

Single squash commit `015ec77` on `main`: new
`listUnivocityInstanceReservations` (instance-registry.ts), new handler
`chain-bindings-list.ts`, dispatcher wiring, 7 specs. Ops bearer gate placement
verified by test; spec minimum fields all delivered; holder/`claimedBy`
exposure matches the per-id ops inspection posture; the receivables join
reuses the sanctioned FOR-497 fronted read (control-plane, ops-authed — the
data plane stays off the ReceivablesDO).

## Remediation items

### R1 — invalid-cursor catch conflates infra failures (Medium)

`handleChainBindingsList` wraps the whole
`listUnivocityInstanceReservations` call in the try that maps a throw to
`400 invalid cursor`. The R2 `list()` throw on a malformed cursor is real
(live-verified 400 on lane A), but the same try also covers every per-key
`R2_GRANTS.get` — a transient R2 failure mid-page is misreported as a client
error, which misleads ops during exactly the kind of incident this route
exists to inspect.

**Fix:** wrap only the `R2_GRANTS.list()` call in the cursor try (inside
`listUnivocityInstanceReservations` or by splitting the page fetch); per-key
hydration failures propagate to the platform 5xx path.

**Acceptance:** unit test with an env whose `R2_GRANTS.get` throws (proxy over
the pool bucket) — response is 5xx, not 400; malformed-cursor behaviour
unchanged (400).

### R2 — serial R2 hydration on an interactive route (Medium)

The page loop awaits each `get` sequentially — a `limit=100` page is ~100
serial R2 round-trips before the (parallel) receivables join even starts. The
pattern was copied from the indexer's `listRegisteredAccounts`, where cron
latency is free; this route's consumer is the FOR-493 console, page-view
interactive.

**Fix:** hydrate the page's keys concurrently (plain `Promise.all` is
acceptable — the page cap bounds it at 100 and the Workers connection limit
self-throttles; chunking optional).

**Acceptance:** existing specs unchanged; ordering of returned rows remains
the R2 lexicographic listing order (sort or index-map after the concurrent
fetch).

### R3 — settlement 5xx degradation not pinned on the list path (Low)

Specs cover the join's 404 and not-configured degradations; a settlement 500
(or non-JSON body) path relies on client behaviour pinned only via the
account-read route.

**Fix:** one spec: stub settlement 500 → row degrades to `receivables: null`
with the upstream detail; listing stays 200.

## Deferred (Low, decide with FOR-493)

- **Accept-JSON negotiation:** the route is CBOR-only while its FOR-497
  sibling content-negotiates JSON for the mandate console. The FOR-493
  consumer is a server-side BFF that can decode CBOR
  (`@forestrie/encoding`; note the deterministic decoder returns **Maps**),
  so negotiation is convenience, not necessity. If the BFF lands CBOR-first,
  close as won't-do.
- **Global arming posture:** the issue named this route "the natural home for
  the slice-04 ops watermark-set tool's read side (the ENFORCEMENT_ARMED
  gate)". Per-account watermark is surfaced; the global `ENFORCEMENT_ARMED`
  flag is not surfaced by any ops read. If the console should show it, that
  is a small settlement (or canopy-fronted) posture read — new scope, not a
  defect here.

## Design notes for the consumer (no code change here)

**`enforcementFrozen` is the indexer-held freeze marker, not the effective
enforcement state.** ReceivablesDO records it only when the indexer itself
freezes/unfreezes (`setEnforcementFrozen` doc: a manual ops freeze keeps the
marker `false` so recovery never unfreezes it). Consequences for FOR-493:

- a manually frozen account reads `enforcementFrozen: false` in this
  enumeration — the console MUST NOT render the marker as "frozen state";
- effective state per instance = the kill-switch read
  (`GET /api/payments/registrations/{R}/enabled`, ops-gated), which FOR-493
  already plans to join lazily per row;
- the _combination_ is the manual-freeze discriminator FOR-493 wants:
  `enabled=false ∧ marker=false` ⇒ manual ops freeze;
  `enabled=false ∧ marker=true` ⇒ indexer (arrears) freeze.

## Branch assignment

R1–R3: one small canopy PR on this stream (`mandate-1` flow). Deferred items:
carried on FOR-493.

## Delivery

R1–R3 applied in the PR that carries this plan: tagged
`InvalidReservationCursorError` raised only for a rejected caller-supplied
cursor on `list()` (cursorless list failures and all hydration failures reach
the platform 500); page hydration is order-preserving `Promise.all`; specs
pin settlement-500 row degradation, get-throw → 500, and the cursor/cursorless
list-failure split (10 specs total on the route). The cron indexer's identical
serial-hydration pattern is tracked separately in Linear (_Performance and
scalability enablers_) — deliberately not changed here.
