# Subplan 02: REST auth log status and log type service

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

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
