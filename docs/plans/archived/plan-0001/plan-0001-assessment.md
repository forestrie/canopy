# Plan 0001: Progress assessment and next steps

**Status**: DRAFT  
**Date**: 2026-03-09  
**Related**: [plan-0001-register-grant-and-grant-auth-phase.md](plan-0001-register-grant-and-grant-auth-phase.md) (archived together)

## 1. Scope of assessment

- **Plan**: Register-grant endpoint, grants storage, register-statement grant auth (Phase 1).
- **Code/commits**: Current `main` vs. baseline `57d4bbd0b19711f4919d4ccd9ad6fb25196ad44b` (20 commits, including merge of PR #3).

## 2. Progress by step

### Step 1: Grant format (CBOR encode/decode) — **DONE**

- **Evidence**: `packages/apps/canopy-api/src/grant/codec.ts`, `types.ts`; `test/grant-format.test.ts` (10 tests). Grant type includes idtimestamp, logId, kind, grant flags, maxHeight, minGrowth, ownerLogId, grantData, signer; `encodeGrant` / `decodeGrant` with version validation.
- **Verification**: `pnpm test` in canopy-api includes grant-format tests; they pass.

### Step 2: Storage path schema — **DONE**

- **Evidence**: `src/grant/storage-path.ts` — `grantStoragePath(encodedGrantBytes, kind)`; content-addressable `<kind>/<hash>.cbor` (hex), SHA-256 of encoded grant. `test/grant-storage-path.test.ts` (6 tests). Path schema documented in `docs/api/register-grant.md`.
- **Verification**: Path tests pass; doc exists.

### Step 3: Grants object storage binding — **DONE**

- **Evidence**: `R2_GRANTS` in wrangler.jsonc (dev + envs); `GRANT_STORAGE_PUBLIC_BASE` in vars; `test/grant-r2-binding.test.ts` (put/get). R2_GRANTS bucket created in cloudflare bootstrap (taskfile).
- **Verification**: Binding present; grant-r2-binding test passes.

### Step 4: Remove x402 from register-statement path — **DONE**

- **Evidence**: `register-signed-statement.ts` has no imports or calls to `parsePaymentHeader`, `buildPaymentRequiredHeader`, `verifyPayment`, or `X402_SETTLEMENT_QUEUE.send`. POST /logs/:id/entries is grant-auth only (see index.ts comment: "Grant-based auth is required (Step 5); x402 payment removed (Plan 0001 Step 4)").
- **Note**: x402 modules remain in repo (x402.ts, x402-facilitator.ts) and are still referenced by other routes/config (e.g. X402_MODE, facilitator URL); only the **entries** path no longer uses them.
- **Verification**: No x402 usage on entries path; canopy-api tests pass (entries tests expect grant auth, not 402).

### Step 5: Register-statement grant auth — **DONE**

- **Evidence**: `grant-auth.ts` — `getGrantLocationFromRequest` (X-Grant-Location or Authorization: Bearer path), `fetchGrant`, `getSignerFromCoseSign1`, `signerMatchesGrant`; `register-signed-statement.ts` locates → retrieves → decodes → verifies signer; CBOR problem details with extension members (e.g. grant_not_found, signer_mismatch); INFO logging on success.
- **Verification**: `scrapi-flow.test.ts` and `grant-auth-cose.test.ts` cover grant auth (valid grant + matching signer → 303; no/invalid grant or wrong signer → 401/403). E2E in `packages/tests/canopy-api/tests/api.spec.ts`: "registers a COSE statement (grant flow)" — create grant → register with X-Grant-Location → 303; skips when /grants returns 404.

### Step 6: Register-grant endpoint — **DONE**

- **Evidence**: POST /logs/{logId}/grants in `index.ts`; `register-grant.ts` — CBOR body, encode grant, `grantStoragePath(encoded, kind)`, R2.put, 201 with path-only Location. `test/register-grant.test.ts` (3 tests); scrapi-flow and api.spec create grant then use it for register-statement.
- **Verification**: Register-grant integration tests pass; E2E create-grant-then-register-statement works (when /grants exists).

### Step 7: Rate limiting (KV, grant signer, unit tests only) — **PARTIAL**

- **Done**: Rate-limit **logic** in `src/rate-limit/grant-signer-rate.ts`: `checkGrantSignerRate(nowMs, state, config)`, rolling + spike windows, `pruneState`; `DEFAULT_GRANT_SIGNER_RATE_CONFIG` (100/hour, 10/minute). **Unit tests** in `test/rate-limit.test.ts` (7 tests) — allow/deny, spike/window limits, state updates. Plan says "unit tests only" for enforcement in this phase.
- **Gap**: Plan Step 7 also says: "KV binding (e.g. Cloudflare KV) must be **available** for the worker" and "KV lookup keyed by grant signer". The **logic** is implemented and unit-tested, but:
  - No KV namespace is bound in wrangler (no KV binding in wrangler.jsonc or Env).
  - Rate limit is **not invoked** in the register-statement path (no `checkGrantSignerRate` or KV get/put in `register-signed-statement.ts` or index).
- **Interpretation**: Plan verification for Step 7 is "Unit tests for rate-limit logic pass" and "no integration/e2e requirement for enforcement". So **verification as stated** is satisfied. The plan text also says "KV binding must be available" and "KV lookup keyed by grant signer" — that implies either (a) add a KV binding and wire read/write in the handler so the **mechanism** is in place (even if not strictly required for "unit tests only"), or (b) treat "available" as "ready to add when enforcement is required" and leave wiring for a later phase. Current state: logic + unit tests ✅; KV binding and in-request enforcement ❌.

## 3. Acceptance criteria vs current state

| Criterion | Status | Notes |
|-----------|--------|--------|
| Format (Step 1) | ✅ | Encode/decode, tests pass |
| Path (Step 2) | ✅ | Schema + tests + doc |
| Storage (Step 3) | ✅ | R2_GRANTS, public base, test |
| Entries no x402 (Step 4) | ✅ | No x402 on POST entries |
| Entries grant auth (Step 5) | ✅ | Locate, retrieve, verify signer; tests |
| Register-grant (Step 6) | ✅ | POST grants, R2, path-only location; tests |
| Rate limiting (Step 7) | ⚠️ | Logic + unit tests ✅; no KV binding or in-handler use |
| E2E | ✅ | Create grant → register statement (with skip when /grants missing) |

## 4. Recommended next steps

1. **Close Step 7 explicitly** (choose one):
   - **Option A (minimal)**: Update plan or assessment to state that Step 7 verification is "logic + unit tests only"; KV binding and enforcement are deferred. No code change.
   - **Option B (full)**: Add a KV namespace for rate-limit state in wrangler (e.g. `RATE_LIMIT_KV` or `GRANT_SIGNER_RATE_KV`), add it to `Env`, and in `register-signed-statement.ts` after grant auth success: get state by signer key → `checkGrantSignerRate` → if denied return 429 with Retry-After → else put updated state back. Keeps "unit tests only" for **testing** enforcement but makes the **mechanism** live (optional for this phase per plan).

2. **Plan doc hygiene**: Update the acceptance criteria in `plan-0001-register-grant-and-grant-auth-phase.md` (Section 4) to checked state: all boxes can be checked except rate limiting, which can be checked with a note that KV wiring is deferred, or left unchecked until Option B is done.

3. **Deferred (already out of scope)**: x402 at register-grant; authority log grant lifecycle; inclusion-proof at register-statement; integration/e2e tests that actually hit the rate limit (per plan, not required this phase).

## 5. Summary

Plan 0001 Phase 1 is **substantially complete**. Steps 1–6 and E2E are done and verified. Step 7 rate-limiting has the required logic and unit tests; the only open item is whether to add a KV binding and call the rate limiter in the request path (plan allows deferring that to "unit tests only" for this phase). Recommended next step: decide Option A vs B for Step 7, then mark the plan acceptance criteria accordingly.
