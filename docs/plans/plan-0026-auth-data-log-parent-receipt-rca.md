# Auth-data-log-chain parent grant 403 — root cause analysis

**Status:** ACCEPTED  
**Date:** 2026-05-31  
**Related:** [plan-0025](plan-0025-queue-independent-grant-authorization.md),
[plan-0024](plan-0024-byok-checkpoint-seal-rca.md),
[auth-data-log-chain e2e doc](../packages/tests/canopy-api/tests/system/docs/auth-data-log-chain.md)

## Summary

`auth-data-log-chain` failed on **child data grant** `POST /register/{R}/grants` with **403**
and detail `Grant receipt verification failed (receipt signature or inclusion proof).`
The failure is in `grantAuthorize` on the **parent auth grant** supplied in the CBOR body
(`{ parentGrant: <bytes> }`), not in POST-body decoding (H0 ruled out).

**Root cause (confirmed):** **H2** — the receipt authority resolver cached verify-key
resolution by `ownerLogId + receipt.byteLength` only. On a warm Cloudflare Worker isolate,
the **bootstrap** and **auth** completed grants on the same root log **R** often produce
receipts of **equal size** but different COSE/delegation content. The **data** grant
registration reused the cached keys from the **first** receipt, so the parent auth grant’s
receipt signature verification failed.

## Evidence

| Source | Observation |
|--------|-------------|
| CI run `26711640692` (commit `739d7b2`) | Failure at `auth-data-log-chain.spec.ts:162` — data grant `register-grant` **403** with generic receipt verification detail |
| Code at `739d7b2` | [`receipt-authority-resolver.ts`](../packages/apps/canopy-api/src/env/receipt-authority-resolver.ts) line 79: `` cacheKey = `${ownerLogIdLowerHex32}\0${receiptCoseBytes.byteLength}` `` |
| E2e flow | `beforeAll` completes **bootstrap receipt** on **R**; test registers **auth** receipt on **R**; data grant passes **auth completed grant** as `parentGrant` — same `ownerLogId` (**R**), third receipt verify on same isolate |
| Unit test | [`receipt-authority-resolver-cache.test.ts`](../packages/apps/canopy-api/test/receipt-authority-resolver-cache.test.ts): legacy length-only key collides; SHA suffix differs; keys from first resolve do not verify second receipt |
| H0 ruled out | **403** receipt message, not 400 / parent absent |

## Hypothesis closure

| ID | Verdict | Notes |
|----|---------|-------|
| **H0** | RULED OUT | Body decoded; failure inside `grantAuthorize` |
| **H1** | Symptom of **H2** | Signature failed because wrong cached verify keys, not wrong crypto primitive |
| **H2** | **CONFIRMED** | See evidence table |
| **H3** | RULED OUT | No `inclusion-failed` discriminator on deployed commit; inclusion not primary failure mode for cache bug |
| **H4** | RULED OUT | E2e uses `GET resolve-receipt` body; delegation cert copy exists on HTTP path since before Map fix |
| **H5** | RULED OUT | Would yield “delegation chain could not be verified”, not generic receipt failure |
| **H6** | RULED OUT | Same receipt bytes as successful `GET resolve-receipt`; assembly not client-corrupt |
| **H7** | RULED OUT | Auth grant receipt poll + GET **200** on same stack |

## Remediation (implemented)

1. **Cache key** — include SHA-256 prefix of receipt bytes:
   `receiptResolverCacheKeySuffix` in
   [`receipt-authority-resolver.ts`](../packages/apps/canopy-api/src/env/receipt-authority-resolver.ts).
2. **Split 403 details** — `signature-failed` vs `inclusion-failed` in
   [`auth-grant.ts`](../packages/apps/canopy-api/src/scrapi/auth-grant.ts) for faster
   future RCA (requires deploy to observe in CI).
3. **`buildReceiptForEntry` parity** — copy delegation cert from checkpoint like HTTP
   resolve-receipt (defensive; not the CI failure path).
4. **Regression tests** — `receipt-authority-resolver-cache.test.ts`.
5. **E2e attach** — `parent-grant-rca.json` on data-grant failure via
   [`parent-grant-receipt-diagnostics.ts`](../packages/tests/canopy-api/tests/utils/parent-grant-receipt-diagnostics.ts).
6. **Dual trust-root merge** — when coordinator is configured, resolve verify keys
   against both coordinator `public-root` and Custodian curator trust roots and
   merge candidates (fixes post-deploy `signature-failed` on custodial dev).
7. **Parent receipt hydrate** — before `grantAuthorize` on `parentGrant`, rebuild
   receipt from MMRS via `hydrateGrantReceiptFromMmrs` (same as resolve-receipt).

## A/B evidence (CI forensics, 2026-05-31)

| Run ID | Commit | Deploy | E2e detail (data grant 403) | Inferred |
|--------|--------|--------|-------------------------------|----------|
| `26711640692` | `739d7b2` | success | Generic *receipt signature or inclusion proof* | legacy-generic (pre split-403) |
| `26712925739` | `d2ccb42` | success | *signature did not verify* (delegation cert message) | **B** or **A** (client-only diagnostics) |
| `26713274032` | `cbabc6b` | success | *signature-failed-inclusion-ok* (inclusion matches, sig fails) | **B**-leaning (cert likely present on explicit peak path) |

Deploy job **succeeded** on all rows; failures are **API e2e (dev, system)** only. Coordinator worker deploy is often **skipped** when only `canopy-api` changes; `COORDINATOR_APP_TOKEN` is still configured on canopy-api deploy.

## Verification

- [x] Deploy `canopy-api` with cache-key + split-403 changes to **dev** (CI run `26712925739`).
- [x] Dual trust-root merge + parent hydrate deployed (runs through `26713274032`; still red).
- [x] Post-deploy 403 detail: `signature-failed` / `signature-failed-inclusion-ok` — cache + trust-root merge insufficient alone.

## Post-deploy follow-up (2026-05-31)

CI on commit `d2ccb42` still failed with **signature-failed** after the cache-key
fix. **H5 (revised):** `createSelectingTrustRootClient` used coordinator
`public-root` when present, but Custodian curator keys still seal checkpoints on
dev custodial forests. Receipts without a verifiable delegation cert against the
coordinator key returned only `[coordinator]` candidates, so peak signatures
signed by Custodian failed.

**Remediation §2:** merge verify-key candidates from coordinator **and** Custodian
trust roots in [`receipt-authority-resolver.ts`](../packages/apps/canopy-api/src/env/receipt-authority-resolver.ts)
(`resolveReceiptVerifyKeysFromTrustRoots`).

**Remediation §3 (A/B RCA, 2026-05-31):** Hydration must use **`grant.ownerLogId`**
for MMRS (auth grant leaf is on root **R**'s tree; `logId` is child **A** only).
A mistaken `logId` lookup could rebuild from the wrong log's massif.

**Remediation §4:** Receipt verify tries **detached peak** signing first (sealer
path), then embedded payload when a 32-byte peak is present — fixes
`signature-failed` / `signature-failed-inclusion-ok` when payload copy does not
match the Sig_structure the signer used.

**Diagnostics shipped:** e2e `parent-grant-ab-split.json` + worker 403 `extensions`
(`hasDelegationCertBeforeHydrate`, `hasDelegationCertAfterHydrate`,
`parentReceiptVerify`); Playwright report artifacts on CI failure.

## Local blocker (investigation only)

Runner **Custodian 401** (`valid app token required`) prevents local Playwright from
reaching Canopy in this environment; CI remains the integration source of truth when
Doppler tokens are invalid locally.

## Verification checklist (A/B plan)

- [x] CI forensics recorded (runs `26711640692`, `26712925739`, `26713274032`).
- [x] E2e `parent-grant-ab-split.json` + `parent-grant-403.cbor.b64` on data-grant failure.
- [x] Worker 403 `extensions` on non-prod parent-grant verify failure.
- [x] Playwright report/results artifacts on CI failure.
- [ ] `auth-data-log-chain` green on **Deploy Workers** after remediation §3 deploy.

### A/B conclusion (run `26715288649`, commit `d6626e0`)

Worker `extensions` + e2e `parent-grant-ab-split` on three retries:

| Signal | Value |
|--------|--------|
| `hasDelegationCertBeforeHydrate` / resolve-receipt | **true** |
| `parentReceiptVerify` | **signature-failed** |
| `verifyKeyCount` | **2** (custodian delegation chain only; coordinator public-root **404**) |
| `receiptMatchesResolveReceiptBody` | **true** |

**Verdict: B** — cert is present on client and worker paths; two custodian verify keys are tried; COSE peak signature still fails. Not hypothesis A (missing cert). Remaining work is likely **sealer peak signer vs delegation cert key** or **grant–leaf binding** on forest-dev-5 (compare Arbor `signEmptyPeakReceipt` lease with cert label 5).

## TRUE root cause (CONFIRMED 2026-05-31 — supersedes the above)

The B-verdict pointed at the COSE peak signature, but the signature was never the
problem: the **detached peak the verifier reconstructed was wrong** for any
multi-leaf MMR. [`@canopy/merklelog`](../../packages/merklelog/src/mmr/algorithms.ts)
`calculateRoot` hashed interior MMR nodes as `H(left ‖ right)`, omitting the
1-based node **position** prefix that the deployed log (go-merklelog Ranger +
sealer) and the MMRIVER profile require: interior nodes are
`H(pos_BE8 ‖ left ‖ right)` (see go `HashPosPair64` / `IncludedRoot` and the
reference `algorithms.py` `hash_pospair64`). `calculateRoot` even tracked
`currentPos` but never hashed it.

Consequences:

- `mmrIndex 0` (single leaf, empty proof, peak == leaf) needs **no** interior
  hash, so the BYOK stretch (`byok-checkpoint-seal`) and all single-leaf paths
  verified — masking the bug.
- `mmrIndex ≥ 1` (the **auth** grant leaf on root **R**, sibling = bootstrap
  leaf) reconstructed peak `H(l0 ‖ l1)` while the sealer signed
  `H(3_BE8 ‖ l0 ‖ l1)`. The detached-payload COSE verify therefore failed with
  exactly the observed **signature-failed** — independent of the delegation cert
  or trust-root resolution.

This means the earlier H2 (cache key) and the dual trust-root / hydrate
remediations, while individually reasonable hardening, were **not** the cause of
the `auth-data-log-chain` 403. The earlier "CONFIRMED H2" verdict is **superseded**:
H1 (crypto primitive) was correct after all, but at the MMR interior-node layer,
not the COSE layer.

**Why prior tests missed it:** every `calculateRoot`/receipt test built the
signed peak via `peakForLeafProof` → `calculateRoot` and then verified with
`calculateRoot` — i.e. circular. They agreed with themselves regardless of the
position prefix.

**Fix + verification:** see
[plan-0027](plan-0027-mmr-interior-node-position-commitment.md). Interior hashing
now commits the position; a non-circular SHA-256 KAT, a go-derived receipt-level
test, and the full go-merklelog **KAT39** parity suite pin the behaviour. The
audit also fixed `leafCount` (was `(n+1)/2`; now `PeaksBitmap`, spec-correct) and
flagged `bagPeaks` (not position-committed, unused by the receipt path) and the
`verifyConsistency` stub (always true; not implemented).
