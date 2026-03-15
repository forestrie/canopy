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

### 3.2 Grant pool (one grant per log)

For each log ID in the pool (e.g. CANOPY_PERF_LOG_IDS):

1. **Obtain signed grant for that log:** Each grant has GF_CREATE|GF_EXTEND and target logId = that log. So we need a signed transparent statement per log. Options:
   - **Option A:** Extend POST /api/grants/bootstrap to accept an optional `rootLogId` (or `logId`) in the request body; when provided, mint for that log instead of env ROOT_LOG_ID. Then the script can call POST /api/grants/bootstrap once per log (or in batch) and save each. No server-side storage; response body only.
   - **Option B:** Single root only for now: one bootstrap grant (for ROOT_LOG_ID), register it, get one completed grant; grant-pool has one entry (that log). Multi-log is a later step.
   - **Option C:** A separate “mint” script that calls the delegation-signer directly (or a canopy endpoint) with a TBS per log and builds the COSE; then register-grant for each. Prefer Option A for consistency with existing bootstrap API.

2. **Register:** POST /logs/{logId}/grants with `Authorization: Forestrie-Grant <grant_for_this_log_base64>`. 303 to status URL.
3. **Poll:** GET status URL until 303 to receipt URL.
4. **Resolve:** GET receipt URL; build completed transparent statement; add to pool (logId → base64 completed grant).
5. **Output:** grant-pool.json with structure suitable for k6, e.g. `{ "grants": [ { "logId": "...", "grantBase64": "..." }, ... ], "signer": "..." }` (signer from the grant payload for COSE kid).

Re-use: “poll status URL until 303 to receipt” and “resolve receipt URL and build completed grant” are shared between bootstrap and grant-pool.

## 4. Taskfile split

### 4.1 grant-shared.yml

- **Purpose:** Shared variables and small, reusable tasks used by both bootstrap and grant-pool.
- **Vars (examples):** `BASE_URL`, `API_TOKEN`, `ROOT_LOG_ID`, `MASSIF_HEIGHT`, paths for data dir (e.g. `perf/data`), timeout and poll interval for status polling.
- **Tasks:**
  - **poll-status** – Given a status URL (and base URL + token), GET in a loop until 303 to a URL ending with `/receipt`; output the receipt URL (e.g. to a file or stdout). Implement via a small script (Node/TS or shell + curl) invoked by the task.
  - **resolve-receipt** – Given a receipt URL (and base URL + token), GET the receipt, decode entryId to idtimestamp, build completed transparent statement from original grant + idtimestamp + receipt, write base64 to a file (or stdout). Implement via a script; task passes receipt URL and paths.
  - **encode-grant-header** – Helper: read grant file, output value for `Authorization: Forestrie-Grant <base64>` (used by tasks that call register-grant).

Scripts can live under `perf/scripts/` (e.g. `poll-status.ts`, `resolve-receipt-to-grant.ts`) and be invoked by the taskfile with the right env.

### 4.2 grant-bootstrap.yml

- **Purpose:** Mint the bootstrap grant, register it for the root log, poll until sequenced, resolve receipt, and save the completed grant. No server-side storage; all outputs are files (or artifacts in CI).
- **Tasks:**
  - **mint** – Call POST /api/grants/bootstrap; save response body to a file (e.g. `{{.GRANT_DATA_DIR}}/bootstrap-grant.b64`). Requires BASE_URL, API_TOKEN (if needed for any middleware), and delegation-signer configured on the server (ROOT_LOG_ID etc. in server env).
  - **register** – POST /logs/{{.ROOT_LOG_ID}}/grants with Forestrie-Grant from the file saved by mint. Parse 303 Location and save status URL to a file (e.g. `status-url.txt`). Depends on mint (or a pre-existing bootstrap grant file).
  - **poll** – Call poll-status task (from grant-shared) with the status URL from register. Save receipt URL to a file. Depends on register.
  - **resolve** – Call resolve-receipt task (from grant-shared) with the receipt URL from poll and the original bootstrap grant file; write completed grant base64 to e.g. `{{.GRANT_DATA_DIR}}/completed-root-grant.b64`. Depends on poll.
  - **bootstrap** – Single task that runs mint → register → poll → resolve in order (depends on grant-shared). Use when you want to “bootstrap the root and have a completed grant file ready for data log creation”.

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
- **Invocation:** Either called by taskfiles (e.g. `grant:pool` runs `pnpm --filter @canopy/perf run generate-grant-pool` with env set by the task) or run standalone with env vars (CANOPY_PERF_BASE_URL, CANOPY_PERF_API_TOKEN, CANOPY_PERF_LOG_IDS, etc.).
- **Inputs:** Base URL, API token, list of log IDs; optionally path to existing bootstrap/completed grant file (for root) to avoid re-minting.
- **Outputs:** `perf/k6/canopy-api/data/grant-pool.json` with structure k6 expects: e.g. `{ "signer": "<hex>", "grants": [ { "logId": "...", "grantBase64": "..." } ] }`.
- **Per-log grant:** If the API is extended so POST /api/grants/bootstrap can mint for a given logId (optional body param), the script calls it once per log and then register-grant + poll + resolve for each. If not, the script supports “single root” mode: one bootstrap, one completed grant, one pool entry.

## 6. Implementation order

| Step | Action | Notes |
|------|--------|--------|
| 1 | **API: stop storing bootstrap grant** | In handlePostBootstrapGrant, remove R2 put; always return 201 with body (base64 or COSE). Remove or stub GET /grants/bootstrap/:rootLogId (404). |
| 2 | **grant-shared.yml** | Add taskfile with vars and tasks: poll-status, resolve-receipt (both can call perf/scripts). Add scripts: e.g. poll-status.ts, resolve-receipt-to-grant.ts. |
| 3 | **grant-bootstrap.yml** | Tasks: mint, register, poll, resolve, bootstrap. Use grant-shared for poll and resolve. Mint = curl POST and save body; register = curl POST with Forestrie-Grant from file. |
| 4 | **grant.yml** | Tasks: single (register one + poll + resolve), pool (loop over log IDs, call single or equivalent, write grant-pool.json). Use grant-shared. |
| 5 | **generate-grant-pool script** | Rewrite to use Forestrie-Grant; obtain grants via POST /api/grants/bootstrap (and optionally per-log if API supports it); for each log: register-grant, poll status, resolve receipt, build completed grant; output grant-pool.json. Optionally delegate “poll” and “resolve” to the same logic as in scripts used by taskfiles. |
| 6 | **Wire taskfiles** | Include grant-shared, grant-bootstrap, grant in root Taskfile; document in README or runbook. |
| 7 | **Per-log mint (optional)** | If desired for multi-log pool: extend POST /api/grants/bootstrap to accept optional logId/rootLogId in body; when present, use it instead of env ROOT_LOG_ID and do not store. |

## 7. Summary

- **Bootstrap:** No server-side storage; POST returns the grant, workflow saves it. GET /grants/bootstrap/:rootLogId removed or 404.
- **generate-grant-pool:** Uses register-grant per log (GF_CREATE|GF_EXTEND, target log), collects completed grants via query-registration-status (poll) and resolve-receipt, writes grant-pool.json.
- **Taskfiles:** grant-shared.yml (poll-status, resolve-receipt, vars), grant-bootstrap.yml (mint, register, poll, resolve, bootstrap), grant.yml (single, pool) with re-use of shared tasks.
- **Scripts:** Shared logic for poll and resolve can live in perf/scripts and be used by both the taskfile tasks and the generate-grant-pool script for consistency.
