# Review changes (Graphite-aware, design-invariant focused)

Thoroughly review **canopy** work in progress with the mindset of a senior
distributed systems engineer with applied cryptography and blockchain
experience. Produce findings, a remediation **implementation plan**, and
Linear follow-ups.

Run all git/gt/gh commands from the **canopy repository root**
(`git rev-parse --show-toplevel` must be this repo).

Optional arguments (pass through if given):

- Fixed point: branch, tag, commit, or `main` (default: stack-aware — step 2)
- Linear epic/issue id(s): e.g. `FOR-166`
- Plan path: e.g. `docs/plans/plan-0039-*.md`
- Scope override: `single-branch`, `full-stack`, or `cross-repo`

---

## 1. Establish context

### 1.1 Canopy standards (link, do not restate)

Read selectively before reviewing the diff:

| Source | When |
| ------ | ---- |
| [AGENTS.md](../../AGENTS.md) | Always — services, commands, gotchas |
| [docs/agents/README.md](../../docs/agents/README.md) | Route to topic guides |
| [docs/agents/conventions.md](../../docs/agents/conventions.md) | Code style |
| [docs/agents/gotchas.md](../../docs/agents/gotchas.md) | Workers, DOs, e2e traps |
| [docs/agents/e2e.md](../../docs/agents/e2e.md) | Playwright tiers |
| `.cursor/rules/` | commit, types-single-responsibility, docs-workflow, e2e-local-doppler, typescript-comments |
| [devdocs/glossary.md](../../devdocs/glossary.md) | Domain language |
| `~/.cursor/skills/tdd/SKILL.md` | Testability, coverage, mocking |

**CI already gates:** `pnpm check`, typecheck — flag only gaps CI misses.

**Canopy packages in scope:** `@canopy/api`, `@canopy/forestrie-ingress`,
`@canopy/x402-settlement`, `@canopy/delegation-coordinator`, shared libs,
`packages/tests/canopy-api`.

### 1.2 Design invariants (read on demand)

Select a **tight** subset from touched paths. Start at indexes; do not bulk-read
archived plans.

**Platform indexes**

| Index | Path |
| ----- | ---- |
| Platform ARCs | [devdocs/arc/README.md](../../devdocs/arc/README.md) |
| Platform ADRs | [devdocs/adr/README.md](../../devdocs/adr/README.md) |
| Architecture | [devdocs/architecture.md](../../devdocs/architecture.md) |
| Canopy plans | [docs/plans/README.md](../../docs/plans/README.md) |
| Canopy ADRs | [docs/adr/](../../docs/adr/) |

**Canopy implementation maps** (prefer over re-deriving platform ARCs)

| Domain | Primary refs |
| ------ | ------------- |
| Grant verification | [devdocs ARC-0019](../../devdocs/arc/arc-0019-grant-verification-model.md), [canopy-grant-verification-implementation.md](../../docs/arc/canopy-grant-verification-implementation.md), [grants.md](../../docs/grants.md) |
| Statement COSE / signer binding | [arc-statement-cose-encoding.md](../../docs/arc/arc-statement-cose-encoding.md), [arc-grant-statement-signer-binding.md](../../docs/arc/arc-grant-statement-signer-binding.md) |
| Checkpoint delegation | [arc-checkpoint-delegation-isolation.md](../../docs/arc/arc-checkpoint-delegation-isolation.md) |
| Univocity / genesis registration | [arc-univocity-instance-registration.md](../../docs/arc/arc-univocity-instance-registration.md) |
| Ingress / sequencing / liveness | [devdocs ARC-0002/0005](../../devdocs/arc/arc-0002-cloudflare-do-ingress.md), DO ADRs in [devdocs/adr/README.md](../../devdocs/adr/README.md) |
| x402 / payments | [devdocs ARC-0015](../../devdocs/arc/arc-0015-x402-settlement-architecture.md) |
| Onboarding / ops admin | [devdocs ARC-021](../../devdocs/arc/arc-021-payment-onboarding/README.md), canopy onboard ADRs/plans |
| Authority hierarchy | [devdocs ARC-0017](../../devdocs/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md) |
| Genesis chain binding | [devdocs ADR-0034](../../devdocs/adr/adr-0034-forest-genesis-chain-binding-required.md) |

For each selected invariant: state what the design **requires**, then whether
the diff upholds or violates it.

### 1.3 Spec source

Resolve in order:

1. User-supplied plan path or Linear id
2. `FOR-*` / `#NNN` in branch name, PR title, or commit messages
3. Matching [docs/plans/plan-*.md](../../docs/plans/)
4. PR body: `gh pr view --json url,title,body`

If no spec exists, review design invariants + code quality only.

---

## 2. Graphite stack scope detection

Canopy uses **Graphite (`gt`)**. Detect whether review spans one branch or a
multi-PR stack.

```bash
cd "$(git rev-parse --show-toplevel)"   # must be canopy
BR=$(git branch --show-current)
TRUNK=main
```

### 2.1 Branch tracked by Graphite?

```bash
command -v gt >/dev/null 2>&1 && gt branch info --branch "$BR" >/dev/null 2>&1
```

- **Success** → continue to 2.2.
- **Failure** (no `gt`, or “untracked branch”) → **single-branch fallback**:
  ```bash
  git diff $TRUNK...HEAD
  ```
  Report: “Graphite metadata unavailable; reviewed as single branch vs $TRUNK.”

### 2.2 Single branch vs full stack

```bash
gt log short          # ◉ = current; ◯ = other tracked branches in stack
gt branch info --branch "$BR"
```

Read **Parent:** from `gt branch info` (e.g. `Parent: main`).

| Condition | Scope |
| --------- | ----- |
| Parent is `$TRUNK`, only one feature branch above trunk in `gt log short` | **Single branch** |
| Parent is another feature branch, or multiple branches trunk → current | **Full stack** |
| User: `single-branch` | Current branch vs Graphite parent only |
| User: `full-stack` | Cumulative `$TRUNK...HEAD` plus per-PR slices |
| Spec/Linear names sibling repos (mandate, arbor, …) with coupled work | **Cross-repo** — full review in canopy; note sibling gaps, file Linear for off-repo remediations |

### 2.3 Collect diffs

**Single branch**

```bash
git log $TRUNK..HEAD --oneline
git diff $TRUNK...HEAD
gh pr view --json url,title,body,number 2>/dev/null || true
```

**Full stack** — branches from `gt log short` (trunk → current), for each `B`:

```bash
git checkout "$B"
PARENT=$(gt branch info --branch "$B" | sed -n 's/^Parent: //p')
git log "$PARENT"..HEAD --oneline
gt branch info --branch "$B" --stat    # or --diff
gh pr view --head "$B" --json url,number,title 2>/dev/null || true
```

Restore original branch. On stack tip, also:

```bash
git diff $TRUNK...HEAD
```

**Do not** checkout sibling repos unless user passed `cross-repo`; instead
record canopy-side contract assumptions and open Linear issues for mandate/arbor
gaps.

---

## 3. Review dimensions

Severity: **High** (block merge), **Medium** (fix in epic/stack), **Low**
(defer).

| Dimension | Canopy focus |
| --------- | ------------- |
| **Security** | Grant auth, onboard tokens, curator/ops bearer, COSE verification, RPC/chain binding, secret handling in workers |
| **Liveness** | SequencingQueue DO, ingress pull/ack, dead letters, worker timeouts, idempotent redeem/genesis, partial failure |
| **Testability** | Public HTTP/worker surfaces; mock at boundaries per TDD skill |
| **Test coverage** | Vitest unit tests; Playwright integration/system where behaviour is user-visible — see [e2e.md](../../docs/agents/e2e.md) |
| **Best practice** | AGENTS.md, `.cursor/rules/`, package conventions, types-single-responsibility |
| **Modern standards** | Workers APIs, CBOR responses, typing, error shapes, observability |

Flag **design holes** (spec/ARC silent but code assumes behaviour) and
**non-obvious details** (future maintainers must know).

Cite rules by link; do not paste full rule text.

---

## 4. Parallel deep review (recommended for full stacks)

For **full-stack** or large diffs, spawn parallel subagents:

- **Security + crypto** — grants, COSE, genesis, chain RPC, onboard auth
- **Liveness + distributed** — forestrie-ingress, delegation-coordinator DOs
- **Tests + standards** — diff vs TDD skill and canopy rules

Cap each subagent ~400 words; aggregate and dedupe.

---

## 5. Output: findings report

### Scope

Repo, branch(es), Graphite stack yes/no, diff range(s), spec/plan links, PR URLs.

### Findings table

| ID | Sev | Dim | Branch/PR | Location | Finding | Invariant/Rule |
| -- | --- | --- | --------- | -------- | ------- | -------------- |

High/Medium → remediation; Low → brief list.

### Design holes & non-obvious details

Bullets with doc/spec citations.

---

## 6. Output: remediation implementation plan

Write under **canopy** [docs/plans/](../../docs/plans/):

- **Path:** `docs/plans/plan-NNNN-{slug}-review-remediation.md` (next NNNN per
  [.cursor/rules/docs-workflow.mdc](../rules/docs-workflow.mdc))
- **Header:** Status DRAFT, Date, Related (spec, Linear, branches/PRs reviewed)
- **Sections:**
  1. Review scope summary
  2. Remediation items: id, severity, branch, tasks, acceptance criteria, tests
  3. **Branch assignment**
     - *Current stack* — fix on named stacked branch
     - *New stack branch* — `gt create` / new PR above tip
     - *Sibling repo / post-merge* — mandate, arbor, etc.; not on current canopy branches
  4. Deferred (Low)

Do not implement unless the user asks.

---

## 7. Linear integration

Follow [.cursor/rules/linear-mcp-forestrie.mdc](../rules/linear-mcp-forestrie.mdc):

1. First MCP call: `get_user` with `query: "me"` — verify `robinbryce@gmail.com`
   and team **FOR**. Stop if wrong workspace.
2. Resolve linked issues from spec/commits (`FOR-*`).

### Update existing tickets

`save_comment` on linked issues when review finds:

- Design holes or missing acceptance criteria
- Non-obvious constraints for implementers
- High/Medium findings owned by that ticket

Link remediation plan and PRs. No secrets.

### Create new issues

`save_issue`, `team: "FOR"`, for remediations that **cannot** ship on current
canopy stack branches:

- Sibling-repo work (mandate UI, arbor custodian, …)
- Depends on merged parent PR
- Cross-cutting hardening deferred from feature PR

Title ≤79 chars; priority 1–2 (High), 3 (Medium); use `relatedTo` /
`parentId` / `blockedBy` as appropriate.

### Do not

- Duplicate issues for work assignable to current stack (put in plan §Branch assignment)
- Guess issue ids outside Forestrie workspace

---

## 8. Checklist

1. Canopy standards + selective invariants loaded
2. Graphite scope: single / full-stack / cross-repo (canopy-primary)
3. Diffs and commits for correct range(s)
4. Six dimensions reviewed; High/Medium recorded
5. Remediation plan in `docs/plans/`
6. Linear comments + off-stack issues
7. Summary: worst finding, counts, plan path, Linear ids touched
