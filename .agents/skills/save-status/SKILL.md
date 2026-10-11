---
name: save-status
description: Checkpoint Forestrie work in flight into a status doc a fresh agent session can resume from, with FOR issue, worktree, and plan refs.
when_to_use: The user says "save status", "checkpoint this", or is ending a session another will pick up.
argument-hint: "[FOR-123 | plan ref | free-text hints]"
---

# save-status — checkpoint work in flight

Condense the current session into a `status-*.md` document that is the ideal
starting point for a **fresh agent session**: combined with the prevailing
context hooks, reading the status doc should be enough context to continue the
work it describes. Layout, numbering, header, and location follow
[plan-docs](../../rules/plan-docs/SKILL.md) — status docs are a first-class series
alongside `plans/`, `adr/`, `arc/`, not a separate scheme.


Arguments: `$ARGUMENTS`

## Usage

```
/save-status [context hints...]
```

- `context hints` — optional; any of:
  - a Linear issue id (e.g. `FOR-314`)
  - a plan title, or a plan / ADR / ARC document reference
- With no hints, establish context from the **entire current session**:
  condense the chat, and pick up references to Linear `FOR-*` issues, the
  active worktree and branch (`<user>/for-<issue>-<slug>`, see
  [branch-naming](../../rules/branch-naming/SKILL.md)), and relevant plan / ADR / ARC
  docs. Cross-check against recently changed plan docs in both plan roots:
  repo `docs/plans/` and [devdocs](https://github.com/forestrie/devdocs)
  `devdocs/plans/`.

## What the agent does

1. **Establish the workstream** from the hints (or the session, as above).
   Note the `arc-*` glossary skill(s) the work touches
   (canopy / arbor / univocity / infra / mandate / tools) so the next agent
   loads the right domain terms.

2. **Prefer update-in-place.** Scan the status root for an existing doc
   covering the same workstream (match on `FOR-*` id, plan ref, or slug) and
   update it rather than creating a sibling. Each status doc tracks **one
   currently-active workstream** across repeated `/save-status` calls.

3. **Otherwise create** a new doc. Home is decided by **Scope**, exactly as
   for plans (see [plan-docs](../../rules/plan-docs/SKILL.md#layout)) — not by which
   repo holds the most changed files:
   - **single-repo** → implementing repo's `docs/status/`
   - **multi-repo / platform** → devdocs `devdocs/status/`

   **Numbering** follows the fleet rule — sequential, zero-padded 4 digits,
   per series per location (see
   [plan-docs](../../rules/plan-docs/SKILL.md#numbering)): check the highest existing
   `status-NNNN` under the target location **on `main`** (including
   `archived/`), take max + 1. Do **not** hand-pick against the local
   worktree, which may be behind. When the workstream is a specific Linear
   issue, put the id in the slug:

   ```
   docs/status/status-0007-for-314-checkpoint-publisher.md
   ```

   Near-simultaneous branches occasionally collide on a number — disambiguate
   with a distinct slug under the shared number rather than renumbering (which
   breaks links); this is accepted practice, not a defect.

## Document content

Open with the standard plan/ADR/ARC header (see
[plan-docs](../../rules/plan-docs/SKILL.md#required-header)) — status docs use the
`docs/plans/` status vocabulary, normally `ACTIVE` while work is in flight:

```
**Status:** ACTIVE
**Date:** YYYY-MM-DD
**Scope:** single-repo | multi-repo — <repo>, <repo>, ...
**Related:** <Linear FOR-* link>, <sibling-repo doc links>
```

Then a brief overview of the work in hand, followed by:

- **Status** — what is completed
- **Notables** — design choices or implementation details discovered during
  implementation
- **Next steps** — the logical next steps
- **Blockers** — anything blocking, such as dependencies on other tasks

### Linking

Make every reference clickable (see the fleet clickable-references convention),
and match plan-docs' link rule so refs survive a standalone clone:

- **Cross-repo** links use full SHA-pinned GitHub URLs
  (`https://github.com/forestrie/<repo>/blob/<sha>/...`), never relative `../`
  paths — those break once a repo is cloned standalone or viewed on GitHub
  from another repo. Add a `(local: ../<repo>/...)` parenthetical only when it
  helps a human reading the file on disk.
- **Same-repo** references (to plans/ADRs/ARCs in this repo) use relative
  links.
- **Linear** issues by `FOR-*` id, linked to the issue.

On update, refresh the sections in place and keep the header `Related` current
rather than appending a running log. Archive a completed status doc into
`docs/status/archived/` once its workstream lands (mirror
[plan-docs archival](../../rules/plan-docs/SKILL.md#archival)).
