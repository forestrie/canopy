---
name: adr-format
description: ADR document structure and status vocabulary for Forestrie. Supersedes the vendored grill-with-docs ADR-FORMAT.md.
when_to_use: Writing, reviewing, or restructuring an ADR in any Forestrie repo, or when grill-with-docs points at its own ADR-FORMAT.md.
paths: ["**/adr/**", "**/docs/adr/**"]
user-invocable: false
---

# ADR format

**Supersedes** the vendored
[matt-skills grill-with-docs ADR-FORMAT.md](../../../vendored/matt-skills/skills/engineering/grill-with-docs/ADR-FORMAT.md)
for all Forestrie work. When `grill-with-docs` says "use the format in
ADR-FORMAT.md," use this file instead — do not edit the vendored file in
place (see [vendored/README.md](../../../vendored/README.md)). This is the
format already practiced by every ADR in devdocs, canopy, arbor, univocity,
univocity-tools, mandate, forest-1, and system-testing; the vendored file's
own bare `NNNN-slug.md` / prose-only convention is what `matt-skills` uses
for its own repo, not what Forestrie uses.

Location and numbering are covered by
[plan-docs](../plan-docs/SKILL.md#layout) and
[plan-docs.md#numbering](../plan-docs/SKILL.md#numbering) — this file is about the
ADR document's own structure.

## When to write one at all

Keep `grill-with-docs`' gate — offer an ADR only when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder "why did they
   do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and
   one was picked for specific reasons.

If any is missing, skip it — a comment or a `CONTEXT.md` note is enough.

## File naming

- Standard: `adr-{NUMBER}-{short-name}.md`
- Security-critical: `adr-{NUMBER}-sec-{short-name}.md`

Zero-padded to 4 digits; short names lowercase with hyphens. (Not
`matt-skills`' bare `{NUMBER}-{short-name}.md` — the `adr-` prefix
disambiguates from `arc-`/`plan-` files sharing the same `docs/` tree.)

## Line length

Soft-wrap prose at ~79 characters; break at the first punctuation mark
rather than mid-word. Keeps diffs small and readable in a standard terminal.

## Document structure

**Header:**

- **Status** — see values below
- **Date** — created or last-updated
- **Categories** — relevant areas, e.g. `[WALLET, PAYMENTS, UX, SECURITY]`

**Sections:**

- **Context** — why this decision is needed, what problem it solves
- **Decision** — the chosen approach and brief rationale
- **Consequences** — positive and negative impacts, trade-offs
- **Implementation** — how to implement it, if applicable
- **Alternatives Considered** — other options evaluated and why they were
  rejected
- **References** — links to related code, docs, or other ADRs

Scale rigor to reversibility, not to a fixed template: an easily-reversible,
low-stakes ADR can keep Consequences/Alternatives to a sentence each and
skip Implementation entirely. A genuinely hard-to-reverse one earns full
treatment of every section. Don't pad a light decision to fill sections that
don't apply — that's the one thing worth keeping from the vendored format's
minimalism.

## Status values

| Status | Meaning |
|--------|---------|
| **ACCEPTED** | Stakeholders bought in; applies to current production engineering, implemented or being implemented. Weight of deliberation should scale with reversibility — light touch for easily-reversible choices. |
| **READY** | Engineering is willing to proceed at risk; sound enough to implement, may still evolve. Don't sink significant effort ahead of READY. |
| **DISCUSS** | Actively being considered/debated. Prototypes fine if they inform the decision; no significant investment before READY. |
| **REJECTED** | Rejected outright. Kept on record so the approach isn't re-litigated from scratch. |
| **HISTORICAL** | No longer relevant — superseded, feature removed, or context changed. Kept for reference. |

## Cross-repo ADRs

An ADR whose decision spans more than one repo's `Scope` (per
[plan-docs](../plan-docs/SKILL.md#required-header)) belongs in
[devdocs](https://github.com/forestrie/devdocs)`/adr/`, not the implementing
repo — the repo keeps a stub redirect only.
