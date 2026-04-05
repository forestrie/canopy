# Plan 0008: Remove /grants/authority and grant storage from register-grant

**Status:** DRAFT  
**Date:** 2025-03-14  
**Related:** [Plan 0005](plan-0005-grant-receipt-unified-resolve.md), [Plan 0004 Subplan 03](plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md)

## 1. Rationale

The caller is required to provide the grant (e.g. in the request body or as Authorization: Forestrie-Grant). After POST grant, the caller gets everything they need from:

- **query-registration-status**: When sequencing completes, 303 to `/logs/{logId}/{massifHeight}/entries/{entryId}/receipt`. The `entryId` is 32 hex chars = idtimestamp_be8 || mmrIndex_be8, so the caller can decode idtimestamp.
- **resolve-receipt**: GET that receipt URL returns the receipt (COSE with inclusion proof).

The caller already has the grant content; they obtain idtimestamp from the entryId in the redirect URL and the receipt from resolve-receipt. There is no need for the server to store the grant at `authority/{innerHex}.cbor` or to expose GET /grants/authority/{innerHex}. Removing grant storage and the /grants/authority path simplifies the implementation and matches the intended flow.

## 2. Goals

- Stop writing grants to R2 at register-grant (no `authority/{innerHex}.cbor`).
- Stop returning X-Grant-Location pointing to /grants/authority/{innerHex}.
- Remove GET /grants/authority/{innerHex} and all code that reads from that path.
- Remove the constant and any dead code related to sequenced-grant storage.

## 3. Implementation steps

| Step | Action |
|------|--------|
| 3.1 | **register-grant.ts**: Remove `env.r2Grants.put(storagePath, contentBytes)` in both the queue-only path and in `enqueueAndStoreGrant`. Remove `X-Grant-Location` header from the 303 response. Remove `r2Grants` from `RegisterGrantEnv` and from the `registerGrant` call in index. Remove import and use of `SEQUENCED_GRANT_KIND_SEGMENT`. Update JSDoc: caller uses status URL, query-registration-status, and resolve-receipt to get entryId (and thus idtimestamp) and receipt. |
| 3.2 | **index.ts**: Remove the GET /grants/authority/{innerHex} route block (the one that calls `serveGrant`). Remove any env passed only for that route (e.g. R2_GRANTS, R2_MMRS, etc. for serve-grant if not used elsewhere for grants). |
| 3.3 | **serve-grant.ts**: Delete the file (it only contains `serveGrant` and `getCompletedGrant`; `getCompletedGrant` is never called). |
| 3.4 | **storage-path.ts**: Remove `SEQUENCED_GRANT_KIND_SEGMENT` and the comment about sequenced grants. Remove export from grant/index.ts. |
| 3.5 | **register-signed-statement**: Remove the unused `r2Grants` parameter from `registerSignedStatement` and from the call site in index.ts. |
| 3.6 | **Tests**: Update or remove tests that depend on X-Grant-Location, GET /grants/authority, or R2 grant storage (e.g. register-grant.test.ts, any serve-grant or getCompletedGrant tests). |

## 4. Caller flow after change

1. POST /register/grants with grant in body or Authorization: Forestrie-Grant (transparent statement).
2. Server enqueues for sequencing; returns 303 to `/logs/{ownerLogId}/entries/{innerHex}` (status URL).
3. Client polls GET that status URL until query-registration-status returns 303 to `/logs/{logId}/{massifHeight}/entries/{entryId}/receipt`.
4. Client decodes entryId (hex) to get idtimestamp and mmrIndex; GET the receipt from that URL.
5. Client has: grant (they had it), idtimestamp (from entryId), receipt (from resolve-receipt). They can build the completed transparent statement if needed.

No server-side grant storage or GET /grants/authority required.
