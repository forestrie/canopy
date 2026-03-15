# Plan 0009: Bootstrap and load-test readiness review

**Status:** DRAFT  
**Date:** 2026-03-14  
**Related:** [Subplan 08 grant-first bootstrap](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [Plan 0005 grant and receipt](plan-0005-grant-receipt-unified-resolve.md)

## 1. Current state

### 1.1 Bootstrap flow (implemented)

- **POST /api/grants/bootstrap** (no auth): Builds bootstrap grant (logId = ownerLogId = ROOT_LOG_ID, GF_CREATE|GF_EXTEND), calls delegation-signer for signature, stores in R2 at `bootstrap/{rootLogId}.cose`, returns 201 with body or 200 with Location. Requires ROOT_LOG_ID (64 hex chars), DELEGATION_SIGNER_URL, DELEGATION_SIGNER_BEARER_TOKEN; uses R2_GRANTS.
- **GET /grants/bootstrap/:rootLogId**: Serves the stored bootstrap grant (200 COSE or 404).
- **First grant (bootstrap branch):** When register-grant is called with queueEnv and bootstrapEnv set, the API:
  1. Calls univocity (UNIVOCITY_SERVICE_URL) to see if the log is initialized.
  2. If not initialized and the request grant is the bootstrap grant (ownerLogId = logId, GF_CREATE|GF_EXTEND, signature verifies with bootstrap public key from delegation-signer), it enqueues without inclusion check and returns 303 to status URL.
  3. If not initialized and grant is not bootstrap → 403 "Log not initialized; use bootstrap grant as auth to bootstrap".
  4. If initialized → receipt-based inclusion (grant must have idtimestamp and valid receipt in artifact).

- **Bootstrap env (index.ts):** bootstrapEnv is set only when ROOT_LOG_ID, DELEGATION_SIGNER_URL, DELEGATION_SIGNER_BEARER_TOKEN, and **UNIVOCITY_SERVICE_URL** are all set. So bootstrap branching is only active when univocity is configured.

### 1.2 Auth model (Plan 0005)

- **register-grant** and **POST /logs/{logId}/entries** (register-signed-statement) both require **Authorization: Forestrie-Grant &lt;base64&gt;** where the value is the **transparent statement** (COSE Sign1: grant payload, idtimestamp in header -65537, receipt in header 396). No X-Grant-Location fetch; no Bearer grant path.
- After bootstrap, any further register-grant or register-signed-statement must supply a **completed** grant (idtimestamp + receipt) in that artifact; the API verifies inclusion via receipt then enqueues.

### 1.3 Perf and CI today

- **Perf workflow** (`.github/workflows/perf-canopy.yml`): Loads env from `perf/.env.{dev|prod}`, builds log ID list from CANOPY_PERF_*LPS_* (UUIDs), runs **Generate grant pool** (`pnpm --filter @canopy/perf run generate-grant-pool`), then k6 with the bundle. Grant pool is uploaded as an artifact.
- **generate-grant-pool** (`perf/scripts/generate-grant-pool.ts`): For each CANOPY_PERF_LOG_IDS, POSTs to `/logs/{logId}/grants` with **Authorization: Bearer CANOPY_PERF_API_TOKEN** and **Content-Type: application/cbor** body = `encodeGrantRequest(...)`. Expects a Location header and writes `grant-pool.json` with `signer` (hex) and `grants: [{ logId, grantLocation }]`.
- **k6 scenario** (`perf/k6/canopy-api/scenarios/write-constant-arrival.js`): Loads grant-pool.json; for each POST to `/logs/{logId}/entries` sends **Authorization: Bearer API_TOKEN** and **X-Grant-Location: grantLocation**. Signs statement COSE with kid = pool signer.

## 2. Gaps

### 2.1 Auth mismatch

- The API **does not** accept Bearer + X-Grant-Location for POST /entries or Bearer + CBOR body for POST /grants. It only accepts **Forestrie-Grant** with a base64 transparent statement.
- Therefore:
  - **generate-grant-pool** would receive **401** (grant required) when calling POST /logs/{logId}/grants, and would not produce a valid pool for the current API.
  - **k6** would receive **401** on every POST /entries because it sends Bearer + X-Grant-Location instead of Forestrie-Grant.

So the current perf pipeline is **incompatible** with the implemented auth model until both the grant-pool script and the k6 scenario are updated to use Forestrie-Grant with transparent statements.

### 2.2 First grant for perf / CI

To run load tests we need at least one **completed** grant per log (transparent statement with idtimestamp and receipt) to use as auth for POST /entries. Options:

- **Option A – Bootstrap one root log, then use that grant for entries:**  
  1. Obtain bootstrap grant: POST /api/grants/bootstrap (or GET /grants/bootstrap/:rootLogId if already minted).  
  2. POST /logs/{rootLogId}/grants with Authorization: Forestrie-Grant &lt;bootstrap_base64&gt;.  
  3. Poll status URL until 303 to receipt; resolve receipt to get the completed transparent statement (grant + idtimestamp + receipt).  
  4. Use that completed grant as Forestrie-Grant for all POST /entries to that rootLogId.  
  So we only need one log (root) for load testing entries; the “grant pool” is one or more copies of that same completed grant (or one entry per VU if we want variety).

- **Option B – Multiple logs (e.g. 4 shards × N logs):**  
  Each log must either be bootstrapped (each has its own root and bootstrap grant) or be a “child” of a root (child grants with receipt from root). Current design and perf env use **UUIDs** as log IDs; bootstrap uses **ROOT_LOG_ID** as 64 hex (32 bytes). So either we define one ROOT_LOG_ID per perf log (e.g. 32-byte representation of each UUID) and bootstrap each, or we bootstrap a single root and use only that log for entries. For simplicity, **Option A with a single root log** is enough to get load testing working; multi-log can follow.

### 2.3 Bootstrap in CI

- There is **no** automated step in perf or smoke workflows that:  
  (1) mints the bootstrap grant (POST /api/grants/bootstrap or equivalent),  
  (2) registers it (POST /logs/{rootLogId}/grants with Forestrie-Grant),  
  (3) waits until sequenced and resolves the completed grant.
- Without that, generate-grant-pool (or a replacement) cannot produce valid Forestrie-Grant tokens. So **first-grant bootstrap must be part of the perf/CI run** (or a pre-run step with stored artifact) before any “generate grant pool” or k6 step.

### 2.4 Environment and config

- Bootstrap requires: ROOT_LOG_ID (64 hex), DELEGATION_SIGNER_URL, DELEGATION_SIGNER_BEARER_TOKEN, UNIVOCITY_SERVICE_URL (for “log initialized” check). Perf env files have CANOPY_PERF_* log IDs (UUIDs) and CANOPY_PERF_BASE_URL but do not define ROOT_LOG_ID or delegation-signer/univocity. So **perf env** (and any CI that runs bootstrap) must be extended with bootstrap-related vars, or we document that “no bootstrap” mode (queue only, no bootstrapEnv) is used for perf and then we must not require receipt-based inclusion for that environment (see register-grant: when only queueEnv is set, every valid grant is enqueued without inclusion check; but getGrantFromRequest still requires Forestrie-Grant, so we still need valid transparent statements).

## 3. Recommendations

1. **Align grant pool and k6 with Forestrie-Grant**
   - **generate-grant-pool** (or a new script): Should output a **grant pool** that contains **base64 transparent statements** (and optionally signer hex for COSE kid). To do that it must either:
     - **Bootstrap path:** Call POST /api/grants/bootstrap (or GET /grants/bootstrap/:rootLogId), then POST /logs/{rootLogId}/grants with Forestrie-Grant &lt;bootstrap&gt;, poll until sequenced, resolve receipt, then store the completed grant (base64) as the pool entry for that log; or
     - **Pre-seeded:** Accept a pre-obtained completed grant (e.g. from a prior bootstrap run) and write it into grant-pool.json.
   - **k6:** Change POST /entries to send **Authorization: Forestrie-Grant &lt;base64&gt;** using the transparent statement from the pool (and keep statement’s kid matching grant.signer). Remove reliance on X-Grant-Location and Bearer for grant auth.

2. **First-grant bootstrap for perf/CI**
   - Add a **bootstrap step** that: (a) ensures bootstrap grant exists (POST /api/grants/bootstrap or GET), (b) registers it with Forestrie-Grant, (c) polls until sequenced and resolves the completed grant, (d) writes that grant (and any metadata) for the next step. This can be the same script as “generate-grant-pool” when there is only one root log, or a dedicated “bootstrap-and-export-grant” script used before generate-grant-pool.
   - In **perf workflow**: Run this bootstrap (or generate-grant-pool that includes bootstrap) **before** k6; ensure env has ROOT_LOG_ID, delegation-signer URL/token, and UNIVOCITY_SERVICE_URL if bootstrap branch is used.

3. **Single-log vs multi-log**
   - For **initial load-test readiness**, implement and document the **single root log** flow: one ROOT_LOG_ID, bootstrap once, one completed grant used for all POST /entries in k6. Perf env can keep a single CANOPY_PERF_ROOT_LOG_ID (64 hex) and use it for both bootstrap and entries.
   - Multi-log (multiple roots or child logs) can be a follow-up once single-log perf and CI are green.

4. **Docs and runbook**
   - Document in README or runbook: (1) required env vars for bootstrap (ROOT_LOG_ID, DELEGATION_SIGNER_*, UNIVOCITY_SERVICE_URL), (2) sequence “mint bootstrap → register-grant with Forestrie-Grant → poll → resolve receipt”, (3) how to run perf (bootstrap or load completed grant, then k6 with Forestrie-Grant from pool).

## 4. Summary

| Area | Status | Action |
|------|--------|--------|
| Bootstrap API (POST/GET bootstrap, register-grant branch) | Implemented | None |
| Auth (Forestrie-Grant only) | Implemented | None |
| generate-grant-pool | **Uses Bearer + CBOR** | Rewrite to use Forestrie-Grant; obtain completed grant via bootstrap + poll + resolve |
| k6 POST /entries | **Uses Bearer + X-Grant-Location** | Switch to Forestrie-Grant with pool of base64 transparent statements |
| First grant in perf/CI | **Not automated** | Add bootstrap step (or fold into grant-pool script) before k6 |
| Perf env | Has log IDs and base URL; no bootstrap vars | Add ROOT_LOG_ID and delegation-signer (and univocity if using bootstrap branch) for bootstrap-capable runs |

Once the grant-pool script and k6 use Forestrie-Grant and the first-grant bootstrap is automated (or documented and run before perf), the system can be fully bootstrapped and load-tested in CI and locally.
