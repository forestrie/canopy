# Code conventions (Canopy)

Canonical type rule: `.cursor/rules/types-single-responsibility.mdc`.

## Types and interfaces

- One type/interface per file; kebab-case multi-word names.
- `types.ts` is re-export barrel only — no local definitions.
- Keep related constants/helpers with the primary type in the same file.

## Code ordering (within files)

1. Imports, module-level type aliases
2. Primary export (class/function) — public methods before private
3. Private methods in call-graph order (callers before callees)
4. Module-level helpers last (leaf-most last)

## Test file naming

Pattern: `{prefix}-{area}.test.ts`

Example for `SequencingQueue`:

- `sequencingqueue.test.ts`
- `sequencingqueue-enqueue.test.ts`
- `sequencingqueue-pull.test.ts`
- `sequencingqueue-fixture.ts` — shared helpers

Use `describe("{ClassName} {method}", …)` for readable output.

## Monorepo layout

- `packages/apps/*` — Worker entrypoints
- `packages/shared/*` — shared libraries
- `packages/tests/*` — test harnesses (isolated tooling)

When adding automation: package scripts in `package.json`; cross-package flows in
`taskfiles/` exposed via root Taskfile.
