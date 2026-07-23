---
Status: DRAFT
Date: 2026-07-23
Related: FOR-434, FOR-433, FOR-80 · devdocs plan-2607-38 · canopy#161
Reviewer lens: backend/implementation — distributed systems + applied cryptography
---

# plan-2607-01 — Paid onboard review remediation

Review of `robin/for-434-paid-onboard` (canopy#161, 5 commits, 10 files,
+690/−161) against devdocs `plan-2607-38`, ARC-0015, ARC-021 and the canopy
AGENTS.md gates.

**Verdict: DO NOT MERGE.** One demonstrated High finding (payment replay →
multiple tokens for one payment) and one latent High (a config value disables
payment verification entirely). Both are in the money path.

---

## Findings

| ID     | Sev               | Dim           | Location                                                                       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                 | Invariant                                                                  |
| ------ | ----------------- | ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **R1** | **High**          | Security      | `onboarding/handle-onboarding-request.ts` (paid branch) + `onboard-payment.ts` | **Payment replay: one signed authorization mints unlimited onboard tokens.** `idempotencyKey` embeds `requestId`, so it differs per request; nothing records the consumed EIP-3009 `nonce`; and mint-on-verify has no reservation. Pre-settlement the authorization is still unspent, so every `/verify` passes. **Demonstrated live on dev**: one $0.01 authorization minted **2** tokens across two pending requests. | Payment must be single-use. ARC-0015 idempotency intent.                   |
| **R2** | **High (latent)** | Security      | `onboard-payment.ts` `verifyOnboardPayment`                                    | `env.X402_MODE ?? "verify-and-settle"` — if `X402_MODE` is set to **`verify-only`** (a legal value in the `X402Mode` union and canopy-api's env), `verifyPayment` returns `isValid: true` **without calling the facilitator**. Any syntactically valid payload then mints a free token. Not exploitable today (both lanes are `verify-and-settle`) but it is one config edit from free tokens, with no guard.           | Payment must be verified by an authority, not asserted by the caller.      |
| **R3** | Medium            | Security      | `onboard-payment.ts`                                                           | **No local amount check.** `parsePaymentHeader` takes `amount` from the signed authorization (`x402.ts:216`) and validates only `network`/`payTo`. Enforcing that the payer signed ≥ the required price is delegated entirely to the external facilitator. Defence-in-depth gap on a money property.                                                                                                                    | Do not outsource a value check to a third party without also asserting it. |
| **R4** | Medium            | Liveness      | `onboard-payment.ts` `enqueueOnboardSettlement`                                | A failed/unbound enqueue is `console.error` only. Mint-on-verify means the token is already issued, so this is an **unsettled, unrecoverable receivable with no durable record** — no retry, no DLQ, no reconciliation row. A log line is not an accounting record.                                                                                                                                                     | ARC-0015 settlement durability; FOR-84 ledger.                             |
| **R5** | Medium            | Correctness   | `x402settlement.ts` `recordSuccess`                                            | The new `kind` / `requestId` / `onboardTokenRef` fields are carried on the job but **never persisted** by the DO (it already drops `logId`/`contentHash`). Fee attribution for onboard is therefore impossible today. Pre-existing, but this change adds the fields that make it look solved.                                                                                                                           | FOR-84 per-log fee accounting.                                             |
| **R6** | Low               | Best practice | `handle-onboarding-request.ts` `paymentRequiredResponse`                       | Hand-rolls a `problem+json` Response instead of the repo's `problemResponse()` helper used everywhere else in the file. Divergent error shape.                                                                                                                                                                                                                                                                          | Repo error-shape convention.                                               |
| **R7** | Low               | Security      | redeem handler                                                                 | No rate limit on redeem. Create is limited (`ONBOARD_CREATE_RATE_LIMITER`); the paid redeem makes an outbound facilitator call per attempt, so it is a cheap amplification vector.                                                                                                                                                                                                                                      | —                                                                          |
| **R8** | Low               | Best practice | `worker-env.ts` / `wrangler.jsonc`                                             | Price naming is now three-way inconsistent: `X402_PRICE_EXACT` (wrangler), `X402_PRICE_ATOMIC` (env type), `X402_ONBOARD_PRICE_ATOMIC` (new).                                                                                                                                                                                                                                                                           | —                                                                          |

### Behaviour changes worth recording (not defects)

- Redeeming a `pending` request returns **402** instead of 409 — deliberate, for
  x402 client compatibility, confirmed with the owner.
- `verifyRedeemCode` now runs **before** the state gate, so a wrong code against
  an already-redeemed request returns 401 rather than 409. This is a small
  improvement (less state disclosure to a caller without the code) but it is a
  change, and it is untested.

---

## Design holes & non-obvious details

- **Mint-on-verify needs a reservation, and the plan never said so.**
  `plan-2607-38` §3 argued verify-as-gate is correct for coarse, deliberate
  events. That reasoning still holds — but the plan silently assumed
  verify-then-mint is _atomic per payment_. It is not: verify is a stateless
  question about an unspent authorization, and the same authorization answers
  "yes" for every concurrent request until settlement lands. **The gap is in
  the design, not just the code**, so the plan must be amended alongside the fix.
- **The DO's idempotency does not help here.** It dedups on `idempotencyKey`,
  which by construction differs per `requestId`. Its `auth_state` is keyed on
  `authId` = `local:{payerAddress}` — per _payer_, not per _payment_ — and only
  reacts after repeated settle failures. Neither is a replay guard.
- **Blast radius is bounded but real.** `ONBOARD_MAX_PENDING_PER_BINDING` (3)
  caps concurrent pending requests per `(chainId, univocityAddr)`, so the naive
  attack yields ~3 tokens per payment; more bindings, more tokens. The value
  stolen is small at $0.01, but an onboard token is authority to open a
  payment-authoritative forest — the _credential_ is what matters, not the fee.
- **The e2e passed while the bug was present.** Both arms were green because
  the happy path never replays a payment. Adversarial cases, not happy paths,
  were what surfaced this — worth remembering for FOR-48 (paid grants), which
  will inherit the same mint-on-verify shape.

---

## Durability of the payment claim (answering "what if the store resets?")

**The chain is the ultimate backstop; the claim store only covers the
pre-settlement window.** Verified against the live facilitator:

```
verify BEFORE settle -> isValid: true
settle               -> success, tx 0xd369b805…
verify AFTER  settle -> isValid: FALSE  "invalid_exact_evm_nonce_already_used"
```

The facilitator simulates `transferWithAuthorization`, so once an authorization
has settled the **on-chain EIP-3009 nonce state** rejects it — no application
storage required. The R2 claim exists solely to close the window between
`verify` and settlement, during which the authorization is genuinely still
spendable and would otherwise verify for every concurrent request.

Consequences if `R2_GRANTS` were wiped:

| Authorization state                      | Replayable after a reset?            |
| ---------------------------------------- | ------------------------------------ |
| Already settled                          | **No** — chain rejects it            |
| Past `validBefore`                       | **No** — can never settle            |
| Claimed, unsettled, within `validBefore` | **Yes**, until it settles or expires |

So the exposure is bounded to authorizations in flight, and `maxTimeoutSeconds`
is 300 — a ~5-minute window, not an unbounded one.

**This also gives a safe TTL.** A claim record is useless once `validBefore` has
passed, because the authorization can never settle after that. Claims can
therefore be expired/pruned at `validBefore` without weakening the guard, which
bounds storage growth. Not implemented — see RM6.

## Remediation

### RM1 — Single-use payment guard (blocks merge) — R1

Record the payment's authorization `nonce` (or `sha256(from‖nonce)`) and refuse
reuse, **before** any state transition or mint.

- Store under a dedicated R2 key (e.g. `payments/used-auth/{hash}`) written with
  **etag CAS / if-none-match**, mirroring `claimOnboardTokenForestRCas`.
- Order: verify → **claim nonce (CAS)** → approve → redeem → mint → enqueue. A
  lost CAS race returns 409/402, never a second mint.
- The claim must be durable _before_ the mint, so a crash between them cannot
  release the nonce.
- Reuse the existing R2-CAS idiom rather than inventing a new store.

**Acceptance:** the demonstrated exploit (two pending requests, one
authorization) yields exactly **one** token and one settlement job; the second
redeem is rejected. Add it as a regression test — the miniflare harness can
drive it with a stubbed facilitator.

### RM2 — Refuse `verify-only` on the paid path (blocks merge) — R2

Do not let a mode flag disable payment verification.

- In `verifyOnboardPayment`, ignore `X402_MODE` and always perform a real
  facilitator verify; or fail closed if the resolved mode is `verify-only`.
- **Acceptance:** with `X402_MODE=verify-only`, a redeem carrying a bogus
  payment is rejected and mints nothing (unit test).

### RM3 — Assert the amount locally — R3

Compare the signed `authorization.value` against the required `priceAtomic`
before the facilitator call; reject underpayment. **Acceptance:** a payment
signed for 1 atomic unit is rejected with no facilitator round-trip.

### RM4 — Durable unsettled-payment record — R4

On enqueue failure or unbound queue, persist a reconciliation row (payer,
amount, nonce, requestId, onboardTokenRef, timestamp) rather than only logging.
**Acceptance:** with the queue unbound, the token still mints and a durable
record exists that a reconciliation job could read.

### RM5 — Persist `kind`/`requestId`/`onboardTokenRef` in the DO — R5

Extend `recordSuccess` so onboard settlements are attributable. Coordinate with
**FOR-84** (settlement ledger) rather than duplicating it.

### RM6 — Prune claim records at `validBefore` (follow-up)

Claim records currently accumulate without expiry. They are provably useless
after the authorization's `validBefore` (it can never settle), so pruning at
that boundary is safe. Carry `validBefore` on the claim record and add an R2
lifecycle rule or a scheduled sweep. Not urgent — records are tiny — but it is
unbounded growth on a hot path.

### Lows — DONE

R6 (`problemResponse` helper), R7 (redeem rate limit), R8 (dead
`X402_PRICE_ATOMIC` env field removed) are all implemented on this branch.

---

## Branch assignment

- **RM1, RM2, RM3** → current branch `robin/for-434-paid-onboard`. Merge is
  blocked until RM1 and RM2 land with tests.
- **RM4** → current branch if small, else a follow-up before any lane charges
  real money.
- **RM5** → FOR-84 (sibling), not this branch.
- **R6–R8** → follow-up issue.

Also amend devdocs `plan-2607-38` §3 to state that mint-on-verify **requires a
single-use payment claim**, so FOR-48 (paid grants) inherits the constraint
rather than the bug.
