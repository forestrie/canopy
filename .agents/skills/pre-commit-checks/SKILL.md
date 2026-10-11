---
name: pre-commit-checks
description: Run the quality gates CI enforces for this repo type (fmt, lint, typecheck, tests) before committing Forestrie work.
when_to_use: The user is about to commit or push, says "pre-commit", "run the checks", or asks whether the change is ready.
---

# pre-commit-checks

Run quality gates before committing. Match what CI enforces for the repo type.

## Detect repo type

From repository root, use the first matching row:

| Signal | Repo type | Checks |
|--------|-----------|--------|
| `foundry.toml` | univocity | `forge fmt --check`, `forge build`, scoped `forge test` |
| `pnpm-workspace.yaml` + `@canopy/` | canopy | `pnpm check`; `pnpm -r --filter './packages/**' typecheck`; `pnpm -r test` |
| `pnpm-workspace.yaml` + `@mandate/` | mandate | `pnpm -r test` per package |
| `go.mod` under `services/` | arbor | `go test ./...` in changed service |
| `bun.lock` + `apps/` citty | univocity-tools | `bun run check`; `bun run typecheck`; `bun test`; `bun run check:cli`; `bun run check:subprocess` |
| `*.tf` under `infra/` | forest-1 | `terraform fmt -check`; `terraform validate` (when configured) |
| Kustomize under `clusters/` | arbor-flux | `kustomize build` on changed paths |
| Markdown-only | devdocs, product, forestrie-agents | Link check if available; no forced build |

## Generic checklist

1. Format / lint passes
2. Typecheck passes (if applicable)
3. Tests for changed behaviour pass
4. No secrets or `.env` files staged
5. Commit message follows [commit-conventions](../../rules/commit-conventions/SKILL.md)

## Do not

- Skip hooks (`--no-verify`) unless the user explicitly requests it
- Commit without user request when acting as an agent
