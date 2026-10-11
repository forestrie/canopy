---
name: plan-docs
description: Canonical layout, numbering, and lifecycle for docs/adr, docs/arc, and docs/plans across Forestrie repos.
when_to_use: Creating or reorganising a plan, ADR, or ARC in a Forestrie repo, or deciding whether a plan belongs in the repo or in devdocs.
paths: ["**/plans/**", "**/docs/plans/**", "**/adr/**", "**/docs/adr/**", "**/arc/**", "**/docs/arc/**"]
user-invocable: false
---

# Plan and decision docs

Canonical layout, numbering, and lifecycle for `docs/adr/`, `docs/arc/`, and
`docs/plans/` across all Forestrie repos. This generalizes what canopy's
`.cursor/rules/docs-workflow.mdc` already does in practice — this file is now
the source; sync repo-local copies from here rather than evolving them
independently.

See [persist-plan](../../skills/persist-plan/SKILL.md) for the step-by-step skill that
applies this rule right after a plan is approved, and
[adr-format](../adr-format/SKILL.md) for the ADR document's own structure and
status vocabulary (which supersedes the vendored `grill-with-docs`
ADR-FORMAT.md).

## Layout

| Series | Location | Scope |
|--------|----------|-------|
| `docs/adr/adr-NNNN-slug.md` | implementing repo | repo-local architecture decisions |
| `docs/arc/arc-NNNN-slug.md` | implementing repo | repo-local architecture write-ups |
| `docs/plans/plan-NNNN-slug.md` | implementing repo | implementation plan scoped to this repo |
| `devdocs/plans/plan-YYMM-NN-slug.md` | [devdocs](https://github.com/forestrie/devdocs) | plan whose **Scope** spans more than one repo |
| `devdocs/adr/`, `devdocs/arc/` | devdocs | cross-repo decisions (repo keeps a stub redirect only) |

A plan's home is decided by **Scope** (below), not by which repo happens to
host the most changed files in the end.

devdocs numbers plans by **date cohort** and archives by month — see
[Numbering](#numbering) and [Archival](#archival). Its series directories hold
currently active work only; everything else lives under `devdocs/archive/`,
reached through
[archive/INDEX.md](https://github.com/forestrie/devdocs/blob/main/archive/INDEX.md).
Repo-local `docs/` keeps the sequential scheme described below.

## Required header

Every plan/ADR/ARC doc opens with:

```
**Status:** DRAFT | ACTIVE | ACCEPTED | IMPLEMENTED | COMPLETE | SUPERSEDED | RCA
**Date:** YYYY-MM-DD
**Scope:** single-repo | multi-repo — <repo>, <repo>, ...
**Related:** <Linear issue link>, <sibling-repo doc links>
```

This `Status` vocabulary is for `docs/plans/`. ADRs use their own lifecycle
(`ACCEPTED | READY | DISCUSS | REJECTED | HISTORICAL`) — see
[adr-format](../adr-format/SKILL.md#status-values).

Additional fields (`Linear epic`, `Parent PRD`, `Authority`, ...) are fine —
this is a minimum, not a ceiling; several existing plans already extend it.

- **Scope: multi-repo** lists every touched repo. If a plan starts
  single-repo and grows a second repo's worth of work, update `Scope` in
  place — don't fork a second doc just to relabel it.
- **Related** cross-repo links use full GitHub URLs
  (`https://github.com/forestrie/<repo>/blob/main/...`), the same convention
  already used in every `AGENTS.md` external-reference table — not relative
  `../` paths, which break once a repo is cloned standalone or viewed on
  GitHub from a different repo. Add the local sibling path as a
  parenthetical only when it helps a human reading the file locally, e.g.
  `(local: ../canopy/docs/adr/adr-0007-x.md)`.

## Numbering

**Repo-local `docs/`:** sequential, zero-padded to 4 digits, per series, per
location. Before assigning a number, check the highest existing `plan-NNNN`
(or `adr-NNNN` / `arc-NNNN`) under the target location **on `main`**,
including `archived/` — not just the local worktree, which may be behind.
Take max + 1.

**devdocs plans and status docs:** date cohorts — `plan-YYMM-NN-slug.md`,
allocated by `/plan-new` from the highest ordinal in the *current month* only.
Legacy `plan-NNNN` ids there are frozen; never renumber them. The
authoritative statement is the numbering blockquotes in
[devdocs plans/README.md](https://github.com/forestrie/devdocs/blob/main/plans/README.md).
devdocs ADR/ARC/OPS keep the sequential scheme.

Archiving never affects allocation: the current month's cohort always stays in
the live `plans/` directory.

Collisions still happen occasionally when two worktrees branch near
simultaneously. Do not renumber to resolve one — that breaks existing links.
Disambiguate with distinct slugs under the shared number instead (e.g.
canopy's `plan-0010-grant-workflow-and-taskfiles.md` /
`plan-0010-deploy-and-test-on-branch.md`, already established practice).
Treat this as an accepted, low-cost outcome, not a defect to engineer away.

## Forking a plan into subplans

Default to a single flat file — most plans never need more.

Promote to a directory only when the plan decomposes into two or more
workstreams independent enough to land as separate PRs/branches:

```
docs/plans/plan-NNNN-slug/
  README.md            # index: subplan table, status, links to archived siblings
  overview.md          # original plan content — outcomes, decisions, status
  subplan-01-slug.md
  subplan-02-slug.md
```

This is canopy's existing `plan-0004-log-bootstraping/` pattern, promoted to
the fleet standard. Subplans are numbered `01`, `02`, ... within the parent —
a separate, nested counter from the fleet-wide `plan-NNNN` sequence. Archive
completed/superseded subplans into `docs/plans/archived/plan-NNNN-slug/`
alongside the parent's archived siblings, and update the parent `README.md`
table to point there (see canopy's `archived/README.md`).

A subplan inherits its parent's `Scope` unless the subplan's own header
narrows it — a multi-repo parent can still have a subplan that only touches
one of the repos.

## Archival

**Repo-local `docs/`:** move a plan to `docs/plans/archived/` once
IMPLEMENTED/COMPLETE/SUPERSEDED and no longer live reading for agents.
Maintain the location's `docs/plans/README.md` as a status-table index;
agents read the index first and do not bulk-read `archived/` unless a task
names a specific plan id.

**devdocs:** archiving runs as a monthly wave, not per-document. Everything
created before the current month moves to `devdocs/archive/<YYMM>/<series>/`
unless it is currently active work — active plans, the decisions they cite,
recent non-superseded decisions and runbooks, and living product docs stay.
Multi-part plan directories move whole. Tooling and the disposition rules live
in
[devdocs tools/archive/](https://github.com/forestrie/devdocs/blob/main/tools/archive/README.md).

Agents reach archived devdocs material only through
`archive/INDEX.md` → `archive/INDEX-<theme>.md` → the specific document, and
never by browsing or globbing `archive/`.

## Relationship to branches and worktrees — deliberately independent

Branch: `<user>/for-<issue-no>-<slug>` — worktree:
`<repo>-for-<issue-no>-<slug>` (see [branch-naming](../branch-naming/SKILL.md)). Plan
docs share the `for-<issue>` token in their slug **when a Linear issue drives
the work**, but plan identity (the `plan-NNNN` sequence number) is a separate
counter from the issue number, and a plan's filename is never required to
equal a branch or worktree name. Keep these independent:

- One Linear issue can produce several branches (`branch-naming.md`'s
  parent-issue rule) — a single plan document already covers that whole
  slice; forcing 1:1 plan-to-branch naming would fragment one plan into
  several, or collide.
- A multi-repo plan has no single worktree to bind to by construction — it
  may end up backing zero, one, or several worktrees (one per affected repo)
  over its life.
- Plans are written and read before a branch exists (design phase) and often
  outlive the branch that first implemented them (follow-up remediation,
  retrospectives) — tying the doc's name to a specific branch would force a
  rename, or leave an orphaned reference, the moment that branch merges or a
  new one picks up the thread.

Reference the plan from the branch/PR by link (Linear issue description, PR
body, commit message) — not by making the branch name and plan filename
identical.
