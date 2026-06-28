# Plan 0049 — E2e Imutable provision consolidation

**Status:** IMPLEMENTED  
**Date:** 2026-06-27  
**Related:**
- [plan-0032](plan-0032-univocity-imutable-e2e-provision.md) (original ephemeral provision)
- [plan-0034](plan-0034-ci-consolidation.md) (tests-system prepare)
- [univocity-tools ADR-0010](../../univocity-tools/docs/adr/adr-0010-e2e-provision-in-deployer.md)

## Goal

Consolidate ephemeral **ImutableUnivocity** e2e provisioning into a reusable
univocity-tools library + CLI, thin canopy Taskfile orchestration, and a single
CI prepare path.

## Changes

| Area | Change |
|------|--------|
| **univocity-tools** | `runProvisionImutableAlg`, `runProvisionImutableE2e`, `deploy provision e2e` |
| **univocity-tools** | ADR-0010, CONTEXT glossary terms, Anvil integration test |
| **canopy** | `e2e-univocity.yml` calls deployer CLI; `ci-prepare` task |
| **canopy** | `tests-system.yml` prepare step delegates to task |
| **canopy** | plan-0032 marked IMPLEMENTED; pin univocity-tools version |

## Verification

```bash
# univocity-tools
cd univocity-tools && bun test && bun run typecheck

# Local canopy preflight
doppler run --project canopy --config dev -- task test:e2e:preflight

# CI
gh workflow run tests-system.yml -R forestrie/canopy -f environment=dev
```

## Success criteria

- Single orchestration path for local preflight and CI prepare.
- `.work/e2e-univocity.env` shape unchanged for Playwright.
- `grants-bootstrap` and Mode C system specs pass on dev.
