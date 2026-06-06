# AGENTS.md

Canopy: SCITT/SCRAPI transparency log (pnpm monorepo, Cloudflare Workers).
Human setup: [README.md](README.md). Platform glossary:
[devdocs/glossary.md](../devdocs/glossary.md).

**Plans:** After a Cursor-built plan exists, persist under `docs/plans/`.
Full rules: `.cursor/rules/docs-workflow.mdc`.

## Services (ports)

| Package | Port | Purpose |
|---------|------|---------|
| `@canopy/api` | 8789 | Main SCRAPI HTTP API |
| `@canopy/forestrie-ingress` | 8791 | SequencingQueue Durable Object host |
| `@canopy/x402-settlement` | 8792 | x402 payment settlement worker |
| `@canopy/delegation-coordinator` | 8793 | Delegation coordinator (Phase 3 APIs, sharded DO) |

## Commands

- **Install**: `pnpm install`
- **Unit tests**: `pnpm -r test`
- **Format / typecheck**: `pnpm check`; `pnpm -r --filter './packages/**' typecheck`
- **Dev API**: `pnpm --filter @canopy/api dev` (also start `@canopy/forestrie-ingress` for cross-worker routes)
- **E2E**: `task test:e2e` (Doppler project **canopy**). Details: [docs/agents/e2e.md](docs/agents/e2e.md)
- **Build**: `pnpm -r build`

## Gotchas (critical)

- No package `lint` script — use `pnpm check` + typecheck.
- API responses are **CBOR** except `/api/health` and `/.well-known/scitt-configuration`.
- `canopy-api` alone returns **500** on routes that call forestrie-ingress DOs; start both workers (second needs `--inspector-port 9230`).
- Playwright **system** tests need deployed stack + forestrie-ingress; no skip env.
- Local secrets: `packages/apps/canopy-api/.dev.vars` (not repo-root `.env`).
- SequencingQueue: see [docs/agents/gotchas.md](docs/agents/gotchas.md) for reset and `dead_letters` fix.

## Documentation map

- **Agent index**: [docs/agents/README.md](docs/agents/README.md)
- **Active plans**: [docs/plans/README.md](docs/plans/README.md) (skip `archived/` unless cited)
- **Platform design**: [../devdocs/](../devdocs/) — architecture, glossary, arc/, adr/
- **Grant verification**: [devdocs ARC-0019](../devdocs/arc/arc-0019-grant-verification-model.md) + [canopy implementation](docs/arc/canopy-grant-verification-implementation.md)
- **Extended commands / conventions**: [docs/agents/commands.md](docs/agents/commands.md), [conventions.md](docs/agents/conventions.md)
