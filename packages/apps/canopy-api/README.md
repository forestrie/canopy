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

## Request body encoding

Unsigned SCRAPI request bodies whose `content-type` carries `cbor` MUST be
deterministically encoded CBOR (RFC 8949 §4.2 core deterministic encoding):
shortest-form argument encoding, definite lengths only, canonical key order,
no duplicate keys, no tags.

This is the same requirement signed structures already carry in this
codebase — COSE Sign1, checkpoints, protected headers. Decode is strict both
ways: `@forestrie/encoding`'s `decodeCborDeterministic`
([`packages/shared/encoding/src/decode-cbor-deterministic.ts`](../../shared/encoding/src/decode-cbor-deterministic.ts))
is the one decoder used for both.

- `cbor-x` (and any other encoder that does not guarantee deterministic /
  canonical output) is **not supported**: it is a JSON-as-CBOR encoder and
  does not produce COSE/CTAP2-compatible canonical CBOR. A non-canonical
  body is rejected.
- The `forestrie/protocol` spec documents the same deterministic-CBOR
  requirement for the checkpoint envelope, and a companion change extends
  it explicitly to unsigned request bodies too: [checkpoints and receipts,
  §1](https://github.com/forestrie/protocol/blob/8d9809a98281c2387fd78fb3c837295d64b9a26a/spec/checkpoints-and-receipts.md#1-the-checkpoint).

## Bindings and secrets

- `SEQUENCING_QUEUE`: DO namespace for ingress queue (cross-worker RPC).
  **Required** for non–pool-test workers; the API returns **503** if unbound.
- `R2_MMRS`: R2 bucket for merklelog storage (massifs + checkpoints)
- `CUSTODIAN_APP_TOKEN`: Custodian app token (secret). **Required** outside
  `NODE_ENV=test` so receipt signatures can be verified against the
  per–owner-log key and for runner-side per-root bootstrap keys (`POST /api/keys`).
- `CUSTODIAN_APP_TOKEN`: bearer for curator/log-key + receipt verification.

### Test-only receipt verifier (`NODE_ENV=test` only)

For Vitest / pool workers without live Custodian on the receipt path, you may
set optional var **`FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX`**: **128** hex
characters (uncompressed P-256 **x‖y**, 64 bytes). If this var is **set** when
`NODE_ENV` is not `test`, the worker returns **503** (misconfiguration guard).
