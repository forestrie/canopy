# Canopy implementation plans

Read this index first. Do not bulk-read [archived/](archived/) unless a task
cites a specific plan id.

Platform-wide plans: [devdocs/plans/](../../../devdocs/plans/README.md).

## Active plans

| Plan | Status | Read when |
|------|--------|-----------|
| [plan-0029](plan-0029-delegate-grant-validation-to-univocity.md) | DRAFT | Univocity grant validation delegation |
| [plan-0030](plan-0030-forests-storage-and-uuid-logid.md) | ACTIVE | UUID log IDs, forests/ layout |
| [plan-0034](plan-0034-ci-consolidation.md) | IMPLEMENTED | CI: ci.yml, tests-integration, tests-system, release promotion |
| [plan-0035](plan-0035-delegation-cose-library.md) | IMPLEMENTED | FOR-94: `@forestrie/delegation-cose` assemble+verify ES256/KS256 |
| [plan-0036](plan-0036-webhook-delivery.md) | IMPLEMENTED | FOR-93: coordinator `delegation.required` webhook delivery |
| [plan-0037](plan-0037-mode-c-onboarding-coordinator-forward.md) | IMPLEMENTED | Mode C genesis coordinator forward + webhook seal e2e |
| [plan-0038](plan-0038-wallet-challenge-coordinator-e2e.md) | DRAFT | FOR-129 wallet-challenge coordinator e2e (replace skips/best-effort) |
| [plan-0039](plan-0039-self-service-onboard-provisioning.md) | COMPLETE | FOR-166 self-service onboard (closed 2026-06-27) |
| [plan-0040](plan-0040-onboard-epic-closure-backlog.md) | DRAFT | FOR-178 closure (complete); FOR-172 → plan-0041 |
| [plan-0041](plan-0041-canopy-admin-ops-console.md) | DRAFT | FOR-172 admin ops console (FOR-180–183) |
| [plan-0042](plan-0042-admin-ops-remediation.md) | DRAFT | FOR-172 review remediation (FOR-184–188) |
| [plan-0043](plan-0043-admin-ops-followup-remediation.md) | DRAFT | FOR-172 post-FOR-181 review follow-up |
| [plan-0032](plan-0032-univocity-imutable-e2e-provision.md) | DRAFT | Fresh Imutable Safe deploy for e2e |
| [plan-0031](plan-0031-ks256-forest-roots.md) | ACTIVE | KS256 forest roots |
| [plan-0033](plan-0033-ks256-register-statement.md) | IMPLEMENTED | KS256 register-statement verify |
| [plan-0028](plan-0028-forest-genesis-chain-binding.md) | DRAFT | Genesis v1 chain binding POST |
| [plan-0019](plan-0019-bootstrap-path-and-genesis-cache.md) | DRAFT | Bootstrap-scoped SCRAPI paths |
| [plan-0018](plan-0018-forest-genesis-api.md) | ACCEPTED | `/api/forest` genesis API |
| [plan-0017](plan-0017-custodian-custody-sign-iam.md) | DRAFT | Custodian custody sign IAM |
| [plan-0015](plan-0015-custody-grant-signing-canopy-api.md) | DRAFT | Custody-key grant signing |
| [plan-0014](plan-0014-register-grant-custodian-signing.md) | DRAFT | Custodian-signed register-grant |
| [plan-0011](plan-0011-custodian-integration-and-current-state.md) | DRAFT | Custodian integration state |
| [plan-0021](plan-0021-delegation-coordinator-apis.md) | ACTIVE | Delegation coordinator APIs |
| [plan-0022](plan-0022-delegation-coordinator-ops-parity.md) | ACTIVE | Coordinator ops/CI parity |
| [plan-0023](plan-0023-coordinator-public-root.md) | ACTIVE | Coordinator public-root |
| [plan-0020](plan-0020-custodial-delegation-seams-pilot.md) | ACTIVE | Custodial delegation pilot |
| [plan-0025](plan-0025-queue-independent-grant-authorization.md) | ACTIVE | Queue-independent grant auth |
| [plan-0027](plan-0027-mmr-interior-node-position-commitment.md) | ACTIVE | MMR interior node commitment |
| [plan-0026](plan-0026-auth-data-log-parent-receipt-rca.md) | RCA | Auth data log parent 403 RCA |
| [plan-0024](plan-0024-byok-checkpoint-seal-rca.md) | RCA | BYOK checkpoint seal RCA |
| [plan-0012](plan-0012-perf-workflow-synthesize-log-ids.md) | ACCEPTED | Perf log ID synthesis in CI |
| [plan-0010-grant-workflow](plan-0010-grant-workflow-and-taskfiles.md) | ACTIVE | Grant workflow taskfiles |
| [plan-0010-deploy](plan-0010-deploy-and-test-on-branch.md) | ACTIVE | Deploy and test on branch |
| [plan-0009](plan-0009-bootstrap-and-load-test-readiness.md) | ACTIVE | Bootstrap/load-test readiness |
| [plan-0008](plan-0008-remove-grants-authority-storage.md) | ACTIVE | Remove grants authority storage |
| [plan-0007](plan-0007-grant-type-and-commitment-alignment.md) | ACTIVE | Grant type alignment |
| [plan-0006](plan-0006-idtimestamp-separate-parameter.md) | ACTIVE | Idtimestamp parameter |
| [plan-0005](plan-0005-grant-receipt-unified-resolve.md) | ACTIVE | Grant+receipt unified artifact |
| [plan-0004 overview](plan-0004-log-bootstraping/overview.md) | ACTIVE | Log bootstrapping (partial) |
| [plan-0003-encoding](plan-0003-encoding-redux.md) | ACTIVE | Encoding/signing support |
| [plan-0003-scripts](plan-0003-scripts-consolidation.md) | ACTIVE | Scripts consolidation |
| [plan-0003-grant-pool](plan-0003-grant-pool-script-review.md) | ACTIVE | Grant pool script review |
| [plan-0002](plan-0002-doppler-secrets-migration.md) | IMPLEMENTED | Doppler secrets migration |

## Archived

See [archived/README.md](archived/README.md) for superseded plan-0001, plan-0004
subplans 01–05/08, plan-0010-bootstrap-env, [plan-0016](archived/plan-0016-delegation-signer-custodian-migration.md), and related material.
