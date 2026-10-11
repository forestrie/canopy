---
name: types-single-responsibility
description: "No monolithic types.ts files: one main type or interface per file, with types.ts reserved as a re-export barrel only."
when_to_use: Adding or moving a TypeScript type or interface, or seeing a growing types.ts, in canopy, mandate, or univocity-tools.
paths: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]
user-invocable: false
---

# Types and single responsibility

**Scope:** TypeScript monorepos (canopy, mandate, univocity-tools) and similar.

Do **not** use monolithic `types.ts`-style files.

## Rule

- Put each **type** or **interface** in a **single-responsibility file** (one
  main type/interface per file).
- Include **closely related** constants or helper types in the same file.
- Use **`types.ts`** only as a **consumer convenience re-export**: re-export
  from single-responsibility modules; no local type definitions in the barrel.

## File naming

- Name the file after the primary type or domain (e.g. `parsed-receipt.ts`,
  `grant-result.ts`).
- Prefer kebab-case for multi-word names.

## Imports

- Prefer importing from the concrete module when the dependency is direct; use
  the barrel for consumers that need several types.

## Other languages

- **Go (arbor):** one primary exported type per file — see repo
  `.cursor/rules/types-single-responsibility.mdc`.
- **Solidity (univocity):** one library per file under `src/<module>/lib/` —
  see univocity AGENTS.md.
