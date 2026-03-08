# Plan 0003 follow-up: generate-grant-pool script review

**Status:** DRAFT  
**Date:** 2026-03-08  
**Related:** [plan-0003-encoding-redux.md](plan-0003-encoding-redux.md), [adr-0001-encoding-one-per-artifact.md](../adr-0001-encoding-one-per-artifact.md)

## Scope

Review `perf/scripts/generate-grant-pool.mjs` for:

1. Correctness against the shared grant-request encoder and API contract.
2. Whether it can and should use `@canopy/encoding` (shared support).

## Correctness vs shared implementation

### Contract alignment

- **Keys and order:** Script and shared encoder both emit CBOR map with integer keys in order: 3=logId, 4=ownerLogId, 5=grantFlags, 8=grantData, 9=signer, 10=kind. Matches API `parseGrantRequest` (accepts both int and string keys).
- **Values:** All values are byte strings (bstr). Field lengths in current use: logId 16, ownerLogId 16, grantFlags 8, grantData 0, signer 32, kind 1. All within the range where both encodings agree.

### CBOR bstr encoding

- **Script (`cborBstr`):** Uses major type 2; len &lt; 24 → 0x40+len; len &lt; 256 → 0x58, len; else → 0x59, (len&gt;&gt;8), (len&amp;0xff). Does not handle len ≥ 65536 (would produce wrong two-byte length).
- **Shared (`encodeCborBstr`):** Same for len &lt; 65536; adds 0x5a (four-byte length) for len ≥ 65536.
- **Verdict:** For all current grant-request field sizes the script is correct. The only difference is edge-case behaviour for very long bstrs (irrelevant for this artifact).

### Other behaviour

- **UUID parsing:** Script’s `uuidToBytes` (strip hyphens, 32 hex chars, big-endian) is correct. Shared encoder does not implement UUID parsing; it takes `Uint8Array` inputs.
- **Optional fields:** API allows optional keys 6, 7, 11, 12 (maxHeight, minGrowth, exp, nbf). Script does not send them; that is valid.

**Conclusion:** The script is correct and matches the shared encoder and API for current use. No correctness bugs found. Only theoretical improvement would be handling bstr length ≥ 65536 in the script if it were to remain the canonical encoder for this path.

## Can it use shared support?

- **Technically:** The shared encoder lives in `@canopy/encoding` (TypeScript, consumed as TS by the monorepo). The script is Node ESM (`.mjs`). To use the shared encoder we need either:
  - A way to run the script in a context where `@canopy/encoding` resolves (e.g. a workspace package that depends on it and runs the script with `tsx`), or
  - A built JS output of the encoding package and a runner that resolves it (heavier).
- **Feasibility:** Add a minimal `perf` workspace package that depends on `@canopy/encoding` and (e.g.) `tsx`; convert the script to TypeScript and run it with `tsx`. Then the script can `import { encodeGrantRequest } from "@canopy/encoding"` and drop its local CBOR/grant-request logic.

## Should it use shared support?

**Yes.**

- **Single source of truth:** Grant-request encoding is already implemented and tested in `@canopy/encoding`. Duplicating it in the script risks drift (e.g. new keys, encoding fixes).
- **Plan 0003:** The plan called for the script to either use the shared encoder or pass a conformance check; using the shared encoder satisfies that and removes the need to maintain a parallel implementation.
- **Testing:** The shared encoder is covered by unit tests and by grant-pool-signer-chain and API tests. The script then becomes a thin caller; no separate conformance test for “script bytes match shared” is needed.

## Recommendation (implemented)

1. **Done:** Added `perf` package to the workspace with dependency on `@canopy/encoding` and `tsx`.
2. **Done:** Replaced `generate-grant-pool.mjs` with `perf/scripts/generate-grant-pool.ts` calling `encodeGrantRequest` from `@canopy/encoding`; removed duplicate CBOR/grant-request logic.
3. **Done:** Updated CI workflow, taskfile, k6 README, and scenario comments to run `pnpm --filter @canopy/perf run generate-grant-pool`.
4. Output format (grant-pool.json with `signer` hex and `grants[]`) and env vars unchanged; k6 and existing usage unchanged.
