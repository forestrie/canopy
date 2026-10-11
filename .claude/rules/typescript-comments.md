---
name: typescript-comments
description: "TypeScript comment conventions for Forestrie: signpost how local code fits the multi-repo platform and link the owning doc rather than duplicating platform prose."
when_to_use: Writing or reviewing TypeScript in canopy Workers, mandate UI, or univocity-tools CLIs.
paths: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]
user-invocable: false
---

# TypeScript comments

**Scope:** TypeScript source in Forestrie repos (canopy Workers, mandate UI,
univocity-tools CLIs).

Forestrie runs a **multi-repo platform**. The "why" of local code often depends
on sibling services, Go microservices, or on-chain contracts. Comments must make
that context reachable without duplicating platform docs.

## Principles

1. **Signpost, don't silo.** At file and function level, state how the local
   code fits the wider picture: assumptions about other components, contracts
   honoured, and where to read more.
2. **Brief with a pointer.** One or two sentences plus a reference is enough in
   most cases.
3. **Explain purpose, not syntax.** Comments describe the **problem** or **role**
   so readers can cross-check the implementation.
4. **Non-obvious details only at line level.** Line comments are for surprising
   constraints, not narrating control flow.
5. **Full coverage of public surfaces.** Every exported **function**, **method**,
   and **type** should have a comment describing its role. Use `@param` /
   `@returns` where they add contract information.

## Cross-repo signposts

Prefer stable **GitHub blob links** to forestrie repos:

| Target | Link form |
|--------|-----------|
| Same repo doc | `https://github.com/forestrie/<repo>/blob/main/docs/…` |
| Platform ARC/ADR | [devdocs/arc/](https://github.com/forestrie/devdocs/tree/main/arc), [devdocs/adr/](https://github.com/forestrie/devdocs/tree/main/adr) |
| Glossary | [devdocs/glossary.md](https://github.com/forestrie/devdocs/blob/main/glossary.md) |
| Canopy | [canopy/docs/](https://github.com/forestrie/canopy/tree/main/docs) |
| Arbor / Go deps | [go-merklelog](https://github.com/forestrie/go-merklelog), [go-univocity](https://github.com/forestrie/go-univocity), [go-sigv4](https://github.com/forestrie/go-sigv4) |
| MMR COSE profile | [draft-bryce-cose-receipts-mmr-profile](https://github.com/robinbryce/draft-bryce-cose-receipts-mmr-profile) |
| Common arc-context | `arc-*` glossary skills ([forestrie-agents/arc-context/](https://github.com/forestrie/forestrie-agents/tree/main/arc-context)) |

Within a comment, name the **remote component**, the **contract** (SCRAPI route,
queue message, grant shape, on-chain call), and what this code **assumes** vs
**guarantees**. Same-repo implementation detail may use `{@link symbol}` in
addition to a doc link when the symbol is the canonical local entry point.

## What to write at each level

| Level | Comment answers |
|-------|-----------------|
| **File** | What problem this module solves in the distributed flow; primary upstream/downstream dependencies. |
| **Type** | What domain object or boundary this type represents; invariants callers must respect. |
| **Function / method** | What operation this performs in the flow; preconditions, side effects, and error semantics worth knowing. |
| **Stanza** (non-trivial block) | Why this branch or block exists when the surrounding function comment is not enough. |
| **Line** | Only non-obvious mechanics (wire format quirks, platform limits, ordering constraints). |

Example (canopy) — good file-level signpost:

```typescript
/**
 * Grant auth primitives. Two distinct artifacts flow through these helpers —
 * see [grants.md §10](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model).
 * {@link grantAuthorize} verifies from the embedded SCITT receipt only; it does
 * not call the SequencingQueue DO.
 */
```

Bad — restates syntax:

```typescript
// Loop over grants and push each one into the array
for (const grant of grants) {
  result.push(grant);
}
```

Good — non-obvious constraint:

```typescript
// SCRAPI register-grant bodies are CBOR; parent evidence is capped because the
// route is unauthenticated — see MAX_PARENT_GRANT_BODY_SIZE.
```

## Options and config buckets

Describe **options**, **env bindings**, and **config objects** at the
**innermost function that reads each field** — not repeated at every callsite.

- On that function, document **only the fields it uses directly**.
- Each documented field: name, meaning, valid values or source, and behaviour
  when missing or invalid.
- Parent callers may mention that options exist; defer field-level detail to
  the consumer.

```typescript
/**
 * @param options.enforceInclusion — when true, require a verifiable MMR inclusion
 *   proof in the grant receipt; false only in pool-test mode with incomplete
 *   bindings (see forestrie-ingress SequencingQueue configuration).
 */
```

## JSDoc conventions

- Use `/** … */` for files (module banner), types, functions, methods, and
  non-exported constants that encode policy limits.
- Use `@param`, `@returns`, `@throws` sparingly — only when they add contract
  information not obvious from types.
- Use `{@link Name}` for local symbols; markdown links for docs and other repos.
- Keep line length readable; wrap prose naturally (soft wrap ~79 chars is fine).

## When editing

- Cross-repo behaviour change → add or update signpost comments in the same change.
- Do not copy ARC/ADR prose into source — link and state the local obligation.
- If a function or type lacks a comment, add one before merging.
