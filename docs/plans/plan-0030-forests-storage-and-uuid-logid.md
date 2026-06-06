# Plan 0030: Forests storage and UUID log IDs

**Status**: DRAFT  
**Date**: 2026-06-06  
**Related**: [plan-0029](plan-0029-delegate-grant-validation-to-univocity.md),
[arbor ADR-0004](../../arbor/docs/adr/adr-0004-forests-storage-and-uuid-log-ids.md),
[arbor plan-0009](../../arbor/docs/plan-0009-forests-storage-and-uuid-logid.md)

## Goal

Align canopy R2 paths, log ID types, and univocity clients with ADR-0004.

## Tasks

1. Canonical 16-byte UUID in `uuid-bytes.ts`; storage segment = dashed UUID string.
2. R2 key `forests/forest/{uuid}/genesis.cbor` in R2_GRANTS.
3. Univocity clients use UUID in URLs; grant POST `rootLogId` as 16-byte bstr.
4. Keep 32-byte padded bstr at grant/genesis CBOR and commitment boundaries only.
5. Update unit and Playwright e2e tests.

## Dev migration (clean break)

Deploy **univocity** before (or with) **canopy-api**. Wipe legacy `forest/` and
`index/log/` objects in `forest-dev-5-logs`; wipe canopy `R2_GRANTS` genesis
copies after deploy:

```sh
task cloudflare:genesis:delete LOG_ID=<uuid-R>
```

Current key: `forests/forest/{uuid}/genesis.cbor`. Re-bootstrap forests and run
`task test:e2e` (Doppler).

## Verification

- `pnpm -r --filter './packages/**' typecheck`
- `pnpm -r test`
- `task test:e2e` (Doppler)
