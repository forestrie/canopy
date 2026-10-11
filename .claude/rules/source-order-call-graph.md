---
name: source-order-call-graph
description: Order function definitions in a source file by call-graph topology, entry points first and callees before callers when reading downward.
when_to_use: Adding functions to, or reorganising, a TypeScript or JavaScript source file in canopy, mandate, or univocity-tools.
paths: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts", "**/*.cts"]
user-invocable: false
---

# Source file order: call-graph topology

**Scope:** TypeScript and JavaScript source files (canopy, mandate, univocity-tools).

When adding or reorganising code in a source file, **order function (and method)
definitions so they follow the topological sort of the call graph**, with **main
entry points towards the top** of the file.

- **Entry points** (exported or public API, or the main flow) should appear
  **first** (after imports, constants, and shared types).
- **Helpers** should follow in **topological order**: define a function
  **before** the functions that call it (callees before callers when reading
  downward).

This makes the file read top-down as "what this module does first, then the
details." Do **not** apply this rule retrospectively to existing files unless
the user explicitly asks to reorder a file.
