# Plan 0010: Grant workflow and taskfile split

**Status:** DRAFT  
**Date:** 2026-03-14  
**Related:** [Plan 0009 bootstrap and load-test readiness](plan-0009-bootstrap-and-load-test-readiness.md), [Subplan 08 grant-first bootstrap](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md)

## 1. Scope and goals

- **Bootstrap grant is not served by the API:** We do not store the bootstrap grant server-side. The workflow that performs bootstrap must save the grant (e.g. to a file or artifact) and later provide it as the grant for (root) log creation and for data log creation.
- **generate-grant-pool** creates one grant per log via **register-grant**, each with GF_CREATE and GF_EXTEND and each specifying the target log. It then collects the completed grants by polling **query-registration-status** and **resolve-receipt**, and writes a pool (e.g. grant-pool.json) for k6.
- **Taskfiles** split into **grant-shared.yml**, **grant-bootstrap.yml**, and **grant.yml** with appropriate task re-use so bootstrap and grant-pool generation are scriptable and CI-friendly.

## 2. API change: no server-side bootstrap storage

- **POST /api/grants/bootstrap:** Continue to build the bootstrap grant, call delegation-signer, and return the transparent statement in the response body (e.g. 201 with base64 or COSE). **Do not** write to R2. Caller (workflow/task) is responsible for persisting the response.
- **GET /grants/bootstrap/:rootLogId:** Remove, or return 404/410 with a note that bootstrap grants are not stored; callers must use the grant returned from POST or from their own storage.
- **Implication:** Any flow that needs the bootstrap grant (e.g. to call register-grant for the root log) must have obtained it from a previous POST /api/grants/bootstrap and saved it (file, artifact, or env).

## 3. Data flow

### 3.1 Bootstrap (one root log)

1. **Mint:** POST /api/grants/bootstrap (no auth). Response body = bootstrap transparent statement (base64 or COSE). Workflow saves it to a file (e.g. `perf/data/bootstrap-grant.cose` or `.b64`).
2. **Register:** POST /logs/{rootLogId}/grants with `Authorization: Forestrie-Grant <saved_base64>`. Response 303 with Location = status URL.
3. **Poll:** GET status URL repeatedly until 303 to a receipt URL (`.../entries/{entryId}/receipt`).
4. **Resolve:** GET receipt URL; decode entryId to get idtimestamp; build completed transparent statement (grant payload + header -65537 = idtimestamp, header 396 = receipt); save to file (e.g. `perf/data/completed-root-grant.cose` or `.b64`) for use as auth in later steps (e.g. data log creation or as the single pool entry if only one log is used).

### 3.2 Grant pool (one grant per log) — Option A

**Chosen: extend POST /api/grants/bootstrap** to accept an optional **`rootLogId`** (or **`logId`**) in the request body. When provided, mint for that log instead of env ROOT_LOG_ID; no server-side storage; response body only. The script calls POST /api/grants/bootstrap once per log and then register-grant + poll + resolve for each.

For each log ID in the pool (e.g. CANOPY_PERF_LOG_IDS):

1. **Mint:** POST /api/grants/bootstrap with body `{ "rootLogId": "<logId>" }` (or omit to use env ROOT_LOG_ID). Save response body (base64) as the grant for this log.
2. **Register:** POST /logs/{logId}/grants with `Authorization: Forestrie-Grant <grant_base64>`. 303 to status URL.
3. **Poll:** GET status URL repeatedly until 303 to receipt URL.
4. **Resolve:** GET receipt URL; build completed transparent statement; add to pool (logId → base64 completed grant).
5. **Output:** grant-pool.json: `{ "grants": [ { "logId": "...", "grantBase64": "..." } ], "signer": "<hex>" }` (signer from grant payload for COSE kid).

Re-use: poll status and resolve receipt are shared between bootstrap and grant-pool.

## 4. Taskfile split

### 4.1 grant-shared.yml

- **Purpose:** Shared variables and small, reusable tasks used by both bootstrap and grant-pool.
- **Vars (examples):** `CANOPY_BASE_URL`, `SCRAPI_API_KEY`, `ROOT_LOG_ID`, `MASSIF_HEIGHT`, paths for data dir (e.g. `perf/data`), timeout and poll interval for status polling.
- **Tasks:**
  - **poll-status** – Given a status URL (and base URL + token), GET in a loop until 303 to a URL ending with `/receipt`; output the receipt URL (e.g. to a file or stdout). Implement via a small script (Node/TS or shell + curl) invoked by the task.
  - **resolve-receipt** – Given a receipt URL (and base URL + token), GET the receipt, decode entryId to idtimestamp, build completed transparent statement from original grant + idtimestamp + receipt, write base64 to a file (or stdout). Implement via a script; task passes receipt URL and paths.
  - **encode-grant-header** – Helper: read grant file, output value for `Authorization: Forestrie-Grant <base64>` (used by tasks that call register-grant).

Scripts can live under `perf/scripts/` (e.g. `poll-status.ts`, `resolve-receipt-to-grant.ts`) and be invoked by the taskfile with the right env.

### 4.2 grant-bootstrap.yml

- **Purpose:** Mint the bootstrap grant, register it for the root log, poll until sequenced, resolve receipt, and save the completed grant. No server-side storage; all outputs are files (or artifacts in CI).
- **Tasks:**
  - **mint** – Call POST /api/grants/bootstrap; save response body to a file (e.g. `{{.GRANT_DATA_DIR}}/bootstrap-grant.b64`). Requires `CANOPY_BASE_URL`, `SCRAPI_API_KEY`, and delegation-signer configured on the server (ROOT_LOG_ID etc. in server env).
  - **register** – POST /logs/{{.ROOT_LOG_ID}}/grants with Forestrie-Grant from the file saved by mint. Parse 303 Location and save status URL to a file (e.g. `status-url.txt`). Depends on mint (or a pre-existing bootstrap grant file).
  - **poll** – Call poll-status task (from grant-shared) with the status URL from register. Save receipt URL to a file. Depends on register.
  - **resolve** – Call resolve-receipt task (from grant-shared) with the receipt URL from poll and the original bootstrap grant file; write completed grant base64 to e.g. `{{.GRANT_DATA_DIR}}/completed-root-grant.b64`. Depends on poll.
  - **bootstrap** – Single task that runs mint → register → poll → resolve in order (depends on grant-shared). Use when you want to bootstrap the root and have a completed grant file ready for data log creation.

Include grant-shared so these tasks can call poll-status and resolve-receipt.

### 4.3 grant.yml

- **Purpose:** Generate the grant pool: for each log ID, obtain a signed grant (GF_CREATE|GF_EXTEND, target log), register it, poll, resolve, and add the completed grant to the pool; write grant-pool.json.
- **Tasks:**
  - **pool** – For each log ID (from env or a file list): obtain grant (mint or from file), register-grant, poll, resolve, append to pool; then write grant-pool.json. Can depend on grant-shared (poll, resolve) and optionally on grant-bootstrap (if the first log is the root and we use completed-root-grant from bootstrap).
  - **single** – Register one grant for one log (given grant file and log ID); poll and resolve; output completed grant. Reusable building block used by pool or by hand.

Re-use: use the same poll-status and resolve-receipt from grant-shared; optionally call grant-bootstrap:bootstrap once to get the root completed grant, then for additional logs call the mint (or per-log mint API) and single (register + poll + resolve) per log.

### 4.4 Wiring into root Taskfile

- In Taskfile.dist.yml (or the main taskfile), add:
  - `grant-shared`: include as shared (no top-level tasks, or only internal tasks).
  - `grant-bootstrap`: include with namespace `grant:bootstrap` or `bootstrap` (e.g. `task bootstrap` or `task grant:bootstrap`).
  - `grant`: include with namespace `grant` (e.g. `task grant:pool`, `task grant:single`).

Example:

```yaml
includes:
  grant-shared:
    taskfile: ./taskfiles/grant-shared.yml
  grant-bootstrap:
    taskfile: ./taskfiles/grant-bootstrap.yml
    includes:
      grant-shared: ./taskfiles/grant-shared.yml
  grant:
    taskfile: ./taskfiles/grant.yml
    includes:
      grant-shared: ./taskfiles/grant-shared.yml
```

(Exact include syntax may vary by Taskfile version; the idea is grant-bootstrap and grant both use grant-shared.)

## 5. generate-grant-pool script

- **Role:** Implement the HTTP and COSE logic: call POST /api/grants/bootstrap (or per-log mint), POST register-grant, poll status URL, GET receipt URL, build completed transparent statement, write grant-pool.json.
- **Invocation:** Either called by taskfiles (e.g. `grant:pool` runs `pnpm --filter @canopy/perf run generate-grant-pool` with env set by the task) or run standalone with env vars (CANOPY_BASE_URL, SCRAPI_API_KEY, CANOPY_PERF_LOG_IDS, etc.).
- **Inputs:** `CANOPY_BASE_URL`, `SCRAPI_API_KEY`, list of log IDs; optionally path to existing bootstrap/completed grant file (for root) to avoid re-minting.
- **Outputs:** `perf/k6/canopy-api/data/grant-pool.json` with structure k6 expects: e.g. `{ "signer": "<hex>", "grants": [ { "logId": "...", "grantBase64": "..." } ] }`.
- **Per-log grant (Option A):** POST /api/grants/bootstrap accepts optional body `{ "rootLogId": "<logId>" }`. The script calls it once per log, then register-grant + poll + resolve for each, and writes grant-pool.json.

## 6. Agent-optimised implementation plan (incremental, testable)

Each step is independently verifiable. Implement in order; run verification before proceeding.

| Step | Action | Files to add/change | Verification |
|------|--------|---------------------|--------------|
| **6.1** | **API: optional rootLogId in POST body** | `bootstrap-grant.ts`: parse JSON body for optional `rootLogId` or `logId`; when present and valid (UUID or 64 hex), use it for grant.logId/ownerLogId instead of env ROOT_LOG_ID. Keep R2 write for now. | Unit test: POST with body `{ "rootLogId": "<uuid>" }` returns 201 and grant payload has that logId. POST with no body uses env ROOT_LOG_ID. |
| **6.2** | **API: stop storing; remove GET** | `bootstrap-grant.ts`: remove R2 get/put; always return 201 with body (base64). `index.ts`: remove GET /grants/bootstrap/... or return 404. | handlePostBootstrapGrant does not call r2Grants. GET /grants/bootstrap/:id returns 404. |
| **6.3** | **perf/scripts: poll-status** | Add `perf/scripts/poll-status.ts`: args = baseUrl, apiToken, statusUrl, maxPolls, pollIntervalMs; GET until 303 to URL ending `/receipt`; print receipt URL. | Run against known status URL or mock; exits 0 with receipt URL or non-zero on timeout. |
| **6.4** | **perf/scripts: resolve-receipt-to-grant** | Add `perf/scripts/resolve-receipt-to-grant.ts`: GET receipt, decode entryId to idtimestamp, build COSE with headers -65537 and 396, write base64 to output. | Run with real receipt URL and grant file; output is valid COSE with both headers. |
| **6.5** | **grant-shared.yml** | Add `taskfiles/grant-shared.yml`: vars (CANOPY_BASE_URL, SCRAPI_API_KEY, GRANT_DATA_DIR, MASSIF_HEIGHT, POLL_*); tasks poll-status, resolve-receipt invoking scripts. | `task grant-shared:poll-status` and resolve-receipt run with required vars. |
| **6.6** | **grant-bootstrap.yml** | Add `taskfiles/grant-bootstrap.yml`: includes grant-shared; tasks mint, register, poll, resolve, bootstrap. | `task grant-bootstrap:mint` saves file; `task grant-bootstrap:bootstrap` e2e when server is up. |
| **6.7** | **grant.yml** | Add `taskfiles/grant.yml`: includes grant-shared; tasks single, pool (per log: mint with body rootLogId, register, poll, resolve; write grant-pool.json). | `task grant:single` with one log; `task grant:pool` produces grant-pool.json. |
| **6.8** | **Wire taskfiles** | `Taskfile.dist.yml`: add includes for grant-shared, grant-bootstrap, grant. | `task --list` shows grant and grant-bootstrap tasks. |
| **6.9** | **generate-grant-pool script** | Rewrite `perf/scripts/generate-grant-pool.ts`: per log POST bootstrap with `{ "rootLogId": logId }`, register-grant, poll, resolve, push to pool; write grant-pool.json. | `pnpm --filter @canopy/perf run generate-grant-pool` produces grant-pool.json; k6 can consume. |
| **6.10** | **k6: Forestrie-Grant** | Update k6 scenario and http.js: POST /entries with `Authorization: Forestrie-Grant <grantBase64>` from pool. | k6 run with grant-pool; POST returns 303. |

## 7. Summary

- **Bootstrap:** No server-side storage; POST returns the grant, workflow saves it. GET /grants/bootstrap/:rootLogId removed or 404.

## 8. Testing (local first, then CI)

Run everything that does not require a Cloudflare deployment first; add or adjust CI so e2e can pass without deploy.

| Layer | What | Testable locally? | In CI today? | Notes |
|-------|------|-------------------|---------------|--------|
| **Unit** | canopy-api handlers (bootstrap, register, etc.) | Yes: `pnpm --filter @canopy/api test` (vitest + miniflare) | Yes: `pnpm -r test` | No deploy. Bootstrap tests mock delegation-signer. |
| **Unit** | Perf grant-completion helpers (entryId→idtimestamp, buildCompletedGrant, signerHexFromGrantPayload) | Yes: add vitest in perf, test with fixtures | Add: run `pnpm --filter @canopy/perf test` in test job | No network; pure logic. |
| **Script** | poll-status, resolve-receipt-to-grant (full script) | Partially: resolve with fixture files; poll needs live status URL or mock server | Optional: script smoke with fixture | Full resolve-receipt test: fixture grant + receipt URL path + mock GET receipt. |
| **Task** | grant-bootstrap:mint, grant:pool | Yes: start `wrangler dev` (or point at dev), then run task | Optional: job that starts dev then runs mint | Requires running API (local or dev). |
| **E2E** | Playwright: health, config, grant flow (mint→register→poll→resolve→POST entries) | Yes: `pnpm run test:e2e:local` (webServer starts API) | Yes but default is remote: `pnpm run test:e2e` → project=remote | Switch CI to e2e:local so no deploy; grant test skips when bootstrap/queue not configured. |
| **Smoke** | task scrapi:smoke (burst statements) | Only if running against local/dev | Yes: workflow_call against dev/prod | Needs deployed Workers (or local stack). |

**Incremental local testing (before deploy):**

1. **Unit:** Run `pnpm -r test` (canopy-api bootstrap tests pass).
2. **Unit (perf):** Add `perf/lib/grant-completion.ts` (extract from scripts) + `perf/lib/grant-completion.test.ts`; run `pnpm --filter @canopy/perf test`.
3. **E2E local:** Run `pnpm run test:e2e:local`; grant test skips gracefully when delegation-signer or queue missing.
4. **Integration (optional):** Start `pnpm --filter @canopy/api dev`, then `task grant-bootstrap:mint` with `CANOPY_BASE_URL=http://localhost:8789` and `SCRAPI_API_KEY=...`; assert bootstrap-grant.b64 exists.

**CI without deploy:** Run unit tests + perf unit tests + e2e with project=local (webServer starts API). Grant e2e skips if bootstrap or register returns 5xx. No smoke against remote until after deploy.

### 8.1 Arbor and univocity

- **Arbor:** Plan 0010 does not require any **service changes** in arbor. Grant-sequencing uses the same DO and wire format that ranger (or the existing pipeline) already consumes. R2 bucket names (e.g. arbor-dev-1-logs) are config for merklelog storage; no new arbor APIs or behaviour are required.
- **Univocity / checkpoint publishing:** We do **not** need checkpoint publishing to univocity to test the canopy side. When `UNIVOCITY_SERVICE_URL` is **not** set, `bootstrapEnv` is undefined and register-grant uses the “queue only” path: every valid Forestrie-Grant is enqueued without calling univocity or checking “log initialized”. Receipts appear when the queue consumer (e.g. ranger) processes the grant. Checkpoint publishing and univocity’s “log initialized” are only needed when using the full bootstrap/receipt branching (Subplan 08) in production; they are not required for local or CI testing of mint → register → poll → resolve → POST entry.
- **Option A:** POST /api/grants/bootstrap accepts optional body `{ "rootLogId": "<logId>" }` for per-log mint.
- **generate-grant-pool:** Uses register-grant per log (GF_CREATE|GF_EXTEND, target log), collects completed grants via query-registration-status (poll) and resolve-receipt, writes grant-pool.json.
- **Taskfiles:** grant-shared.yml (poll-status, resolve-receipt, vars), grant-bootstrap.yml (mint, register, poll, resolve, bootstrap), grant.yml (single, pool) with re-use of shared tasks.
- **Scripts:** Shared logic for poll and resolve can live in perf/scripts and be used by both the taskfile tasks and the generate-grant-pool script for consistency.
