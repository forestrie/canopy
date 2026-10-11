---
name: review-changes
description: Graphite-aware, design-invariant review of Forestrie work in progress, producing findings, a remediation plan, and Linear follow-ups.
when_to_use: The user asks to review a branch, stack, or PR, or says "review my changes" in a Forestrie repo.
argument-hint: "[base-ref] [FOR-123] [plan path] [scope override]"
---

# Review changes (Graphite-aware, design-invariant focused)

Establish if the changes are predominantly infrastructure or predominantly implementation (backend).

Always review from the perspective of a highly experienced distributed systems engineer with extensive experience in highly scalable systems and deep applied cryptography knowledge. The product is fundamentally about operating tamper evident transparency logs at scale.

If the changes are predominantly infrastructure, use a DevOps / DevSecOps lens: you have an eye for making best use of prevailing best practice whilst taking into account the specifics of the forestrie architecture's goals. Kubernetes, CI/CD, GitOps, and infrastructure as code are things you live and breathe.
If implementation (backend), focus closely on correctness, best practice, and optimal data-structure and algorithm choices for scale.

With those personas as framing thoroughly review **Forestrie** work in progress.
Produce findings, a remediation **implementation plan**, and Linear follow-ups.

Run all git/gt/gh commands from the **working repository root**
(`git rev-parse --show-toplevel` must be the repo under review).

Optional arguments (pass through if given):

- Fixed point: branch, tag, commit, or `main` (default: stack-aware — step 2)
- Linear issue id(s): e.g. `FOR-167`
- Plan path: e.g. `docs/plans/plan-0028-*.md`
- Scope override: `single-branch`, `full-stack`, `cross-repo`, or repo class:
  `canopy`, `arbor`, `univocity`, `infra`, `mandate`, `tools`

---


Arguments: `$ARGUMENTS`

## 1. Establish context

### 1.1 Common standards (link, do not restate)

Read selectively before reviewing the diff:

| Source | When |
| ------ | ---- |
| [Rules of the road](https://github.com/forestrie/forestrie-agents/tree/main/rules-of-the-road): `platform.md` + the one matching repo file (already loaded as `.claude/rules/rules-of-the-road-*.md` in a synced repo) | **Always** — fundamental invariants; run the [rules-of-the-road-review](../rules-of-the-road-review/SKILL.md) skill as the design-invariant pass |
| Repo `forest/agents/AGENTS.md` or root `AGENTS.md` | Repo overlay and precedence |
| [forestrie-agents/workflow/rules/](../../rules/) | go-task, commits, TS/Go/Solidity rules, breaking-changes |
| [forestrie-agents/vendored/matt-skills/skills/engineering/tdd/](../../../vendored/matt-skills/skills/engineering/tdd/SKILL.md) | Testability, coverage |
| The matching `arc-*` glossary skill (`arc-canopy`, `arc-arbor`, `arc-univocity`, `arc-infra`, `arc-mandate`, `arc-tools`, `arc-company`) | Domain terms for touched area |
| [devdocs/glossary.md](https://github.com/forestrie/devdocs/blob/main/glossary.md) | Shared vocabulary |

### 1.2 Repo-specific routers (read one matching repo)

| Repo | Router | CI gates (flag gaps only) |
| ---- | ------ | ------------------------- |
| canopy | [AGENTS.md](https://github.com/forestrie/canopy/blob/main/AGENTS.md) | `pnpm check`, typecheck, unit tests; e2e in CI workflows |
| arbor | [AGENTS.md](https://github.com/forestrie/arbor/blob/main/AGENTS.md) | `go test ./...` per service |
| univocity | [AGENTS.md](https://github.com/forestrie/univocity/blob/main/AGENTS.md) | `forge fmt --check`, `forge test`, slither in CI |
| forest-1 | [AGENTS.md](https://github.com/forestrie/forest-1/blob/main/AGENTS.md) | terraform fmt/validate |
| arbor-flux | [AGENTS.md](https://github.com/forestrie/arbor-flux/blob/main/AGENTS.md) | `kustomize build` |
| univocity-tools | [AGENTS.md](https://github.com/forestrie/univocity-tools/blob/main/AGENTS.md) | `bun run check`, typecheck, `check:cli`, `check:subprocess` |
| mandate | [AGENTS.md](https://github.com/forestrie/mandate/blob/main/AGENTS.md) | `pnpm -r test` |
| devdocs | [AGENTS.md](https://github.com/forestrie/devdocs/blob/main/AGENTS.md) | doc consistency |

### 1.3 Design invariants (read on demand)

The fundamental invariants are already the distilled
[rules-of-the-road](https://github.com/forestrie/forestrie-agents/tree/main/rules-of-the-road) loaded in §1.1 — check
the diff against those **first**. Use the indexes below only when a finding
needs the deeper rationale behind a rule (each rule links to its ADR/ARC).
Select a **tight** subset from touched paths. Start at indexes; do not bulk-read
devdocs.

**Platform indexes**

| Index | Path |
| ----- | ---- |
| Platform architecture | [devdocs/architecture.md](https://github.com/forestrie/devdocs/blob/main/architecture.md) |
| ADR index | [devdocs/adr/README.md](https://github.com/forestrie/devdocs/blob/main/adr/README.md) |
| ARC index | [devdocs/arc/README.md](https://github.com/forestrie/devdocs/blob/main/arc/README.md) |
| Ops runbooks | [devdocs/ops/README.md](https://github.com/forestrie/devdocs/blob/main/ops/README.md) |

**Domain maps**

| Domain | Primary refs |
| ------ | ------------- |
| Grant verification | [devdocs ARC-0019](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md), [canopy grant verification map](https://github.com/forestrie/canopy/blob/main/docs/arc/canopy-grant-verification-implementation.md) |
| x402 settlement | [devdocs ARC-0015](https://github.com/forestrie/devdocs/blob/main/archive/2601/arc/arc-0015-x402-settlement-architecture.md) (SUPERSEDED; current model: [payments theme index](https://github.com/forestrie/devdocs/blob/main/archive/INDEX-payments-fees.md)) |
| Authority / fee hierarchy | [devdocs ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md) |
| Checkpoint auth (on-chain) | [univocity ARC-0017](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md) |
| MMR / COSE receipts | [draft-bryce-cose-receipts-mmr-profile](https://github.com/robinbryce/draft-bryce-cose-receipts-mmr-profile), [go-merklelog](https://github.com/forestrie/go-merklelog) |
| Ingress / sequencing | [canopy docs/agents/gotchas.md](https://github.com/forestrie/canopy/blob/main/docs/agents/gotchas.md) |
| Custodian / KMS | [devdocs plan-0013](https://github.com/forestrie/devdocs/blob/main/plans/plan-0013-custodian-implementation.md) |
| System testing | [devdocs ARC-0024](https://github.com/forestrie/devdocs/blob/main/arc/arc-0024-system-testing-architecture.md) |
| GitOps secrets | [arbor-flux service-secrets.md](https://github.com/forestrie/arbor-flux/blob/main/docs/service-secrets.md) |

For each selected invariant: state what the design **requires**, then whether
the diff upholds or violates it.

### 1.4 Spec source

Resolve in order:

1. User-supplied plan path or Linear id
2. `FOR-*` in branch name, PR title, or commit messages
3. Matching `docs/plans/plan-*.md` in the repo (or devdocs/plans for platform)
4. PR body: `gh pr view --json url,title,body`

If no spec exists, review design invariants + code quality only.

---

## 2. Graphite stack scope detection

Repos using **Graphite (`gt`)** — detect single branch vs multi-PR stack.

```bash
cd "$(git rev-parse --show-toplevel)"
BR=$(git branch --show-current)
TRUNK=main
```

### 2.1 Branch tracked by Graphite?

```bash
command -v gt >/dev/null 2>&1 && gt branch info --branch "$BR" >/dev/null 2>&1
```

- **Success** → continue to 2.2.
- **Failure** → **single-branch fallback**: `git diff $TRUNK...HEAD`

### 2.2 Single branch vs full stack

```bash
gt log short
gt branch info --branch "$BR"
```

| Condition | Scope |
| --------- | ----- |
| Parent is `$TRUNK`, one feature branch | **Single branch** |
| Parent is another feature branch | **Full stack** |
| User: `single-branch` | Current branch vs Graphite parent only |
| User: `full-stack` | Cumulative `$TRUNK...HEAD` plus per-PR slices |
| Cross-repo coupled work | **Cross-repo** — primary review in current repo; Linear for sibling gaps |

### 2.3 Collect diffs

**Single branch:** `git log $TRUNK..HEAD --oneline`, `git diff $TRUNK...HEAD`,
`gh pr view` if exists.

**Full stack:** for each branch in stack (trunk → current), collect
parent..HEAD log and diff; restore original branch when done.

---

## 3. Review dimensions

Severity: **High** (block merge), **Medium** (fix in epic/stack), **Low** (defer).

| Dimension | Forestrie stack focus |
| --------- | --------------------- |
| **Security** | Grant verification, checkpoint auth, KMS/custodian, x402 payment validation, Worker secrets, on-chain access control, delegation token binding |
| **Liveness** | SequencingQueue DO, ranger pull, sealer signing, queue idempotency, GitOps rollout, shard assignments |
| **Correctness** | MMR append consistency, COSE receipt shape, logId→R uniqueness, SCRAPI CBOR contracts |
| **Testability** | Public HTTP/CLI/on-chain surfaces; mock at boundaries per TDD skill |
| **Test coverage** | Foundry, Go, pnpm, Bun tests — behaviour not implementation |
| **Best practice** | forestrie-agents rules, repo AGENTS.md, go-task over shell, citty/Bun.spawn in tools |
| **Modern standards** | Typing, error shapes, observability |

Flag **design holes** and **non-obvious details** with doc citations.

---

## 4. Output: findings report

### Scope

Repo, branch(es), Graphite stack yes/no, diff range(s), spec/plan links, PR URLs.

### Findings table

| ID | Sev | Dim | Branch/PR | Location | Finding | Invariant/Rule |
| -- | --- | --- | --------- | -------- | ------- | -------------- |

### Design holes & non-obvious details

Bullets with doc/spec citations.

---

## 5. Output: remediation plan

Write under the repo's `docs/plans/` (or devdocs/plans for platform-wide):

- **Path:** `docs/plans/plan-NNNN-{slug}-review-remediation.md`
- **Header:** Status DRAFT, Date, Related (spec, Linear, branches/PRs)
- **Sections:** scope summary; remediation items with acceptance criteria;
  branch assignment (current stack vs new branch vs sibling repo); deferred (Low)

Do not implement unless the user asks.

---

## 6. Linear integration

Team key: **FOR** (Forestrie workspace).

Before MCP calls, verify identity per linear-mcp-forestrie rules.

1. Resolve linked issues from spec/commits (`FOR-*`).
2. `save_comment` on linked issues for design holes and High/Medium findings.
3. `save_issue` for remediations that cannot ship on current stack (sibling-repo
   work, post-merge dependencies).

Title ≤79 chars (Forestrie commit convention); link remediation plan and PRs.
No secrets.

---

## 7. Checklist

1. Common + repo standards + selective invariants loaded
2. Graphite scope determined
3. Diffs for correct range(s)
4. Review dimensions applied
5. Remediation plan in `docs/plans/` (if Medium+ findings)
6. Linear comments + off-stack issues
7. Summary: worst finding, counts, plan path, Linear ids touched
