# Commands (Canopy)

Run from repo root unless noted.

## Setup

- `task tools:check` — validate Node, pnpm, wrangler, Playwright
- `task cloudflare:bootstrap` — R2 buckets, queues
- `pnpm install`

## Workspace

- `pnpm dev` — all apps in parallel
- `pnpm -r test` — all unit tests
- `pnpm check` — Prettier
- `pnpm -r --filter './packages/**' typecheck`
- `pnpm -r build`

## @canopy/api

- `pnpm --filter @canopy/api dev`
- `pnpm --filter @canopy/api test`
- `pnpm --filter @canopy/api test -- path/to/file.test.ts`
- `pnpm --filter @canopy/api build`
- `pnpm --filter @canopy/api cf-typegen`

## @canopy/forestrie-ingress

- `pnpm --filter @canopy/forestrie-ingress dev`
- Second terminal with different inspector port if api also running

## E2E

- `task test:e2e:preflight`
- `task test:e2e` (Doppler)
- `doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e`
- Single spec: append path or `--grep`

## Doppler

- `doppler run --project canopy --config dev -- task <name>`
- No repo-root `.env` for secrets

## Deploy

- `pnpm deploy` / `pnpm deploy:production` (see package scripts)

See [Taskfile.dist.yml](../../Taskfile.dist.yml) for SCRAPI, cloudflare, wrangler tasks.
