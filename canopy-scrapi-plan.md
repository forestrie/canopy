# SCITT SCRAPI v05 Implementation Plan (Revised)

This plan aligns with the simplified baseline: CBOR-only SCRAPI (except `/api/health` JSON), no queue usage, R2 pre-sequencing storage, and minimal well-known discovery.

## Scope and Endpoints

- .well-known
  - `GET /.well-known/scitt-configuration` — Transparency configuration (CBOR)
- Keys
  - `GET /api/v1/keys` — Transparency Service Keys (CBOR; may be empty initially)
- Statements
  - `POST /api/v1/logs/{logId}/statements` — Register Signed Statement (CBOR-only body; returns 202 CBOR)
- Operations (optional baseline)
  - `GET /operations/{operationId}` — CBOR; mock/status when needed
- Health (non-SCRAPI)
  - `GET /api/health` — JSON only

## Phase 1: Helpers

- `src/lib/scrapi/cbor.ts`: CBOR responses, Accept/Content-Type guards, problem envelope
- `src/lib/scrapi/problem-details.ts`: RFC7807-like CBOR problem details
- `src/lib/scrapi/validation.ts`: UUID and parameter validation
- `src/lib/scrapi/types.ts`: Core types (operations, configuration)

## Phase 2: Core Endpoints

- Implement the three endpoints above, backed by R2 storage and `mmr-mock` for fenceIndex=0.
- No Queue usage; do not enqueue messages.

## Phase 3: CBOR-Only Rules

- All SCRAPI endpoints are CBOR-only (request and response). Return 406/415 problem details as appropriate.
- `/api/health` remains JSON for ops.

## Phase 4: Tests

- Update e2e tests to send/receive CBOR for SCRAPI endpoints.
- Add helpers to decode CBOR in tests via `cbor-x`.

## Success Criteria

- All SCRAPI endpoints return valid CBOR.
- Problem details are CBOR and concise.
- Well-known configuration is present and includes `/api/v1/keys`.
- No queue references remain in code, infra, or docs.
