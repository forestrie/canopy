# Canopy agent documentation index

On-demand guides for AI agents. Always-loaded bootstrap: [AGENTS.md](../../AGENTS.md).

## Read when

| Task | Start here |
|------|------------|
| Grant auth, register-grant, receipts | [devdocs ARC-0019](../../devdocs/arc/arc-0019-grant-verification-model.md), [canopy implementation](../arc/canopy-grant-verification-implementation.md), [grants.md](../grants.md) |
| Statement COSE / signer binding | [arc-statement-cose-encoding.md](../arc/arc-statement-cose-encoding.md), [arc-grant-statement-signer-binding.md](../arc/arc-grant-statement-signer-binding.md) |
| E2E / Playwright | [e2e.md](e2e.md), [packages/tests/canopy-api/README.md](../../packages/tests/canopy-api/README.md) |
| Domain language | [domain.md](domain.md) → [devdocs glossary](../../devdocs/glossary.md) |
| Commands / task | [commands.md](commands.md) |
| Code style | [conventions.md](conventions.md), `.cursor/rules/types-single-responsibility.mdc` |
| Operational gotchas | [gotchas.md](gotchas.md) |
| Implementation plans | [plans/README.md](../plans/README.md) — do not bulk-read `archived/` |
| Platform architecture | [devdocs AGENTS.md](../../devdocs/AGENTS.md), [architecture.md](../../devdocs/architecture.md) |
| SCRAPI API reference | [docs/api/](../api/) |
| Hackathon / demo walkthrough | [scitt-hackathon.md](../demo/scitt-hackathon.md) |

## Repo-local vs platform docs

- **Platform** ADRs, ARCs, glossary, ops: [devdocs](../../devdocs/)
- **Canopy** plans, API docs, worker implementation maps: this repo `docs/`
