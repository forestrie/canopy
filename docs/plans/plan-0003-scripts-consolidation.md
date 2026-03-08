# Scripts consolidation: use of shared packages

**Status:** ACCEPTED  
**Date:** 2026-03-08  
**Related:** [plan-0003-encoding-redux.md](plan-0003-encoding-redux.md), [plan-0003-grant-pool-script-review.md](plan-0003-grant-pool-script-review.md)

## Scope

Identify all scripts that could use `@canopy/encoding` (or other shared packages) and consolidate where it adds value.

## Scripts inventory

| Script                                          | Purpose                                                                  | Uses CBOR/COSE/encoding?                              | Use shared?                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **scripts/gen-cose-sign1.mjs**                  | Generate COSE Sign1 (legacy: empty protected, no kid) for ad‑hoc/testing | Yes: custom `encodeBstrHeader`, hand-built COSE array | **Yes** – use `encodeCborBstr` from @canopy/encoding; remove duplicate bstr logic.         |
| **scripts/decode-receipt.mjs**                  | Decode SCITT receipt (COSE_Sign1) and pretty-print CDDL-like             | Yes: cbor-x decode, hand structure                    | **Yes** – use `decodeCoseSign1` from @canopy/encoding for structure; same contract as API. |
| **scripts/decode-problem-details.mjs**          | Decode CBOR problem details from stdin → JSON                            | Yes: `cbor` decode only                               | Optional – switch to `cbor-x` for repo consistency; shared has encode only, no decode.     |
| **scripts/gen-x402-payment-signature.mjs**      | EIP-3009 / x402 payment header                                           | No                                                    | No.                                                                                        |
| **scripts/x402-faucet.mjs**                     | x402 dev wallet balance / faucet                                         | No                                                    | No.                                                                                        |
| **perf/scripts/generate-grant-pool.ts**         | Create grants for k6 (grant-pool.json)                                   | Yes                                                   | **Done** – uses @canopy/encoding (see grant-pool review).                                  |
| **perf/scripts/generate-x402-payment-pool.mjs** | x402 payment pool for k6                                                 | No                                                    | No.                                                                                        |
| **perf/scripts/reset-x402-auth.mjs**            | Reset x402 auth state                                                    | No                                                    | No.                                                                                        |
| **perf/scripts/generate-shard-balanced-ids.js** | Generate log IDs for sharding                                            | No                                                    | No.                                                                                        |

## Consolidation plan

1. **@canopy/scripts package** (root `scripts/` as workspace package)
   - Dependencies: `@canopy/encoding`, `cbor-x`, `tsx`.
   - Run via: `pnpm --filter @canopy/scripts run <script>`.
   - Invoked from taskfiles and docs; paths resolved relative to caller (e.g. `INIT_CWD` when run via pnpm).

2. **decode-receipt**
   - Migrate to TypeScript; use `decodeCoseSign1` from @canopy/encoding for the 4-part structure.
   - Decode protected header with cbor-x for display. Same COSE parsing as API.

3. **gen-cose-sign1**
   - Migrate to TypeScript; use `encodeCborBstr` from @canopy/encoding for payload (and any other bstr).
   - Keep building legacy 4-element array (empty protected, empty map, payload bstr, empty signature) by hand; no change to output format.

4. **decode-problem-details**
   - Leave as-is or later: convert to TS in same package and use `cbor-x` instead of `cbor` for consistency. No shared decode for problem details.

5. **x402 and other non-encoding scripts**
   - Leave as standalone .mjs; no shared encoding to use. Can move under scripts package later for a single entry point if desired.

## Invocation (implemented)

- Use `pnpm -s --filter @canopy/scripts run decode-receipt -- "{{.RECEIPT}}"` and `pnpm -s --filter @canopy/scripts run gen-cose-sign1 -- "{{.MESSAGE}}"` (or no args for random UUID message). The `-s` flag keeps stdout clean when capturing or piping.
- Paths: scripts that take file paths use `process.env.INIT_CWD || process.cwd()` as base when run via pnpm so paths stay relative to the caller (e.g. taskfile running from repo root).
- Taskfile (scrapi.yml) updated to use these invocations; `decode-problem-details.mjs` remains `node scripts/decode-problem-details.mjs` (not migrated).
