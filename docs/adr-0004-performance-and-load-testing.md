# ADR-0004: Performance and Load Testing for Forestrie Services

**Status**: READY
**Date**: 2025-11-23
**Categories**: [TESTING, PERFORMANCE, TOOLING]

## Context

Forestrie exposes SCITT/SCRAPI functionality across two repositories:

- `canopy`: Cloudflare Worker implementing the SCRAPI HTTP API as
  `canopy-api`
- `arbor`: Go-based services including `ranger`, which maintains the
  transparency log state

Both canopy-api and SCRAPI are CBOR-native APIs. Request and response
bodies are always CBOR or COSE; the HTTP `Content-Type` is never JSON.

We need performance and load tests that:

- Exercise canopy-api and ranger independently and together, using
  CT-like workloads (submit, read, inclusion checks)
- Model certificate-transparency style traffic patterns inspired by
  Trillian's `ct_hammer` while adapting to SCITT/SCRAPI semantics
- Capture latency distributions (p50, p90, p99) and throughput at
  specific target rates
- Run from both a developer workstation and GitHub Actions with minimal
  friction
- Support binary CBOR/COSE payloads and response decoding

Existing tools like `wrk` are useful for single-endpoint micro-benchmarks
but are not sufficient for expressing multi-step CT/SCITT scenarios or
for sharing test logic across canopy and arbor.

## Decision

We will:

1. **Adopt k6 as the primary performance and load testing tool** for
   scenario-based tests across canopy-api and ranger.
2. **Model workload patterns after Trillian's `ct_hammer`** where
   appropriate, adapting endpoints, payloads, and validations to the
   Forestrie SCITT/SCRAPI CBOR-native APIs.
3. **Adopt wrk2 (the Go-based wrk-style variant) as a secondary tool**
   for narrow, endpoint-specific benchmarks and local development runs.
   k6 remains the source of truth for scenario and regression testing.

## Consequences

### Positive

1. **Scenario-focused testing**: k6 provides first-class support for
   multi-step scenarios, arrival-rate based loads, and thresholds,
   matching CT-style workload needs better than raw wrk-style tools.
2. **Shared approach across repos**: The same k6-based scenarios can be
   applied to canopy-api (HTTP Worker) and ranger (Go service) with
   environment-specific base URLs.
3. **CBOR/COSE aware harness**: We can centralize CBOR/COSE encoding and
   decoding helpers for k6, ensuring all performance tests exercise the
   real wire format of the SCITT APIs.
4. **CI-friendly**: k6 has a single static binary and well-supported
   Docker images and GitHub Actions integrations, making it straightforward
   to run from GitHub Actions.
5. **CT-aligned workloads**: Borrowing `ct_hammer` patterns (write-heavy
   submissions, read-heavy monitors, mixed traffic) ensures performance
   testing reflects realistic log usage.
6. **Fast micro-benchmarks**: wrk2 remains available for quick, focused
   experiments on individual endpoints during development, without
   complicating the main scenario suite.

### Negative

1. **Additional tooling**: k6 is another tool for contributors to learn
   alongside existing test runners.
2. **Custom CBOR support**: k6 scripts must include bespoke CBOR/COSE
   helpers or pre-generated fixtures, since the runtime does not support
   Node.js libraries directly.
3. **Dual harness maintenance**: We must maintain both k6 scenarios and
   wrk2 scripts/configs, and be explicit that only k6 results are used
   for formal regression comparisons.
4. **ct_hammer divergence**: Forestrie SCRAPI semantics differ from
   Trillian's CT APIs; we can only approximate some of the workloads,
   not reuse them verbatim.

## Implementation

### Tool stack

- **k6**
  - Primary performance and load testing tool.
  - Used for scenario-based tests that:
    - Submit signed SCITT statements to canopy-api.
    - Observe ranger's log integration and read paths.
    - Combine write and read traffic to mimic CT-style usage.
  - Encodes request bodies as CBOR/COSE and parses CBOR/COSE responses
    where needed.

- **wrk2 (Go-based wrk-style tool)**
  - Secondary tool for local development and narrow benchmarks
    (single endpoint, simple payloads).
  - Used to explore raw capacity of specific routes (for example a
    canopy-api registration endpoint or a ranger read endpoint) before
    encoding those findings into k6 scenario limits.

- **ct_hammer-inspired Go helpers**
  - We will not run Trillian's `ct_hammer` directly against Forestrie.
  - Instead, we will implement a small Go helper library that mirrors
    `ct_hammer` workloads conceptually but targets SCRAPI/SCITT and
    CBOR/COSE payloads.
  - These helpers can be invoked from k6 via HTTP endpoints that trigger
    background population, or from standalone Go binaries for deeper
    log-behavior investigations.

### Directory layout (canopy)

New performance-related files in the canopy repo will live alongside the
existing tests and ADRs:

- `docs/`
  - `adr-0004-performance-and-load-testing.md` (this document).

- `perf/`
  - `k6/`
    - `canopy-api/`
      - `scenarios/`
        - `write-heavy.js` (SCRAPI submission focus).
        - `read-heavy.js` (log read and proof paths).
        - `mixed-traffic.js` (CT-style mix of submits and reads).
      - `lib/`
        - `cbor.js` (minimal CBOR encoder/decoder for k6).
        - `cose-fixtures.js` (pre-encoded COSE payloads or helpers).
  - `wrk2/`
    - `canopy-api/`
      - `README.md` (usage, example commands).
      - `scripts/` (shell helpers for common wrk2 invocations).

- `packages/apps/canopy-api/`
  - Existing SCRAPI CBOR-native API implementation.
  - May gain local-only helper endpoints used by performance harnesses,
    guarded by configuration and not exposed in production.

### Directory layout (arbor / ranger)

In the arbor repository, we will mirror the canopy layout for ranger,
with directories scoped under the service root:

- `services/ranger/`
  - `perf/`
    - `k6/`
      - `ranger/`
        - `scenarios/`
          - `append-only.js` (simulate sustained write load).
          - `monitor-reads.js` (read STH or checkpoint-like state).
          - `end-to-end.js` (submit via canopy-api, observe via ranger if
            routed through arbor test harnesses).
        - `lib/`
          - `cbor.js` (shared or duplicated minimal CBOR helpers;
            coordination with canopy is encouraged but not required by
            this ADR).
    - `wrk2/`
      - `ranger/`
        - `README.md` and example scripts for focused ranger endpoints.

### k6 usage patterns

- All k6 scripts will:
  - Accept base URLs for canopy-api and ranger via environment variables
    (for example `K6_CANOPY_BASE_URL`, `K6_RANGER_BASE_URL`).
  - Default to local developer endpoints (for example `http://127.0.0.1`
    with known ports), but accept overrides in CI.
  - Set `Content-Type` to appropriate CBOR/COSE media types and treat
    request/response bodies as binary data.
  - Export thresholds for latency and error rates; failures will cause
    non-zero exit codes so GitHub Actions runs can gate on regressions.

### wrk2 usage patterns

- wrk2 will be used:
  - From developer machines, primarily, using documented example
    commands.
  - In CI only for optional profiling jobs, not as a required gate.
- Example usage patterns (to be documented in `perf/wrk2/*/README.md`):
  - Single endpoint saturation tests on canopy-api registration routes.
  - Read-heavy sweeps on ranger checkpoints or entry retrieval.

### ct_hammer-inspired workloads

- We will derive the following patterns from Trillian's `ct_hammer` and
  adapt them to SCITT/SCRAPI:
  - **Write-heavy**: sustained submission of signed statements, varying
    size and structure, targeting canopy-api.
  - **Read-heavy**: frequent polling of log state (for example SCRAPI
    read endpoints) to mimic monitor behavior.
  - **Mixed**: combined write/read workloads at configurable ratios,
    approximating real-world log usage.
- Validation will focus on properties meaningful for SCITT:
  - End-to-end latency from submission to visibility in ranger or SCRAPI
    read endpoints.
  - Error behavior under saturation (for example, backpressure, rate
    limiting, or queue backlog indications).

### GitHub Actions integration

- Each repository (canopy and arbor) will add performance workflows
  under `.github/workflows/`:
  - `perf-canopy.yml`: runs selected k6 scenarios against a deployed
    canopy-api environment, using environment variables for base URLs and
    tokens.
  - `perf-ranger.yml`: runs ranger-focused k6 scenarios against a
    suitable arbor deployment.
- Workflows will:
  - Use an official or pinned k6 Docker image.
  - Run light, bounded-duration tests on pull requests.
  - Run heavier, longer tests on a scheduled basis (for example nightly)
    to track drift in latency and throughput.

## Alternatives Considered

### Only wrk/wrk2-style tools

We could rely solely on wrk/wrk2 (or similar Go-based tools) with
Lua or ad-hoc scripting for workloads. This was rejected because:

- Scenario composition and result analysis are weaker than in k6.
- Sharing complex multi-step CT/SCITT flows across canopy and arbor is
  more difficult.
- CI integration is more ad-hoc, and test-as-code ergonomics are lower.

### Locust, Artillery, or other frameworks

Python (Locust) and Node.js (Artillery) frameworks can also express
scenarios and run in CI. They were rejected for this use case because:

- k6 offers a simpler deployment model (single binary or container) and
  strong GitHub Actions support.
- k6's focus on arrival-rate based load, metrics, and thresholds closely
  matches our needs without introducing a full Python or Node runtime for
  performance tests.

### Direct reuse of Trillian `ct_hammer`

We considered running `ct_hammer` directly against canopy-api or ranger
by mimicking the CT HTTP API. This was rejected because:

- Forestrie implements SCITT/SCRAPI CBOR-native APIs, not the CT HTTP
  surface.
- Forcing a CT façade purely for testing would complicate the runtime
  model and confuse API consumers.
- A lightweight, SCITT-aware Go helper that borrows `ct_hammer`'s ideas
  is sufficient and keeps the primary performance testing surface in k6.

## References

- `docs/adr-0003-e2e-testing-approach.md`
- `packages/apps/canopy-api/` (SCRAPI CBOR-native worker)
- `packages/tests/canopy-api/` (Playwright e2e harness)
- `arbor` repository `services/ranger/` (Go ranger service)
