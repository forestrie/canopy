---
name: persist-plan
description: Persist an approved plan (plan-mode output, a Cursor plan file, or an ad hoc design discussion) as a canonical Forestrie plan document.
when_to_use: Immediately after the user approves a plan, before implementation begins.
argument-hint: "[target repo]"
---

# persist-plan

Persist an approved plan — Claude Code plan-mode output, a Cursor
`.cursor/plans/*.plan.md`, or an ad hoc design discussion — as a canonical
Forestrie plan document. Read [plan-docs](../../rules/plan-docs/SKILL.md) first for
the full format spec; this skill is the step-by-step "do it" version.

Run this immediately after the user approves a plan, before any
implementation begins.


Arguments: `$ARGUMENTS`

## 1. Determine scope and location

- List every Forestrie repo the plan will change.
- One repo → `<repo>/docs/plans/`.
- Two or more → `devdocs/plans/` (a multi-repo plan regardless of which repo
  ends up with the most changed files).

## 2. Assign the number

- Check `main` for the target location (fetch/pull if the local worktree
  might be behind).
- Find the highest `plan-NNNN` under `docs/plans/` **and**
  `docs/plans/archived/`.
- Use max + 1, zero-padded to 4 digits.
- If a collision surfaces later (two worktrees branched close together),
  don't renumber — disambiguate with a distinct slug under the shared number
  instead (see [plan-docs](../../rules/plan-docs/SKILL.md#numbering)).

## 3. Write the file

`docs/plans/plan-NNNN-<slug>.md`, header per
[plan-docs](../../rules/plan-docs/SKILL.md#required-header):

```
# Plan NNNN — <Title>

**Status:** DRAFT
**Date:** <today, YYYY-MM-DD>
**Scope:** single-repo | multi-repo — <repos>
**Related:** <Linear issue>, <sibling-repo links as GitHub URLs>
```

Body: outcomes, context, decisions, open questions — whatever the approved
plan actually contains. This is a persistence step, not a rewrite; don't
invent structure beyond what the plan carries.

Drop harness-only scaffolding (Cursor's `.plan.md` metadata, a plan-mode
preamble) — only the substance survives into the committed doc.

## 4. Referencing siblings

If a single-repo plan needs to point at another repo's doc or code, link the
full GitHub URL, not a relative path — add the local sibling path as a
parenthetical only for the human reading it locally:

```
See [canopy ADR-0007](https://github.com/forestrie/canopy/blob/main/docs/adr/adr-0007-x.md)
(local: `../canopy/docs/adr/adr-0007-x.md`).
```

## 5. Decide if this forks into subplans

Stays flat unless the plan already decomposes into two or more independently
landable workstreams. If it does, promote per
[plan-docs#forking-a-plan-into-subplans](../../rules/plan-docs/SKILL.md#forking-a-plan-into-subplans):
create `plan-NNNN-slug/{README.md, overview.md, subplan-01-*.md, ...}`,
moving the just-written content into `overview.md`.

## 6. Update the index

Add or update a row in the target location's `docs/plans/README.md` status
table.

## 7. Handoff

Continue with [plan-with-linear](../plan-with-linear/SKILL.md) step 5
(branch/worktree creation). The plan doc's filename does not need to match
the branch name — link them via the Linear issue instead (see
[plan-docs#relationship-to-branches-and-worktrees](../../rules/plan-docs/SKILL.md#relationship-to-branches-and-worktrees--deliberately-independent)).

In Claude Code, [require-worktree](../../../harness/claude-code.md#hooks) is a
`PreToolUse` hook on `ExitPlanMode` that blocks execution from a repo's home
clone and asks for a worktree — it fires before this skill's persistence
step matters, not instead of it.
