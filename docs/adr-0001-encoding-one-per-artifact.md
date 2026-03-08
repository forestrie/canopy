# ADR-0001: One implementation per artifact for encoding and verification

**Status**: ACCEPTED  
**Date**: 2026-03-08  
**Related**: [Plan 0003](plans/plan-0003-encoding-redux.md), [arc-statement-cose-encoding](arc-statement-cose-encoding.md)

## Context

Tests, performance tests (k6), and the API had multiple encoders for the same logical artifacts (statement COSE, grant request CBOR, problem details), leading to drift and inconsistent behaviour.

## Decision

1. **One implementation per artifact** unless tooling forces otherwise (e.g. k6 cannot use Node/TS; then one canonical spec + minimal second implementation with contract tests).
2. **One file per primitive; one file per artifact** that composes primitives (e.g. `encode-cbor-bstr.ts`, `encode-cose-sign1-statement.ts`).
3. **Shared primitives only when reused** across artifacts (e.g. CBOR bstr used by both grant request and COSE).
4. **Signing and verification in one place per concern**; cryptographic verification of COSE Sign1 with a public key is in scope (encode → sign → verify).
5. **Canonical implementations** live in `packages/shared/encoding` (`@canopy/encoding`); k6 keeps a JS mirror in `perf/k6/canopy-api/lib/cose.js` aligned by contract; tests use the shared package.

## Consequences

- New shared package `@canopy/encoding` holds statement COSE encoder, grant request encoder, problem details interface/encoder, and verify/sign helpers.
- Tests and API consume `@canopy/encoding`; k6 remains the only JS encoder for statement COSE (no duplicate elsewhere).
- `scripts/gen-cose-sign1.mjs` is documented as legacy (no kid; does not satisfy current statement contract).
