# plan-0034: CI consolidation (tests-system / tests-integration / ci)

Status: **IMPLEMENTED**

## Summary

Consolidated GitHub Actions into three test entry points and a release promotion
gate:

| Workflow | Trigger | Role |
| -------- | ------- | ---- |
| `ci.yml` | push, PR | Lint, format, unit tests |
| `tests-integration.yml` | push, PR | Playwright **integration** vs **dev** |
| `tests-system.yml` | dispatch, call, push main (deduped) | Univocity prepare + full dev suite |
| `deploy-workers.yml` | push main, dispatch, call | Deploy; chains **tests-system** on dev |
| `release.yaml` | `v*` tags | Dev deploy → system e2e → prod promote → health |

Retired **`pr-dev-deploy-e2e.yml`** and **`api-e2e-playwright.yml`**.

## Univocity prepare (tests-system)

Per alg (ES256 / KS256), independently:

- **No address input** → ephemeral Imutable deploy (`task e2e-univocity:deploy-one`);
  `E2E_UNIVOCITY_*_ALLOW_BOOTSTRAP=true`; full bootstrap specs run.
- **Address supplied** → require matching bootstrap key (PEM b64 / key b64); derive
  log id from address; `ALLOW_BOOTSTRAP=false`; bootstrap mutating specs skip for
  that alg only.

## Release promotion

`v*` tag → unit tests → deploy **dev** (Lane A) → **tests-system.yml** → on pass
deploy **prod** (Lane B) → prod health check.

## Behavior change

PRs no longer auto-deploy PR branches to dev or run full system e2e. Use **System
tests** workflow dispatch on a branch when needed.

## Related

- [taskfiles/e2e-setup.md](../../taskfiles/e2e-setup.md)
- [docs/workers-environments.md](../../docs/workers-environments.md)
- [plan-0032](plan-0032-univocity-imutable-e2e-provision.md)
