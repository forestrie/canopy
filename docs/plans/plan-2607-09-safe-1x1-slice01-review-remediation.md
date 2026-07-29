# plan-2607-09 — Safe 1x1 slice 01 review remediation

**Status:** IMPLEMENTED (2026-07-29 — R1 + C3 applied on the PR branch; C2
applied as observable-swallow, full convergence deferred to the ADR-0010
migration)
**Date:** 2026-07-29
**Related:** devdocs plan-2607-45 slice 01, FOR-500, canopy#200 (branch
`mandate-1`), review via forestrie-agents `review-changes`.

## Scope reviewed

`git diff main...HEAD` on `mandate-1` (commits `3e18cec`, `822c4d2`):
ERC-1271 hooks on the bootstrap-key CWT verifier (per-alg strategy table),
shared `@forestrie/chain-rpc` factory adopted by grant path + coordinator,
coordinator padded-magic fix, onboarding CORS regression suite.

## Findings

| ID | Sev | Dim | Location | Finding |
|----|-----|-----|----------|---------|
| C1 | Medium | Correctness / observability | `grant/ks256-verify.ts`, `onboarding/onboard-attestation.ts` (`verifyKs256` contract branch) | Fail-closed collapses **RPC outage** into `false`, so HTTP boundaries emit auth-failure shapes (403 "attestation rejected: attestation signature invalid"; 4xx "Statement COSE signature verification failed") for what is an availability incident. Clients treat 4xx as non-retryable. The deployment gate on the SAME request path already distinguishes: `univocity-deployment-gate.ts` maps RPC probe failure to **503**. Pre-change the grant path's un-awaited `return verifyErc1271Signature(...)` let eth_call rejections propagate (→5xx), so this is a semantics regression for that leg, and an inherited conflation for the rest. |
| C2 | Low | Best practice / consistency | `delegation-coordinator/src/ks256-rpc-verify-hooks.ts` | Coordinator hooks deliberately preserve swallow-to-`false` semantics: a failing `eth_getCode` falls into the EOA branch (which then fails for a contract signature — fail-closed only by accident). canopy-api is now strictly fail-closed; the coordinator should converge (with C1's typed error), ideally alongside the ADR-0010 follow-on migrating `KS256_RPC_URL` to supported-chains config. |
| C3 | Low | Testability / diagnostics | `onboarding/handle-onboarding-request.ts`, `payments/account-read.ts` | A warm positive gate cache lets a request reach attestation verify after `SUPPORTED_CHAINS_RPC` drops the chain; `capabilities.erc1271` is then `undefined` and a contract root 403s with the generic invalid-signature detail while EOA roots still pass. Fail-closed is correct; the detail string gives ops nothing to find the misconfig with. |

## Design notes (non-obvious, upheld)

- plan-0029 invariants hold: digest stays `keccak256(Sig_structure)` at every
  tier; ERC-1271 extends WHO holds the KS256 address; no new COSE alg; the
  65-byte EOA length rule is not applied to contract signatures (test-pinned).
- The coordinator magic-value fix is a **latent Mode D blocker** removed:
  strict equality vs the ABI-padded `bytes4` word rejected every genuine Safe
  signature. The fix ships only when the coordinator is **redeployed** — the
  dev secret `KS256_RPC_URL` is already set, so deploy order matters for the
  demo beat.
- Magic acceptance is by prefix (`startsWith("0x1626ba7e")`), which equals
  strict ABI `bytes4` decoding of the first return word and matches the
  univocity verifier; a non-zero tail is tolerated identically everywhere.

## Remediation items

### R1 (from C1) — distinguish "cannot verify" from "verified false"

- `createErc1271VerifyHooks` already throws on RPC failure; stop flattening
  it at the two canopy-api catch sites. Introduce a typed
  `Erc1271UnavailableError` (chain-rpc) or a tri-state verifier result;
  `verifyBootstrapKeyCwt` returns a distinguishable
  `{ ok: false, unavailable: true }`, and `verifyKs256CoseSign1` gains an
  opts flag or typed throw.
- HTTP mapping: onboarding create / account read / register-signed-statement
  return **503** (matching the gate's existing RPC-failure shape) when
  verification was unavailable; **403/4xx** only when a verifier said no.
- Acceptance: unit tests pin RPC-error ⇒ 503-shaped result at each boundary;
  existing fail-closed tests unchanged (no ecrecover fallback for contract
  roots).
- Branch: current stack (canopy#200 follow-up commit or immediate successor).

### Applied (2026-07-29, on the PR branch)

- **R1**: `Erc1271UnavailableError` thrown by the chain-rpc factory;
  `BootstrapKeyCwtResult` gains `unavailable: true`; onboarding create and
  account read map it to 503; the grant verifier gains an opt-in
  `throwOnUnavailable` (only `register-signed-statement` opts in → 503;
  delegation-verify / receipt-resolution / child-log chains keep logged
  fail-closed `false` byte-for-byte — deliberate blast-radius containment).
  Tests: verifier-level unavailable vs plain-rejection distinction,
  account-read route 503, grant seam default-vs-opt-in.
- **C2 (partial)**: coordinator hooks now log every swallowed RPC error
  (`ks256RpcVerifyHooksFailure`); behavior unchanged. Full fail-closed
  convergence stays with the ADR-0010 `KS256_RPC_URL` → supported-chains
  migration.
- **C3**: shared `attestationVerifyCapabilities` helper warns
  (`erc1271HooksMissing`) when a KS256 root is gate-admitted for a chain
  with no RPC configured.
