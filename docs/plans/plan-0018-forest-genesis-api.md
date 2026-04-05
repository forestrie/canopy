---
Status: ACCEPTED
Date: 2026-04-04
Related:
  - [plan-0014](plan-0014-register-grant-custodian-signing.md)
  - Grant `logId` wire format: [`codec.ts`](../../packages/apps/canopy-api/src/grant/codec.ts) (CBOR key 1)
---

# Plan 0018 — `/api/forest` genesis API (step 1)

## Summary

Per–log administration under `/api/forest/**` with deployment checks that do **not** require `ROOT_LOG_ID` for those routes. Step 1 adds **POST `/api/forest/{log-id}/genesis`**, which writes a **COSE_Key**-shaped CBOR document (plus Forestrie private labels) to **R2_GRANTS** at `forest/{wire-log-id-hex64}/genesis.cbor`.

## Prerequisites by route (`checkRequestEnv`)

- **`/api/forest` and `/api/forest/...`** (non–pool): **`CURATOR_ADMIN_TOKEN`** must be set (trimmed). Missing → **503** (CBOR problem); message must **not** cite `ROOT_LOG_ID`, queue, or receipt configuration.
- **All other routes** (non–pool): existing chain — bootstrap trio → **SEQUENCING_QUEUE** → receipt verifier (`CUSTODIAN_APP_TOKEN`, no pool-only receipt test hex outside test mode).
- **Pool / Vitest** (`NODE_ENV === "test"`): `checkRequestEnv` returns no 503 from these guards (unchanged parity).

Bearer **validation** (401) is separate: forest handler compares `Authorization: Bearer` to `CURATOR_ADMIN_TOKEN` in constant time when the env token is configured.

## Module layout

| Area                 | Path                                                | Notes                                                              |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| CBOR HTTP helpers    | `packages/apps/canopy-api/src/cbor-api/`            | Request/response, problem details, `cbor-map-utils`, content types |
| COSE_Key IANA labels | `packages/apps/canopy-api/src/cose/cose-key.ts`     | Shared numeric keys/values                                         |
| Forest admin         | `packages/apps/canopy-api/src/forest/`              | Dispatch, curator bearer, `post-genesis`, `forest-genesis-labels`  |
| Wire log id          | `packages/apps/canopy-api/src/grant/log-id-wire.ts` | Same bytes as grant CBOR key `1`                                   |

## Genesis object

- **Standard COSE_Key** (P-256 / ES256): labels per IANA (see `cose-key.ts`).
- **Private labels** `-68010`…`-68012`: bootstrap-logid (32-byte bstr, server-set from route), optional univocity-addr / univocity-chainids.
- **Auth:** `CURATOR_ADMIN_TOKEN` (Wrangler secret); **`Env`** and `worker-configuration.d.ts` extension as needed.

## Tests

- **`deployment-env-validation.test.ts`**: forest **503** without curator token; **201** genesis with `NODE_ENV: development`, no trio / `ROOT_LOG_ID`, with token and bindings.
- **`forest-genesis.test.ts`**: **201** + R2 CBOR shape; **401**; **409** duplicate; **400** / **415** validation.

## Out of scope (this step)

Custodian changes; consuming genesis in bootstrap / `register-grant` / receipts; GET genesis (optional later).
