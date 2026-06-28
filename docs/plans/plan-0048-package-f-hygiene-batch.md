# Plan 0048 — Package F hygiene batch

**Status:** DRAFT  
**Date:** 2026-06-27  
**Linear epic:** [FOR-214](https://linear.app/forestrie/issue/FOR-214)  
**Parent PRD:** [FOR-189](https://linear.app/forestrie/issue/FOR-189) Package F (hygiene)

---

## Authority

**Primary design, acceptance criteria, and acceptance tests live in Linear**
(FOR-214 and child issues). This file is an orchestration index only.

---

## Context

Deferred hygiene from post-Mode-C productization:

- GitHub Packages install for `@forestrie/delegation-cose` (git pin workaround)
- Agent `requestKey` reservation hardening (KV race documented)
- Mandate-signer per-`keyRef` rate limiting
- Coordinator edge rate limit on public certificate POST (ADR-0008)

**Out of scope:** FOR-204 KS256 register-grant verification (parallel session).

---

## Issue stack

| Phase | Issue | Repo | Branch |
|-------|-------|------|--------|
| Epic | [FOR-214](https://linear.app/forestrie/issue/FOR-214) | — | — |
| 0 | [FOR-215](https://linear.app/forestrie/issue/FOR-215) | mandate + devdocs | `robin/for-215-hygiene-design` |
| 1a | [FOR-119](https://linear.app/forestrie/issue/FOR-119) | canopy + mandate | `robin/for-119-packages-install` |
| 1b | [FOR-109](https://linear.app/forestrie/issue/FOR-109) | mandate | `robin/for-109-delegation-cose-pin` |
| 2 | [FOR-118](https://linear.app/forestrie/issue/FOR-118) | mandate | `robin/for-118-requestkey-dedup` |
| 3 | [FOR-120](https://linear.app/forestrie/issue/FOR-120) | mandate | `robin/for-120-signer-rate-limit` |
| 4 | [FOR-137](https://linear.app/forestrie/issue/FOR-137) | devdocs + ops | `robin/for-137-cert-edge-rate-limit` |
| R1 | [FOR-216](https://linear.app/forestrie/issue/FOR-216) | mandate | `robin/for-216-hygiene-review` |
| Close | [FOR-217](https://linear.app/forestrie/issue/FOR-217) | all | _(no branch)_ |

---

## Worktrees + Graphite

```bash
# Mandate stack (sequential)
git worktree add ~/Dev/personal/forestrie/.worktrees/mandate-hygiene main
cd ~/Dev/personal/forestrie/.worktrees/mandate-hygiene
gt trunk
gt create robin/for-215-hygiene-design -m "docs: Package F design lock (FOR-215)"
gt create robin/for-119-packages-install -m "fix(deps): GitHub Packages delegation-cose (FOR-119)"
gt create robin/for-109-delegation-cose-pin -m "chore(agent): semver pin delegation-cose (FOR-109)"
gt create robin/for-118-requestkey-dedup -m "fix(agent): requestKey reservation (FOR-118)"
gt create robin/for-120-signer-rate-limit -m "feat(signer): per-keyRef rate limit (FOR-120)"
gt create robin/for-216-hygiene-review -m "chore: Package F review pass (FOR-216)"
gt submit --stack

# Canopy (parallel, if FOR-119 needs publish fix)
git worktree add ~/Dev/personal/forestrie/.worktrees/canopy-hygiene main
cd ~/Dev/personal/forestrie/.worktrees/canopy-hygiene
gt trunk
gt create robin/for-119-packages-publish -m "fix(publish): delegation-cose tarball (FOR-119)"

# Devdocs (parallel, FOR-137)
git worktree add ~/Dev/personal/forestrie/.worktrees/devdocs-hygiene main
cd ~/Dev/personal/forestrie/.worktrees/devdocs-hygiene
gt trunk
gt create robin/for-137-cert-edge-rate-limit -m "docs(ops): certificate POST edge RL (FOR-137)"
```

Branch naming: `.cursor/rules/branch-naming.mdc`.

---

## Execution order

1. FOR-215 design lock (docs only)
2. FOR-119 (+ canopy publish if needed) → FOR-109
3. FOR-118 → FOR-120 (mandate stack)
4. FOR-137 (parallel devdocs/ops)
5. FOR-216 review pass
6. FOR-217 merge + sign-off matrix

Do **not** rebase onto FOR-204 / KS256 register-grant work.

---

## Related plans

- [plan-0044](plan-0044-package-d-cross-stack-e2e.md) — Package D (complete)
- mandate ADR-0003, ADR-0004
- canopy ADR-0008
