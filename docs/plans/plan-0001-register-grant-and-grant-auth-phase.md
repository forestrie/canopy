# Plan 0001: Register-grant endpoint, grants storage, and register-statement grant auth (Phase 1)

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: [Brainstorm-0001](../brainstorm-0001-x402-checkpoint-grants.md) (x402 checkpoint grants)

## 1. Purpose and scope

- **Establish** register-grant API, grants object storage, CBOR grant format, and storage path schema.
- **Change** register-statement to **require** grant-based auth: locate grant → retrieve from object storage → verify statement signer matches grant. No fallback; big bang (no backwards compatibility).
- **Out of scope this phase**: x402 at register-grant; grant addition to authority logs; inclusion-proof verification at register-statement. x402 code remains in repo but is not called from register-statement.

## 2. Re-use (summary)

- **R2**: Same binding pattern and `.get()`/`.put()` as existing R2 usage; new bucket or prefix for grants.
- **Request/response**: Existing scrapi helpers (parseCborBody, getContentSize, problemResponse, seeOtherResponse, content-type). COSE Sign1 validation and body parsing for statements.
- **Routing**: Existing index.ts segment/method routing; add one route, replace entries handler body.
- **x402**: Remove only calls from entries path; keep all x402 modules.

---

## 3. Task order and verification

Tasks are ordered by dependency. Each task is logically isolated and ends with **Verification** so agents can confirm completion. No duplication of storage/path logic across tasks.

### Step 1: Grant format (CBOR encode/decode)

**Scope**: Single module (or package) with:

- In-memory grant type(s) including: idtimestamp, logId, grant flags, maxHeight, minGrowth, ownerLogId, grantData, and **signer binding** (e.g. kid or public key bytes) for register-statement auth. Align shape with future univocity leaf commitment (Brainstorm-0001 §3.4).
- `encodeGrant(grant): Uint8Array` — grant to CBOR bytes.
- `decodeGrant(bytes): Grant` — CBOR to grant with validation; reject unknown version (version field in CBOR).

**Re-use**: Existing CBOR usage (e.g. cbor-x or same as scrapi); no new COSE here.

**Verification**:

- Unit tests: round-trip encode/decode; decode rejects empty, truncated, or unknown-version payloads; decode rejects missing required fields.
- Agent run: `pnpm test -- <grant-format-test-file>` (or equivalent) passes.

---

### Step 2: Storage path schema (content-addressable)

**Scope**: Pure function and documentation:

- **Content-addressable path**: `<kind>/<hash>.cbor` where `hash` is derived from the **encoded grant content** (e.g. SHA-256 of the grant CBOR bytes). Same grant content → same path; idempotent. Idtimestamp is **not** in the path in this phase.
- `grantStoragePath(encodedGrantBytes, kind): string` — deterministic path from hash(encodedGrantBytes) and kind. Encoding of hash (hex or base64url) and character set safe for R2.
- Document path schema in plan and in [docs/api/register-grant.md](../api/register-grant.md).

**Depends on**: Step 1 (grant shape, encodeGrant) for types.

**Verification**:

- Unit tests: same encoded grant + kind → same path; path is non-empty and uses only allowed chars; path format `<kind>/<hash>.cbor`.
- Agent run: path tests pass; doc exists.

---

### Step 3: Grants object storage binding

**Scope**: Configuration only:

- Add R2 bucket (or dedicated prefix) for grants; give canopy-api read and write. If using prefix, document it (e.g. `grants/`).
- **Public grant storage base**: Add or extend config with the **public hostname and path** for grant storage (e.g. `https://grants.example.com` or path prefix). Grant **location** returned to clients is **URL path only**, interpreted **relative to this base**; clients form full URL as base + path. Register-statement accepts **only** this path form (no arbitrary full URLs).
- Document binding name, public base URL, and any public-read/CORS if needed.

**Depends on**: None (can be done in parallel with 1–2).

**Verification**:

- Worker has binding; deploy or local dev can write/read at a test path (e.g. `grants/test/log/test/attestor/0.cbor`).
- Agent run: minimal script or test that `R2_GRANTS.put(key, body)` and `R2_GRANTS.get(key)` succeed.

---

### Step 4: Remove x402 from register-statement path

**Scope**: Entries handler only:

- Remove: requirement for X-PAYMENT header, 402 with X-PAYMENT-REQUIRED, calls to parsePaymentHeader, verifyPayment, settlement queue send. Do not remove or change x402 modules elsewhere.
- Entries handler no longer imports or calls x402 for payment.

**Verification**:

- No references to parsePaymentHeader, buildPaymentRequiredHeader, verifyPayment, or X402_SETTLEMENT_QUEUE.send from the POST /logs/:id/entries handler path.
- Tests: update or remove tests that expected 402 when payment missing; entries tests no longer assert on x402 headers. Agent run: `pnpm test` for canopy-api passes (after steps 5–6, entries will require grant and fail without it; that is expected).

---

### Step 5: Register-statement grant auth (locate, retrieve, verify signer)

**Scope**: POST /logs/{logId}/entries handler only:

- **Locate**: One chosen mechanism only (e.g. `Authorization: Bearer <path>` or `X-Grant-Location: <path>`). **Location format**: **URL path only** (e.g. `/<kind>/<hash>.cbor`), interpreted **relative to the public grant storage base** (Step 3). Parse before body. If missing, malformed, or not a path → 401 or 402, do not parse body.
- **Retrieve**: Resolve path to storage key (path with optional bucket prefix). R2.get(key). If not found or error → 401 or 402.
- **Decode**: decodeGrant(bytes) from Step 1. If invalid → 401 or 402.
- **Verify signer**: From request body (COSE Sign1 statement), obtain signer (kid or public key) via existing or extended COSE handling. Compare with grant’s signer binding. Mismatch → 401 or 403.
- **Errors**: All auth/storage failures use **Concise Problem Details** in CBOR (consistent with existing `problemResponse` / `application/problem+cbor`), with optional extension members (e.g. `reason: "grant_not_found"`, `signer_mismatch`) so agents can branch on error type.
- **Logging**: Log **success** at INFO (e.g. grant location, logId, outcome). Otherwise follow prevailing implementation practice for logs and metrics.
- On success, proceed to existing enqueue logic (unchanged). No inclusion proof or on-chain check.

**Depends on**: Steps 1 (decode grant, signer field), 2 (location → key if needed), 3 (R2 read).

**Verification**:

- Integration tests: (a) Request with no grant location → 401 or 402. (b) Request with invalid or missing grant key → 401 or 402. (c) Request with valid grant key + statement signed by same key as in grant → 303 (or 201). (d) Request with valid grant key + statement signed by different key → 401 or 403. Use a fixture grant in R2 or create one in test setup.
- Agent run: integration tests for entries with grant auth pass.

---

### Step 6: Register-grant endpoint

**Scope**: New route and handler:

- **Request/response**: **CBOR end-to-end**. Body: Grant request (CBOR) with target log, owner log, grant flags, bounds, grantData, signer binding. Validate required fields. Errors use **Concise Problem Details** in CBOR (consistent with existing scrapi `problemResponse`).
- Route: e.g. POST /logs/{logId}/grants.
- Handler: Build grant object (idtimestamp in payload only, not in path), encode via Step 1, compute **content-addressable path** via Step 2 from encoded grant bytes and kind, R2.put(path, encoded). Return 201 with **grant location = URL path only** (path relative to public grant storage base) in Location header and/or CBOR body. No x402.
- **Location**: Path only (e.g. `/<kind>/<hash>.cbor`); client combines with public grant storage base to form full URL if needed.
- Errors: 400/413/415/500 with CBOR problem details; document request/response in [docs/api/register-grant.md](../api/register-grant.md).

**Depends on**: Steps 1, 2, 3.

**Verification**:

- Integration test: POST grant request with valid body → 201, Location (or body) contains path; R2.get(path) returns same bytes; decodeGrant(bytes) yields expected fields.
- Agent run: register-grant integration test passes; register-statement test can create grant via API then register statement with that grant location.

---

### Step 7: Rate limiting (KV, grant signer, unit tests only)

**Scope**: This phase includes a **KV lookup keyed by grant signer** for rate limiting. Logic only; enforcement is **tested via unit tests only** (no integration/e2e requirement for enforcement).

- **Key**: Grant signer (e.g. kid or public key id).
- **State**: Per-signer usage for a **rolling window** (e.g. 1 hour) and a **spike window** (e.g. 1 minute). Store enough to compute: (1) count of requests in the rolling window, (2) count in the spike window.
- **Rate tiers**: Allow x requests per rolling window and max y requests per spike window (e.g. 100/hour, 10/minute). Configurable or fixed for this phase.
- **Enforcement**: Implement the rate-limit check (e.g. function that, given signer and KV state, returns allow/deny and updated state). **Unit tests** cover: over-window limit → deny; over-spike limit → deny; under both → allow; state updates correctly. Integration/e2e tests do **not** require actually enforcing the limit against live requests in this phase.

**Depends on**: Step 1 (signer identity from grant), Step 5 (where signer is available). KV binding (e.g. Cloudflare KV) must be available for the worker.

**Verification**:

- Unit tests for rate-limit logic pass (allow/deny, window and spike boundaries, state shape).
- Agent run: `pnpm test -- <rate-limit-test-file>` passes.

---

## 4. Acceptance criteria (consolidated)

- [ ] **Format**: Grant CBOR encode/decode module exists; round-trip and validation tests pass (Step 1).
- [ ] **Path**: Path schema implemented and tested; documented (Step 2).
- [ ] **Storage**: Grants R2 binding configured; write/read test passes (Step 3).
- [ ] **Entries no x402**: Entries handler has no x402 payment logic; tests updated (Step 4).
- [ ] **Entries grant auth**: Entries require grant location; retrieve grant; verify statement signer; integration tests pass (Step 5).
- [ ] **Register-grant**: POST creates grant, writes to R2, returns **path-only** location; integration test passes (Step 6).
- [ ] **Rate limiting**: KV-backed rate limit keyed by grant signer (rolling + spike windows, tiers); **unit tests only** for rate logic (Step 7).
- [ ] **E2E**: Create grant via API → use location in register-statement → registration succeeds; wrong signer or missing grant fails.

---

## 5. Deferred work

- x402 payment at register-grant; grant addition to authority logs; inclusion-proof verification at register-statement; optional x402 at register-statement in a later phase.

---

## 6. Assessment: direction, gaps, weaknesses (agent-friendly ledger)

**Direction**: The plan correctly establishes grant-as-ticket for registration and defers payment and authority-log lifecycle. That fits an agent-friendly ledger: agents obtain a grant (later via payment), then register statements by presenting the grant and a matching signature.

**Strengths**:

- Single, deterministic grant location mechanism and storage path schema so agents can cache and reuse locations.
- Signer binding in the grant makes “one attestor, one grant” verifiable and prevents reuse of another’s grant.
- Clear sequence: create grant → use grant at register-statement; testable with fixtures or API.

**Gaps and weaknesses** (addressed in this phase):

1. **Discovery and docs for agents**: **Addressed** — [docs/api/](../api/) added: [canopy-api.md](../api/canopy-api.md) (overview), [register-grant.md](../api/register-grant.md), [register-statement.md](../api/register-statement.md) define request/response, path schema, location format, and errors for both endpoints.

2. **Error shape**: **Addressed** — CBOR end-to-end; errors use **Concise Problem Details** (CBOR, consistent with RFC 9290 and existing `problemResponse` / `application/problem+cbor`). Auth failures include optional extension members (e.g. `grant_not_found`, `signer_mismatch`) so agents can branch on error type.

3. **Idempotency**: **Addressed** — Grants are **content-addressable**. Path is `<kind>/<hash-of-grant-content>.cbor`; we trust the path hash for idempotency. Same grant content → same path; idtimestamp is not in the path in this phase.

4. **Grant “current” and validity**: Optional exp/nbf in grant format; if present, register-statement rejects expired/not-yet-valid. Deferred as mandatory; shape is in scope.

5. **Observability**: **Addressed** — Log **success** at INFO (e.g. grant location, logId, outcome); otherwise consistent with prevailing implementation practice for logging and metrics.

6. **Location format**: **Addressed** — **URL path only**, interpreted **relative to the public grant storage hostname** (config added or extended in Step 3). Register-statement accepts only this path form; full URLs are not accepted in this phase.

7. **Rate and quota**: **Addressed in this phase** — KV lookup keyed by **grant signer**; **rolling window** (e.g. 1 hour) and **spike window** (e.g. 1 minute); **rate tiers** (x per window, max y per spike). Rate limit enforcement is **tested via unit tests only** for now (Step 7).

**Summary**: The plan is implementable and testable in the given order. API docs, CBOR + Concise Problem Details, content-addressable path, path-only location, logging, and rate-limit (unit-tested) are now in scope.

---

## 7. References

- [Brainstorm-0001](../brainstorm-0001-x402-checkpoint-grants.md) — register-grant, grant kinds, storage path, register-statement flow.
- [docs/api/](../api/) — [canopy-api.md](../api/canopy-api.md), [register-grant.md](../api/register-grant.md), [register-statement.md](../api/register-statement.md).
- Canopy API: `packages/apps/canopy-api/src/` — index, register-signed-statement, scrapi.
- Univocity grant shape: Brainstorm-0001 §3.4 (PublishGrant + idtimestamp, leaf commitment).
