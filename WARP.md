# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project overview

Canopy is a pnpm-based monorepo that implements a SCITT/SCRAPI "personality" transparency log:
- **API surface**: Cloudflare Workers-based HTTP API.
- **Frontend**: Management console and user portals (SvelteKit) hosted in this workspace.
- **Infra**: Cloudflare R2 + Queues, orchestrated via `task` and `wrangler`.

Core docs to reference:
- Root `README.md` for prerequisites, environment setup, and Cloudflare bootstrap steps.
- `Taskfile.dist.yml` for higher-level automation (test orchestration, tools checks, infra wrappers).
- `packages/tests/canopy-api/README.md` for API end-to-end (Playwright) tests.

## Tooling and environment

- **Runtime**: Node.js `>=20`, pnpm `>=8` (enforced in root `package.json`).
- **Package manager**: pnpm workspaces, configured via `pnpm-workspace.yaml`.
- **Cloudflare**: `wrangler` CLI for Worker dev/deploy; uses R2 buckets and queues.
- **Task runner**: [`task`](https://taskfile.dev) with root `Taskfile.dist.yml` including:
  - `scrapi`, `cloudflare`, `minio`, and `wrangler` taskfiles.
  - `tools:check` for validating local tooling.
  - `test` for orchestrating multi-step test runs.
- **Testing**:
  - Unit/integration: `vitest` with `@cloudflare/vitest-pool-workers` in the Worker app.
  - End-to-end: `@playwright/test` in a dedicated `@canopy/api-e2e` package.

Environment configuration:
- `.env`: non-sensitive config (committed).
- `.env.secrets`: sensitive credentials (git-ignored).
- Key variables (see `README.md` and `Taskfile.dist.yml`):
  - `CANOPY_ID`, `FOREST_PROJECT_ID`, `CLOUDFLARE_ACCOUNT_ID`.
  - Cloudflare tokens such as `R2_ADMIN`, `R2_WRITER`, `R2_READER`, `QUEUE_ADMIN`.

## Common commands

### One-time / infrequent setup

Tooling check (Node, pnpm, Wrangler, Playwright, etc.):
- `task tools:check`

Cloudflare infrastructure bootstrap (R2 buckets, queues, etc.):
- `task cloudflare:bootstrap`

Cloudflare infra status summary:
- `task cloudflare:status --summary`

Install dependencies (monorepo-wide):
- `pnpm install`

### Workspace-level commands (run from repo root)

- **Dev (all apps in parallel)**: `pnpm dev`
- **Build all packages**: `pnpm build`
- **Run all tests (workspace)**: `pnpm test`
- **Lint all packages**: `pnpm lint`
- **Format code under [packages/`**: `pnpm format`
- **Prettier check**: `pnpm check`
- **Deploy API (default env)**: `pnpm deploy`
- **Deploy API (production)**: `pnpm deploy:production`

End-to-end API tests (Playwright), via the `@canopy/api-e2e` package:
- All projects (remote-focused): `pnpm --filter @canopy/api-e2e test:e2e`
- Local dev worker: `pnpm --filter @canopy/api-e2e test:e2e:local`
- Remote deployment: `pnpm --filter @canopy/api-e2e test:e2e:remote`

Relevant E2E environment variables (see `packages/tests/canopy-api/README.md`):
- `CANOPY_E2E_API_TOKEN`, `CANOPY_E2E_BASE_URL`, `CANOPY_E2E_LOCAL_PORT`.

### API package-specific commands

Worker API app lives at `packages/apps/canopy-api` and is published as `@canopy/api`.

From the **repo root** (recommended so pnpm workspace semantics apply):
- **Dev server (Cloudflare Worker)**: `pnpm --filter @canopy/api dev`
- **Build (typecheck + dry-run deploy to `dist/`)**: `pnpm --filter @canopy/api build`
- **Typecheck only**: `pnpm --filter @canopy/api typecheck`
- **Unit/integration tests (all)**: `pnpm --filter @canopy/api test`
- **Debug tests**: `pnpm --filter @canopy/api test:debug`
- **Generate Cloudflare types**: `pnpm --filter @canopy/api cf-typegen`

Running a single Vitest file for the Worker:
- `pnpm --filter @canopy/api test -- path/to/your.test.ts`

Running a focused Playwright E2E test file:
- `pnpm --filter @canopy/api-e2e test:e2e:local -- tests/path/to/spec.spec.ts`

> Prefer running these from the repository root so pnpm can correctly resolve workspace dependencies and scripts.

## High-level architecture

### Monorepo layout

Defined in `pnpm-workspace.yaml`:
- `packages/apps/*`: Application entrypoints.
  - `packages/apps/canopy-api`: Cloudflare Worker implementing the Canopy API.
- `packages/shared/*`: Shared libraries and utilities consumed across apps and tests.
- `packages/tests/*`: Test harnesses that depend on apps but keep their runtime/tooling isolated.
- `tests/*`: Additional top-level test suites (if present).

### Canopy API (Cloudflare Worker)

Location: `packages/apps/canopy-api`.

Key characteristics (inferred from `package.json` and `tsconfig.json`):
- TypeScript Worker targeting `ES2022`, using `moduleResolution: "bundler"` and `noEmit` (builds happen via Wrangler).
- Uses `cbor-x` and `cose-js` to handle COSE/CBOR encodings relevant to SCITT/SCRAPI receipts.
- Test configuration integrates `@cloudflare/vitest-pool-workers` for Worker-like test environments.
- `tsconfig.json` includes `src/**/*` and `test/**/*`, ensuring Worker code and tests share consistent compiler settings.
- A dedicated `test/tsconfig.json` extends the main config and adds `cloudflare:test` types, plus the generated `worker-configuration.d.ts` from `wrangler types`.

Conceptually:
- **API layer**: Exposes SCRAPI-compliant endpoints over HTTP (worker routes). Requests/responses likely encode/decode COSE receipts and SCITT artifacts.
- **Storage & queueing**: Uses Cloudflare R2 (for artifact storage) and Queues (for handing off work to an external sequencer).
- **Config**: Worker behaviour is parameterized via `.env`/`.env.secrets` and Cloudflare bindings, with names derived from `CANOPY_ID` and `FOREST_PROJECT_ID`.

When modifying Worker code or tests:
- Keep `tsconfig` includes consistent so new `src/` or `test/` directories are picked up.
- If you add bindings or environment variables, ensure they are reflected both in Wrangler config and Task-based infra automation.

### End-to-end test package (`@canopy/api-e2e`)

Location: `packages/tests/canopy-api`.

Purpose (per its `README.md` and `package.json`):
- Provides Playwright API-mode tests targeting the Canopy Worker.
- Depends on `@canopy/api` via `workspace:*` but keeps build/deploy scripts for the Worker unchanged.

Structure:
- `tests/fixtures`: Shared fixtures for E2E scenarios.
- `tests/**/*.ts`: Playwright test specs that operate at the HTTP boundary.
- `playwright.config.ts`: Project definitions (`local` vs `remote`) and base URLs.

Behavioral expectations:
- "Local" tests manage a `wrangler dev` process and hit it on `CANOPY_E2E_LOCAL_PORT`.
- "Remote" tests target a deployed Worker via `CANOPY_E2E_BASE_URL`.
- Auth-related scenarios rely on `CANOPY_E2E_API_TOKEN`, and will skip or adjust behavior when a placeholder token is present.

### Task-based orchestration

Root `Taskfile.dist.yml` wires together:
- Environment loading from `.env` and `.env.secrets`.
- Shared variables (`CANOPY_ID`, `FOREST_PROJECT_ID`, `CLOUDFLARE_ACCOUNT_ID`).
- Included taskfiles under `taskfiles/` for SCRAPI, Cloudflare infra, MinIO, and Wrangler.

This Task setup sits on top of pnpm and wrangler:
- Use Task to perform multi-step flows (tool checks, infra bootstrap, aggregated tests).
- Use pnpm scripts for package-oriented operations (dev, build, unit tests, E2E tests).

When adding new automation, prefer to:
- Add package-level scripts in the relevant `package.json`.
- Wrap cross-package or infra workflows in a Taskfile under `taskfiles/` and expose them via the root `Taskfile`.
