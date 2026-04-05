# `@canopy/api`

Cloudflare Worker implementing the SCRAPI-compatible transparency log API.

## Statement Registration

Inbound statements are enqueued to the `SequencingQueue` Durable Object
(owned by `forestrie-ingress` worker) for sequencing by ranger. The content
hash is used as the pre-sequence operation identifier.

Authorized grants that include a SCITT receipt must present a receipt COSE Sign1
that verifies under the ES256 public key Custodian maps to `grant.ownerLogId`
(`GET /api/keys/curator/log-key` + `GET /api/keys/{keyId}/public`), using
`CUSTODIAN_URL` and `CUSTODIAN_APP_TOKEN`. Ranger (or whoever produces receipts)
must sign with that same key material so inclusion checks can succeed.

## Bindings and secrets

- `SEQUENCING_QUEUE`: DO namespace for ingress queue (cross-worker RPC).
  **Required** for non–pool-test workers; the API returns **503** if unbound.
- `R2_MMRS`: R2 bucket for merklelog storage (massifs + checkpoints)
- `CUSTODIAN_APP_TOKEN`: Custodian app token (secret). **Required** outside
  `NODE_ENV=test` so receipt signatures can be verified against the
  per–owner-log key. Bootstrap mint still uses `CUSTODIAN_BOOTSTRAP_APP_TOKEN`.

### Test-only receipt verifier (`NODE_ENV=test` only)

For Vitest / pool workers without live Custodian on the receipt path, you may
set optional var **`FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX`**: **128** hex
characters (uncompressed P-256 **x‖y**, 64 bytes). If this var is **set** when
`NODE_ENV` is not `test`, the worker returns **503** (misconfiguration guard).
