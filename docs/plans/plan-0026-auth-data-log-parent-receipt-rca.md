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

**Remediation §3 (A/B RCA, 2026-05-31):** `hydrateGrantReceiptFromMmrs` used
`grant.ownerLogId` for R2 MMRS paths; child auth grants seal on **`grant.logId`**
(auth log **A**) while `ownerLogId` is root **R**. Hydration no-op’d → parent
receipt verify used stale embedded bytes. Fixed to use `grant.logId` in
[`hydrate-grant-receipt.ts`](../packages/apps/canopy-api/src/scrapi/hydrate-grant-receipt.ts).

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
