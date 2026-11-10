# `@canopy/api`

Cloudflare Worker implementing the SCRAPI-compatible transparency log API.

## Statement Registration

Inbound statements are enqueued to the `SequencingQueue` Durable Object
(owned by `forestrie-ingress` worker) for sequencing by ranger. The content
hash is used as the pre-sequence operation identifier.

## Log authority

A log's root key comes only from univocity
(`GET /api/logs/{logId}/authority`), and grants authority only once it is
anchored on chain
([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md),
[protocol ADR-0070](https://github.com/forestrie/protocol/blob/main/adr/adr-0070-sec-log-authority-anchored-before-use.md)).
Receipts on grants verify under that key. Admission refuses a statement for a
pending log, and a grant under a pending owner, with 409 `authority-pending`
and `Retry-After`; a conflicted log gets 409 `authority-conflict`. Both come
before any x402 payment. Custodian and the delegation coordinator are never
key sources.

`POST /api/forest/{childLogId}/prepare` reserves the child through univocity
before it forwards the root to the coordinator, and returns the
reservation's `expiresAt`. A create grant commits its claim before it is
sequenced.

## Bindings and secrets

- `SEQUENCING_QUEUE`: DO namespace for ingress queue (cross-worker RPC).
  **Required** for non–pool-test workers; the API returns **503** if unbound.
- `R2_MMRS`: R2 bucket for merklelog storage (massifs + checkpoints)
- `UNIVOCITY_SERVICE_URL`: univocity base URL. **Required** outside
  `NODE_ENV=test` (503 otherwise): the log authority and grant claim store.
- `UNIVOCITY_API_TOKEN` (secret): bearer for canopy-api's univocity calls.
- `UNIVOCITY_AUTHORITY_CACHE_SECONDS`: edge-cache time for an anchored answer
  that is not yet final (default 30). Final answers are cached without
  expiry; pending answers never.
- `DELEGATION_COORDINATOR_URL`, `COORDINATOR_APP_TOKEN` (secret): public-root
  and webhook forwards to the delegation coordinator.

### Test-only receipt verifier (`NODE_ENV=test` only)

For Vitest / pool workers without live univocity on the receipt path, you may
set optional var **`FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX`**: **128** hex
characters (uncompressed P-256 **x‖y**, 64 bytes). If this var is **set** when
`NODE_ENV` is not `test`, the worker returns **503** (misconfiguration guard).
