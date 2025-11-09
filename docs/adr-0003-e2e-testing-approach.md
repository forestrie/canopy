# ADR-0003: End-to-End Testing Approach for Canopy API

**Status**: READY
**Date**: 2025-11-09
**Categories**: [TESTING, API]

## Context

Current API tests in `packages/apps/canopy-api/test/api.test.ts` execute
inside Vitest with `@cloudflare/vitest-pool-workers`. The suite drives
`worker.fetch` directly, exercising logic against Miniflare with a
locally persisted R2 bucket. This provides fast coverage but omits the
true HTTP surface of the deployed Worker.

We need end-to-end coverage that can target both:
- The local developer loop, by standing up `wrangler dev`
- The deployed development Worker environment on Cloudflare

Requirements communicated by the team include:
- Remote URL is publicly reachable and shareable across CI jobs
- A single API token will be injected via `process.env` for authorized
  scenarios, while the suite must also validate unauthorized behavior
- Tests may mutate the remote deployment for now, with future plans for
  user-specific sandboxes and data reset automation
- CI execution should run after successful builds or on manual trigger,
  with future automation tied to Cloudflare build messages
- Local developers are comfortable depending on `wrangler dev`
- Only HTTP API behavior needs to be covered initially, not R2 or queue
  side effects

The decision must balance developer ergonomics, multi-environment
support, tooling duplication, and the effort required to extend the
existing Vitest harness.

## Decision

**Adopt Playwright Test (API mode) for end-to-end coverage while keeping
Vitest for unit and worker-level integration tests.**

Playwright will become the dedicated e2e harness, providing per-project
configuration for local (`wrangler dev`) and remote (Cloudflare dev)
targets, shared fixtures for API tokens, and first-class reporting. The
existing Vitest suite remains in place for fast, deterministic coverage
inside Miniflare.

## Consequences

### Positive

1. **Multi-environment parity**: Playwright projects cleanly separate
   local and remote URLs with shared assertions.
2. **Process orchestration**: `webServer` support can auto-start
   `wrangler dev`, ensuring developers and CI do not manage ports
   manually.
3. **Stable HTTP client**: Playwright's `request` fixture uses the same
   stack across environments, reducing divergent helper code.
4. **Auth handling**: Central fixtures can inject API tokens per
   project, simplifying unauthorized test variants.
5. **Artifacts and reporting**: Built-in traces, retries, and reporting
   simplify debugging, especially for remote failures.
6. **Future scaling**: Additional projects (per-developer sandboxes, new
   environments) become configuration-only additions.

### Negative

1. **New test runner**: Adds Playwright to the toolchain alongside
   Vitest, increasing dependency footprint.
2. **Onboarding cost**: Contributors must learn Playwright syntax and
   CLI, and adjust workflows accordingly.
3. **Parallel coordination**: Requires care to prevent Playwright and
   Vitest suites from racing against the same remote state when run
   concurrently.
4. **CI runtime**: Playwright introduces browser binaries, though API
   mode can avoid installing full browsers if the `--api` bundle is used
   sparingly.

## Implementation

1. **Scaffold Playwright package**:
   - Create `packages/tests/canopy-api` with `@playwright/test`, `playwright.config.ts`, and register it in `pnpm-workspace.yaml`.
   - Configure two projects:
     - `local`: baseURL `http://127.0.0.1:8789`, `webServer` spawning
       `pnpm --filter @canopy/api dev -- --test-scheduled`.
     - `remote`: baseURL set via `CANOPY_E2E_BASE_URL` (defaults to
       Cloudflare dev deployment).
2. **Secret management**:
   - Expect `CANOPY_E2E_API_TOKEN` in the environment.
   - Provide a fixture that injects the token header when present and
     exposes helpers for authorized vs unauthorized requests.
3. **Author tests**:
   - Move high-level API scenarios from `packages/apps/canopy-api/test/api.test.ts` into
     `packages/tests/canopy-api/tests/api.spec.ts`, using Playwright's `test` + `expect`.
   - Keep Vitest tests for worker-level coverage (e.g., direct
     `worker.fetch`) and add a note in `api.test.ts` pointing to the new
     e2e suite.
4. **Scripts**:
   - Add repo scripts: `pnpm run test:e2e(:local|:remote)` delegating to the new package, while leaving the worker's `build`/`deploy` commands untouched.
   - Document required env vars (`CANOPY_E2E_API_TOKEN`,
     `CANOPY_E2E_BASE_URL`) in the e2e package README.
5. **CI integration**:
   - Extend pipelines to install Playwright (API-only) and execute
     `pnpm --filter @canopy/api-e2e test:e2e` after build success.
   - Expose manual trigger workflow that accepts environment overrides.
6. **Guardrails**:
   - For now, allow tests to mutate state; add cleanup steps where easy.
   - Track follow-up work for seeded fixtures and sandboxed environments
     once infrastructure supports them.

## Alternatives Considered

### Extend Vitest + Miniflare

- Modify existing tests to detect environment mode and swap `worker.fetch`
  for actual `fetch` calls.
- Pros: No new runner; reuse current assertions.
- Cons: Requires bespoke harness to manage remote vs local URLs, manual
  orchestration of `wrangler dev`, and less robust reporting. Mixing
  Miniflare globals with Node `fetch` increases complexity, and scaling
  to future environments would demand additional custom plumbing.

## References

- `packages/apps/canopy-api/test/api.test.ts`
- `packages/apps/canopy-api/vitest.config.ts`

