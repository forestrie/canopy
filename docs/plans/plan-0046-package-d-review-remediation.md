# Plan 0046 — Package D review remediation

**Status:** IMPLEMENTED  
**Date:** 2026-06-27  
**Related:** [plan-0044](plan-0044-package-d-cross-stack-e2e.md), [FOR-201](https://linear.app/forestrie/issue/FOR-201), PR [#57](https://github.com/forestrie/canopy/pull/57)  
**Reviewed:** `origin/main...robin/for-202-e2e-prerequisites` (Graphite unavailable; single branch)

---

## 1. Review scope summary

| Item | Value |
|------|-------|
| Repo | canopy |
| Branch | `robin/for-202-e2e-prerequisites` |
| Commits | `dd3542c`, `b4cbf77` (+ `fcb0ff4` plan-0040 docs on branch base) |
| Spec | plan-0044 / FOR-201 (FOR-202, FOR-127, FOR-126, FOR-76, FOR-203) |
| PR | https://github.com/forestrie/canopy/pull/57 |

Review focused on Package D e2e changes: cloudflared tunnel, default-tier
promotion, env guards, CI preflight, docs.

---

## 2. Remediation items

### R1 — Poll loop bypasses webhook-push-only policy

| Field | Value |
|-------|-------|
| ID | R1 |
| Severity | **Medium** |
| Branch | *Current PR* (#57) or follow-up on same branch |
| Location | `mode-c-webhook-seal-helpers.ts` — `signPendingModeCKs256Delegations`, `pollRegistrationThroughModeCWebhook`, `pollReceiptUntil200` |

**Finding:** Initial `waitForModeCDelegationMaterial` enforces webhook push
(default) or explicit pull opt-in. Registration/receipt polling still calls
`signPendingModeCKs256Delegations` (pending-delegation **pull**) on every
iteration, so Sealer-driven delegations during register-grant/entry flows can
succeed without webhook delivery after the first asserted push.

**Tasks**

1. Gate `signPendingModeCKs256Delegations` in Mode C poll paths on
   `modeCAllowPullFallback()` or replace with webhook-receiver wait helpers.
2. Optionally assert `webhooksReceived` increments during poll phases in
   `byok-mode-c-webhook-seal.spec.ts`.

**Acceptance**

- Default CI path: no pending-delegation pull during Mode C spec unless
  `E2E_MODE_C_ALLOW_PULL_FALLBACK=1`.
- Existing vitest + typecheck green.

**Tests:** Extend `byok-mode-c-webhook-seal` assertions or add unit test for
poll helper gating.

---

### R2 — Preflight requires coordinator for all e2e tiers

| Field | Value |
|-------|-------|
| ID | R2 |
| Severity | **Medium** |
| Branch | *Current PR* (#57) |
| Location | `taskfiles/e2e-shared.yml` `validate-env` |

**Finding:** Coordinator env is now mandatory in preflight before any Playwright
run. Developers running integration-only or bootstrap system specs without
coordinator cannot pass `task test:e2e:preflight`.

**Tasks**

1. Require coordinator + ops-admin only when system project includes BYOK/Mode C
   specs, **or** document that full dev suite now requires coordinator (update
   `e2e-setup.md` / README if intentional).
2. Consider `VALIDATE_REQUIRE_COORDINATOR=1` default in CI, optional locally.

**Acceptance**

- Documented contract matches preflight behaviour.
- CI still fail-fast when coordinator missing for system tier.

---

### R3 — Pin cloudflared CI install

| Field | Value |
|-------|-------|
| ID | R3 |
| Severity | **Medium** |
| Branch | *Current PR* (#57) or post-merge chore |
| Location | `.github/workflows/tests-system.yml` |

**Finding:** Installs `cloudflared-linux-amd64.deb` from `/releases/latest/`
without version pin or checksum verification.

**Tasks**

1. Pin to a known version (match local dev docs or mise).
2. Add SHA256 verify or GitHub release asset hash.

**Acceptance**

- Reproducible CI cloudflared version; supply-chain note in e2e docs.

---

### R4 — PR scope includes plan-0040 commit

| Field | Value |
|-------|-------|
| ID | R4 |
| Severity | **Low** |
| Branch | Rebase PR onto `origin/main` (drop `fcb0ff4` if already on main elsewhere) |

**Finding:** PR diff vs `origin/main` includes `fcb0ff4 docs(plans): FOR-178
backlog` unrelated to FOR-201.

**Tasks**

1. Rebase onto latest `origin/main` and drop duplicate docs-only commit if
   redundant.

---

### R5 — Skip cloudflared install on prod Playwright project

| Field | Value |
|-------|-------|
| ID | R5 |
| Severity | **Low** |
| Branch | *Current PR* (#57) |
| Location | `.github/workflows/tests-system.yml` |

**Finding:** cloudflared install runs before `PLAYWRIGHT_PROJECT=prod` branch;
unnecessary for prod-only runs.

**Tasks**

1. Move install inside non-prod branch alongside coordinator validation.

---

## 3. Branch assignment

| Item | Assignment |
|------|------------|
| R1, R2, R3, R5 | Fix on PR #57 branch before merge (R1 highest priority) |
| R4 | Rebase hygiene on same branch |

No sibling-repo work identified.

---

## 4. Deferred (Low)

- **L1:** 90s cloudflared tunnel timeout may flake — monitor CI; increase or
  retry if needed.
- **L2:** Vitest covers URL parsing only; no spawn integration test for tunnel
  (acceptable for e2e harness).
- **L3:** Graphite stack from plan-0044 not used; single squashed PR is fine
  for this delivery.
