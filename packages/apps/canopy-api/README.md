# `@canopy/api`

Cloudflare Worker implementing the SCRAPI-compatible transparency log API.

## Statement Registration

Inbound statements are enqueued to the `SequencingQueue` Durable Object
(owned by `forestrie-ingress` worker) for sequencing by ranger. The content
hash is used as the pre-sequence operation identifier.

## Bindings

- `SEQUENCING_QUEUE`: DO namespace for ingress queue (cross-worker RPC)
- `SEQUENCED_CONTENT`: DO namespace for querying sequenced content (ranger-cache)
- `R2_MMRS`: R2 bucket for merklelog storage (massifs + checkpoints)
