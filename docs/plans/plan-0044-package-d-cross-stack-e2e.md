# Plan 0044 — Package D cross-stack e2e confidence

**Status:** IN_PROGRESS  
**Date:** 2026-06-27  
**Linear epic:** [FOR-201](https://linear.app/forestrie/issue/FOR-201)  
**Parent PRD:** [FOR-189](https://linear.app/forestrie/issue/FOR-189) Package 4

---

## Authority

**Primary design, acceptance criteria, and acceptance tests live in Linear**
(FOR-201 and child issues). This file is an orchestration index only.

---

## Context

- FOR-138 ✓ — wallet-challenge coordinator e2e (plan-0038)
- FOR-166 ✓ — self-service onboard on dev
- Stretch specs green with opt-in env vars; default `tests-system.yml` does not
  prove webhook **push** or run Mode C seal

---

## Issue stack

| Phase | Issue | Branch |
|-------|-------|--------|
| Epic | [FOR-201](https://linear.app/forestrie/issue/FOR-201) | — |
| 0 | [FOR-202](https://linear.app/forestrie/issue/FOR-202) | `robin/for-202-e2e-prerequisites` |
| 1 | [FOR-127](https://linear.app/forestrie/issue/FOR-127) | `robin/for-127-webhook-push-tunnel` |
| 2 | [FOR-126](https://linear.app/forestrie/issue/FOR-126) | `robin/for-126-mode-c-default-tier` |
| 3 | [FOR-76](https://linear.app/forestrie/issue/FOR-76) | `robin/for-76-stretch-promotion` |
| R1 | [FOR-203](https://linear.app/forestrie/issue/FOR-203) | `robin/for-203-e2e-review-pass` |
| Close | [FOR-204](https://linear.app/forestrie/issue/FOR-204) | _(no branch)_ |

---

## Worktree + Graphite

```bash
git worktree add ~/Dev/personal/forestrie-wt/canopy-e2e main
cd ~/Dev/personal/forestrie-wt/canopy-e2e
gt trunk
gt create robin/for-202-e2e-prerequisites -m "chore(e2e): Package D CI prerequisites (FOR-202)"
gt create robin/for-127-webhook-push-tunnel -m "test(e2e): webhook push tunnel (FOR-127)"
gt create robin/for-126-mode-c-default-tier -m "test(e2e): promote Mode C webhook seal (FOR-126)"
gt create robin/for-76-stretch-promotion -m "test(e2e): promote BYOK stretch specs (FOR-76)"
gt create robin/for-203-e2e-review-pass -m "chore(e2e): Package D review pass (FOR-203)"
gt submit --stack
```

Branch naming: `.cursor/rules/branch-naming.mdc`.

---

## Related plans

- [plan-0037](plan-0037-mode-c-onboarding-coordinator-forward.md) — genesis webhook forward
- [plan-0038](plan-0038-wallet-challenge-coordinator-e2e.md) — FOR-138 (complete)
