---
id: 2607-04
status: draft
created: 2026-07-27
refs: [FOR-477, ADR-0059, ADR-0058, plan-2607-43]
---

# plan-2607-04 — registration block as the indexer metering floor

Closes the first-sight metering miss (FOR-477, observed live 2026-07-26:
two `CheckpointPublished` events on `eip155:84532:0x53f2c45b…` landed one
block before the indexer's first sweep and are permanently unmetered under
observe-forward).

## Decision: registration block, not deployment block

FOR-477 as filed specified recording the univocity contract's **deployment
block** (binary-search discovery over `eth_getCode`, ~26 RPC calls). This
plan supersedes that with the **registration block** — the chain head
observed when the reservation completes to `registered` at genesis:

- **More correct.** The operator bills for anchored checkpoints during the
  service relationship. A BYOK instance that self-anchors checkpoints
  before ever onboarding must not be billed retroactively for them; a
  deployment-block floor would do exactly that. The fact billing needs is
  *when the account entered the registry* — and genesis is the one moment
  canopy-api is guaranteed present to observe it.
- **Trivially cheap.** One `eth_blockNumber` call
  (`ethRpcWithFailover`) synchronous at genesis, vs a 26-probe bisect that
  forced an async/`waitUntil` design to keep off the paid path.
- **Safe against head lag.** A stale `latest` only *lowers* the floor
  (over-scan), never raises it; accrual is idempotent per event. A tx sent
  after registration can never land in an already-mined block, so no
  safety margin is needed. In every live flow the first anchor tx comes
  from the coordinator's sealer strictly after `delegate`, which follows
  registration.

Vocabulary: the field is **`registrationBlock`**. `deploymentBlock` must
not appear anywhere — the concept it names was rejected here.

## Design

### 1. Record at genesis (canopy-api, writer of record)

`src/payments/instance-registry.ts` — `InstanceReservation` gains
`registrationBlock?: number | null`, written when the record transitions
to (or is directly created as) `registered`:

- `completeUnivocityInstanceReservation` takes the value from the caller;
  both the CAS-completion path and the direct-create (legacy
  bindingless-token / no-reservation genesis) path record it.
- The forest handler (`src/forest/handle-forest-request.ts`,
  `completeInstanceClaim` / `finishGenesisPost`) fetches it: one
  `eth_blockNumber` via `ethRpcWithFailover` against the binding chain's
  configured RPC urls, short timeout (~2s), **best-effort** — on failure
  record `null` and proceed. Genesis never blocks on RPC (FOR-477
  posture).
- Write-time validation: positive safe integer; else `null`.
- `decodeReservation` stays tolerant (field optional; old records valid).

### 2. Consume at first sight (x402-settlement, read-only)

`src/indexer/instance-accounts.ts`: surface `registrationBlock` on
`AccountRef` (tolerant: absent/null/garbage → undefined).

`src/indexer/run-indexer.ts` first-sight order becomes:

1. watermark (unchanged, always wins once set)
2. `registrationBlock` number → scan from that block **inclusive**
3. `registrationBlock` explicit `null` within the repair grace (1h of
   `reservedAt`) → **hold first sight** — observe-forward would initialise
   the forward-only watermark and make the ops repair inert within one
   cron tick (plan-2607-05 R1a)
4. else (legacy absent field, or null past grace) observe-forward from
   safe head

### 3. Delete `INDEXER_BACKFILL_FROM_BLOCK`

Removed outright, not demoted (grilling 2026-07-27): every registered
account already has a watermark, so the knob is dead for existing
accounts; `registrationBlock` governs all future ones; DO-state loss is a
reconciliation problem (ADR-0058 §7) the knob never solved; runaway scans
are bounded by `maxRanges` and fixed by repairing the record. Delete
`backfillMap()`, the `Env` field, its docs (plan-2607-03 R5 posture is
superseded), and unset the var in deployed lane-A settings.

The per-chain floor sketched in FOR-477 is YAGNI: nothing chain-level
consumes a floor; `min(registrationBlock)` per chain is derivable on
demand.

### 4. Ops repair verb (canopy-api)

`PATCH /api/payments/chain-bindings/{id}` (ops-authed, joining the
existing R4 GET/DELETE): body `{"registrationBlock": <int>}`, CAS write,
404 on missing record, validation as above. This is the *only* mutation
path — an owner-facing (bootstrap-key-attested) update was considered and
rejected: the floor is the operator's meter; the account owner must not
control it (an inflated floor pre-first-sight is a billing bypass).

### 5. No bulk backfill (non-goal)

Existing registered records are left without `registrationBlock`: their
watermarks are set, the floor is only consulted before first sight, so
backfilled values would be inert. "Repairable via the ops surface" is
satisfied by §4.

## Non-goals

- Recovering the two missed live events — the watermark is forward-only
  by design; ADR-0058 §7 reconciliation is the backstop.
- Client-supplied deployment/registration hints on the onboard wire.
- Any chain-level (per-chain min) floor plumbing.

## Delivery

Single canopy PR (both apps live in this monorepo): registry schema +
genesis write + ops PATCH + indexer consumption + knob deletion + tests.
Branch `mandate-1`; no FOR id in PR title/branch; squash-merge.

Verification:

- Unit: registry write/CAS paths (incl. null posture), PATCH validation
  and auth, indexer first-sight order (registrationBlock / null /
  legacy-absent), tolerant decode both sides.
- `pnpm check` (naming gate: assert `deploymentBlock` absent).
- Lane A live proof after merge auto-deploy: fresh demo-flow instance
  (ietf-126-demo `preflight.sh` shape), publish immediately after
  registration, confirm the indexer log line shows the watermark
  initialised at the recorded `registrationBlock` and the earliest
  checkpoints accrue (the FOR-477 live-evidence scenario, now counted).
- Confirm `INDEXER_BACKFILL_FROM_BLOCK` gone from deployed vars (CF API
  `workers/scripts/{name}/settings`).

## Trace

- FOR-477 (comment records the deployment→registration pivot; retitled).
- Grilling session 2026-07-27 (this plan is its record; no ADR — the
  choice is reversible: nullable field, tolerant readers).
