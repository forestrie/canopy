# plan-2607-10 — plan-2607-46 (root binding) review remediation

**Status:** DRAFT
**Date:** 2026-07-30
**Related:** devdocs plan-2607-46 (slices 01–04); FOR-506 (canopy#203, merged),
FOR-507/FOR-508 (canopy#204, open); review run 2026-07-30 per the
forestrie-agents review-changes command — 3 parallel lenses
(security/crypto, correctness/liveness, tests/devops), High/Medium claims
re-verified (including live GitHub-environment checks for R3).

## 1. Scope

canopy `mandate-1`, diff `e994980..79678a1` (commits b03f492 = slices 01+02,
79678a1 = slices 03+04). No Graphite metadata — single branch vs main,
reviewed as one body of work. Backend-implementation lens per the command.

## 2. Findings

| ID  | Sev              | Dim                  | Where                                                                                                      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Medium           | Correctness/Security | `handle-onboarding-request.ts` `reissueRedeemedToken` (slice 02, merged)                                   | Re-redeem is three unfenced writes (mint → revoke(previousRef) → plain `writeOnboardRequest`, no etag CAS unlike the approved→redeemed transition). Two concurrent re-redeems both mint and both revoke the SAME old ref → two active tokens, last ref-write wins; a crash between mint and revoke (or revoke and write) leaves an orphaned ACTIVE token unreachable by any future re-redeem (each revokes only `record.onboardTokenRef`). The stated "at most one active token per request" invariant does not hold. Mitigants (all verified): only the redeemCode holder can trigger it; crash-orphans' plaintext never left the server; token TTL bounds exposure; liveness sound (never zero usable tokens). Found independently by all three lenses. |
| R2  | Medium           | Security             | `ks256-rpc-verify-hooks.ts` `swallowingKs256VerifyHooks` → DO cert-verify + onchain-proof sites (slice 03) | RPC outage collapses to a 403-shaped verdict on the certificate and onchain-delegation-proof paths: `hasContractCode` swallowed to `false` drops a Safe root into (failing) EOA recovery → "invalid certificate" — "could not ask the contract" rendered as "the contract said no", against the standing unavailable-is-never-a-verdict invariant. Pre-existing shape (old hooks swallowed too) deliberately preserved by slice 03, but the wallet-challenge path is now strict-503, making the inconsistency explicit and load-bearing for Mode D cert submission during RPC outages.                                                                                                                                                                    |
| R3  | Medium (enact)   | DevOps               | `chain-rpc-selection.ts` precedence + `wrangler.jsonc` checked-in defaults                                 | `SUPPORTED_CHAINS_RPC` (now checked in keyless for dev AND prod env blocks) wins over the keyed `KS256_RPC_URL` secret. **Verified live:** dev GitHub env has the `RPC_URL` secret → the deploy contract injects the keyed endpoint (fine); **prod has NO `RPC_URL` secret** → injection never fires and the keyless public RPC shadows a possibly-set keyed `KS256_RPC_URL` wrangler secret — a silent keyed→public downgrade on that lane.                                                                                                                                                                                                                                                                                                              |
| R4  | Medium           | Tests                | `scripts/assert-lane-wiring.mjs`                                                                           | The coordinator's new runtime-contract injection block has zero coverage (the script exercises only canopy-api + x402-settlement). A dropped/typoed injection ships as silent public-RPC fallback — compounds R3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R5  | Medium           | Tests                | canopy-api genesis tests (slice 01)                                                                        | The probe→cache→genesis SUCCESS path is never exercised: every worker genesis test seeds the cache (`seedGenesisChainIdentity`); the only RPC-path test is failing-fetch→503. A probe-writer/gate-reader cache-key mismatch (e.g. address normalization drift) would fail every cold-cache first genesis in deployment with CI green. No 503-then-successful-retry test either.                                                                                                                                                                                                                                                                                                                                                                           |
| R6  | Medium           | Tests                | `chain-rpc-selection.ts`                                                                                   | Zero unit tests; in particular nothing proves the deprecated `KS256_RPC_URL` fallback still works AND is chain-asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R7  | Medium (dormant) | Correctness          | `post-genesis.ts` univocity-forward path                                                                   | `fwd.kind === "exists"` returns `alreadyExisted` with NO byte-diff (the R2 path's new 409 check does not apply), and `univocity-genesis-client.ts` maps ALL 409s to `exists`. Separately: forward `created` followed by a failed local `R2_GRANTS.put` → 500, and the retry returns success via `exists` without EVER writing the local copy that the file header declares authoritative for reads until first checkpoint → GET genesis 404s indefinitely. Dormant today — `UNIVOCITY_SERVICE_URL` is unset on every lane.                                                                                                                                                                                                                                |

### Lows (defer)

- L1 gate-cache TTL: a genesis matching a superseded on-chain
  `bootstrapConfig()` is admitted for ≤300 s after rotation — ops-doc note,
  not a code change (cache is rewrite-on-miss only, chain-sourced).
- L2 `eth_chainId` per-isolate memo never expires — bounded by isolate
  lifetime; failures already un-memoized; acceptable for Workers.
- L3 `ensurePublicRootChainColumn`: try/catch masks transient SELECT errors
  then throws "duplicate column" (idiom-consistent with FOR-468 helpers, and
  `ensureSchema` inside `alarm()` can wedge on transient storage errors —
  pre-existing class); fresh DBs should carry `chain_id` in the base
  `CREATE TABLE`; the FOR-468 docblock is now orphaned above the new method.
- L4 COALESCE keep-vs-set of `chain_id` untested (a revert to plain
  `excluded.chain_id` would wipe bindings → contract roots fail closed).
- L5 reissue re-emits `onboard.request.redeemed` webhook — no in-repo
  consumer assumes exactly-once; note for external consumers.
- L6 bare `pnpm deploy` (no `--env`) would ship top-level TEST vars incl.
  the 31337 entry — CI never uses it; wrangler env vars REPLACE (not merge)
  top-level, so CI deploys are clean (verified).

## 3. Remediation items

### On PR #204 (branch `mandate-1`)

1. **R2 — strict cert-verify boundary:** propagate `Erc1271UnavailableError`
   out of `validateByokDelegationCertificate` / the onchain-proof site and
   map to 503 at the DO response boundary (mirror the wallet-challenge
   verdict taxonomy). Acceptance: unit test — RPC outage during KS256 cert
   verify → 503, never 400/403; EOA path unaffected.
2. **R3 — close the prod downgrade:** set the `RPC_URL` secret on the prod
   GitHub environment (mirrors dev; ops step, listed as enact-time check)
   OR drop the checked-in prod keyless default so the deprecated secret
   keeps winning until injection is armed. Record the chosen posture in the
   PR. Add a one-line startup/info log naming which RPC source served a
   chain the first time it is selected.
3. **R4 — contract-script coverage:** extend `assert-lane-wiring.mjs` with a
   coordinator fixture asserting the `SUPPORTED_CHAINS_RPC` injection
   rewrites the env var (and leaves it untouched when unset).
4. **R6 — chain-rpc-selection unit tests:** config-precedence order,
   instance-id parse, KS256_RPC_URL fallback selected AND chain-asserted
   (wrong-chain fallback → unavailable), unresolvable → null.

### Follow-up PR (canopy, after #204 — same repo/branch lineage)

5. **R1 — fence the re-redeem:** CAS the request-record write (reuse the
   etag pattern from `transitionApprovedToRedeemedCas`): read record+etag →
   mint → conditional ref-write (ifMatch) → on success revoke the PREVIOUS
   ref; on CAS loss revoke the just-minted token and return the winner's
   outcome (re-read). Acceptance: unit test with two interleaved re-redeems
   → exactly one active token, record ref points at it; crash-window test
   (revoke failure) leaves a state the NEXT re-redeem fully repairs
   (revoke-all-active-but-current sweep during reissue).
6. **R5 — probe-path genesis test:** fetchMock success-path genesis (cold
   cache → probe → 201, asserting the cache write) + 503-then-successful-
   retry; pins the probe-writer/gate-reader key agreement.
7. **R7 — univocity-forward hardening (dormant):** when the forward answers
   `created`, write the local R2 copy BEFORE returning success (retry or
   fail closed — the local copy is authoritative for reads); on `exists`,
   read-back-and-diff or document the store's exists-implies-byte-equality
   contract; distinguish univocity 409-conflict from 409-exists. Gate with a
   test. (Blocked on the univocity store contract — coordinate before
   enabling `UNIVOCITY_SERVICE_URL` anywhere.)

## 4. Deferred

L1–L6 above; L3's fresh-table `chain_id` column and docblock restoration can
ride any future delegation-store touch.
