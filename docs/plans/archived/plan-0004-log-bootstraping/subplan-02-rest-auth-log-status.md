# Subplan 02: REST auth log status and log type service

**Status**: ACCEPTED  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

Implementation complete in **arbor** `services/univocity`; see §8.8 (status) and §8.9 (optional verification gaps).

## 1. Scope

- Implement a **REST service** (scout-like) that reads **root** and **log config** from the univocity contract via RPC.
- Expose **query endpoints** for: root existence, log type (authority vs data) per logId, and list of known auth logs.
- Design so the **sealer** can use it for **signing key resolution** (which key to use for a given logId); and external implementations can **gate** register-statement on “root exists” and optionally child availability.

**Out of scope**: Grant issuance, queue consumption, or writing to chain; this service is read-only.

## 2. Dependencies

- None for initial build. Required by subplan 05 (queue consumer: detect “not bootstrapped”, resolve parent) and subplan 07 (sealer key resolution).

## 3. Inputs

- Univocity contract address and RPC endpoint (config).
- Contract ABI / interface for root log id and log state (e.g. `rootLogId()`, `getLogState(logId)` or equivalent).
- Refinement: exact endpoint list and response shapes (overview §4.2).

## 4. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **REST API** | Endpoints: e.g. “root exists?”, “log type for logId?”, “list known auth logs”. Read-only; no side effects. |
| **Chain integration** | Read contract state via go-ethereum (or equivalent); derive root existence and log kind/config. |
| **Awareness of new logs** | Mechanism to reflect new logs as they are created (polling or event subscription). |
| **Sealer-oriented query** | Support for “which signing key / key id for this logId?” (log type + owner) so subplan 07 can consume. |

## 5. Verification

- Service returns “root exists” = false before bootstrap and true after (with a deployed contract and bootstrap flow).
- Given a logId, returns correct log type (authority vs data) and owner when known.
- Sealer (or mock) can call the service to resolve key for a logId (subplan 07 verification).

## 6. References

- Univocity: `docs/arc/arc-0017-auth-overview.md`, `docs/arc/arc-0017-log-hierarchy-and-authority.md`, contract storage/interface for LogState and root.
- Overview: §4 (REST auth log status), §4.3 (sealer key resolution); refinement §4.2.

## 7. Implementation (arbor univocity service)

Implemented in **arbor** repository: `services/univocity` — a dedicated service (sibling of scout, following the same structural pattern). Requires `UNIVOCITY_RPC_URL` and `UNIVOCITY_CONTRACT_ADDRESS`; the service exits at startup if either is missing.

### 7.1 Endpoints and response shapes

| Method | Path | Description | Response (JSON) |
|--------|------|-------------|-----------------|
| GET | `/api/root` | Root existence and root log id | `{ "exists": bool, "rootLogId": "0x..." }` (empty string when not bootstrapped) |
| GET | `/api/logs` | List known auth logs | `{ "rootLogId": "0x..." \| null, "authLogs": ["0x..."] }`; currently at least root when bootstrapped |
| GET | `/api/logs/{logId}/config` | Log kind and config for a logId | `{ "kind": "authority" \| "data" \| "undefined", "authLogId": "0x...", "initializedAt": number }`; 404 when log not initialized |
| GET | `/api/logs/{logId}/signing-key` | Sealer key resolution | `{ "logId", "kind", "ownerLogId", "rootKeyX", "rootKeyY" }`; 404 when log not initialized |

- `logId` in path: `0x`-prefixed hex, 32 or 64 hex chars (32-byte or 16-byte, right-padded to 32 bytes).

### 7.2 Contract calls

- `rootLogId()` → bytes32 (zero = not bootstrapped).
- `isLogInitialized(bytes32 logId)` → bool.
- `logConfig(bytes32 logId)` → (LogKind kind, bytes32 authLogId, bytes rootKey, uint256 initializedAt).
- `logRootKey(bytes32 logId)` → (bytes32 rootKeyX, bytes32 rootKeyY).

Contract interface: univocity `IUnivocity.sol` and `types.sol` (LogKind: Undefined=0, Authority=1, Data=2).

### 7.3 Awareness of new logs

Current implementation does not index created logs; `GET /api/logs` returns only the root when bootstrapped. A later enhancement may add event subscription or polling to populate a full list of known auth logs.

## 8. Implementation plan (agent-optimised)

Ordered steps with input, output, location, and verification. No dependencies on other subplans for build. Config: `UNIVOCITY_RPC_URL`, `UNIVOCITY_CONTRACT_ADDRESS` (service exits at startup if missing).

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **8.1** | Service skeleton and config | RPC URL, contract address (env) | Service that binds config and exits if missing | Arbor: `services/univocity` (sibling of scout). Load env; exit with clear error if either var unset. | Service fails fast with message when env incomplete. |
| **8.2** | Contract bindings | Univocity ABI (IUnivocity.sol, types.sol) | Go client: rootLogId, isLogInitialized, logConfig, logRootKey | Same repo; go-ethereum or equivalent. Normalise logId to bytes32 (0x-prefix, 32 bytes). | Unit test with mock RPC or testnet: rootLogId returns zero / non-zero. |
| **8.3** | GET /api/root | Contract rootLogId() | `{ "exists": bool, "rootLogId": "0x..." }` | Handler: call rootLogId(); exists = (result != 0); rootLogId = hex. | Request returns 200; exists false before bootstrap, true after. |
| **8.4** | GET /api/logs | Contract rootLogId() | `{ "rootLogId", "authLogs": ["0x..."] }` | Return root when bootstrapped; authLogs at least [root]. Per §7.3 full list is later enhancement. | Bootstrapped contract: authLogs contains root. |
| **8.5** | GET /api/logs/{logId}/config | logId (path), isLogInitialized, logConfig | `{ "kind", "authLogId", "initializedAt" }` or 404 | Parse logId (0x hex, 32 or 64 chars); if !isLogInitialized → 404; else logConfig → kind, authLogId, initializedAt. | Initialized logId returns kind; unknown → 404. |
| **8.6** | GET /api/logs/{logId}/signing-key | logId, logConfig, logRootKey | `{ "logId", "kind", "ownerLogId", "rootKeyX", "rootKeyY" }` or 404 | After logConfig, call logRootKey(logId); return shape per §7.1. 404 when log not initialized. | Sealer (or mock) can call and get key fields for a known log. |
| **8.7** | Wire routes and startup | Handlers from 8.3–8.6 | HTTP server exposing /api/root, /api/logs, /api/logs/{logId}/config, /api/logs/{logId}/signing-key | Register routes; serve on configured port. Startup: validate config then listen. | Integration test: hit each endpoint; response shape matches §7.1. |

**Data flow (concise).** Config (8.1) → contract client (8.2) → GET /api/root (8.3) → GET /api/logs (8.4) → GET /api/logs/{logId}/config (8.5) → GET /api/logs/{logId}/signing-key (8.6) → routes wired (8.7).

**Files to add or touch (arbor).** New service: `services/univocity/` (main, config, contract bindings, handlers for each endpoint, routes). Structure mirrors scout (same repo pattern). Config: require `UNIVOCITY_RPC_URL`, `UNIVOCITY_CONTRACT_ADDRESS`.

### 8.8 Implementation status (arbor `services/univocity`)

Implemented at **arbor** `services/univocity/src/`. All steps 8.1–8.7 are **Done**.

| Step | Status | Notes |
|------|--------|--------|
| **8.1** | Done | `config.go`: LoadConfig from env; `main.go`: exit(1) with message when `UNIVOCITY_RPC_URL` or `UNIVOCITY_CONTRACT_ADDRESS` empty. |
| **8.2** | Done | `chain.go`: ABI and RootLogId, IsLogInitialized, LogConfig, LogRootKey; `LogIDFromHex` normalises to bytes32 (0x-prefix, ≤32 bytes right-padded). |
| **8.3** | Done | `handlers.go` handleRoot: GET only; exists = (root != zero); rootLogId hex or "" when !exists. |
| **8.4** | Done | handleLogsList: rootLogId (omitempty when not bootstrapped), authLogs = [root] when bootstrapped. |
| **8.5** | Done | handleLogConfig: logId from path; !isLogInitialized → 404; response kind, authLogId, initializedAt. |
| **8.6** | Done | handleSigningKey: logId from path; 404 when not initialized; response logId, kind, ownerLogId (authLogId), rootKeyX, rootKeyY. |
| **8.7** | Done | `api.go` RegisterRoutes; `main.go` validates config, creates contract, wires mux, serves. Health/ready/version/metrics stubs present. |

### 8.9 Gaps and optional improvements — implemented

- **8.2 verification**: Implemented. `ChainReader` interface added for testability; `chain_test.go` has `TestMockChain_RootLogId_ZeroAndNonZero` (mock returns zero vs non-zero). `api_test.go` also verifies root zero/non-zero via GET /api/root.
- **8.7 verification**: Implemented. `api_test.go` has `TestAPI_ResponseShapes`: table-driven tests with mock chain for GET /api/root (not bootstrapped / bootstrapped), GET /api/logs (rootLogId null vs present, authLogs), GET /api/logs/{logId}/config (404 when not initialized, 200 and kind/authLogId/initializedAt), GET /api/logs/{logId}/signing-key (404 when not initialized, 200 and logId/kind/ownerLogId/rootKeyX/rootKeyY). All response shapes match §7.1.
- **§7.1 /api/logs**: Implemented. Response struct uses `json:"rootLogId"` (no omitempty); when not bootstrapped the service returns explicit `"rootLogId": null`.

### 8.10 Design updates (no code changes required)

Plan 0004 design updates (canopy primary path, idtimestamp optional in batch ack, R2 fallback, inner = ContentHash) do **not** require changes to the univocity service. It remains a read-only REST service for root and log config. Consumers: **subplan 07** (sealer key resolution), **subplan 05** (optional queue consumer: root exists, parent resolution), and optionally **subplan 06** (canopy: root exists if needed).
