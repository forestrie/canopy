# Plan 0040 — Onboard epic closure backlog (FOR-172, FOR-178)

**Status:** DRAFT  
**Date:** 2026-06-27  
**Related:**
[plan-0039](plan-0039-self-service-onboard-provisioning.md),
[ADR-0009](../adr/adr-0009-self-service-onboard-provisioning.md),
[FOR-166](https://linear.app/forestrie/issue/FOR-166),
[FOR-172](https://linear.app/forestrie/issue/FOR-172),
[FOR-178](https://linear.app/forestrie/issue/FOR-178)

---

## Context

Package A closure stack through FOR-177 is merged and dev-deployed:

| Step | Issue | Outcome |
|------|-------|---------|
| R1 | FOR-175 | Review pass merged (canopy #40) |
| R2 | FOR-176 | Dev auto-approve in wrangler (canopy #41); deploy-workers green |
| R3 | FOR-177 | Mandate `live-onboard` CI job (mandate #9) |

**Remaining epic work:** operator UI (FOR-172) and cross-repo sign-off (FOR-178).
FOR-172 is **not** required to close FOR-166 functionally — mandate CLI + dev
auto-approve cover the fork path — but it is required for **clickable ops** and
was in the original epic scope.

---

## Dependency graph

```mermaid
flowchart LR
  FOR176[FOR-176 deployed] --> FOR178[FOR-178 smoke matrix]
  FOR177[FOR-177 live-onboard CI] --> FOR178
  FOR176 --> FOR172[FOR-172 admin UI]
  FOR178 --> FOR166[FOR-166 Done]
  FOR172 -. optional for epic close .-> FOR166
```

**Recommended order:** FOR-178 first (validates end-to-end path), then FOR-172
(ops polish). Either order is acceptable if FOR-178 records manual ops steps via
CLI until UI ships.

---

## FOR-178 — Cross-repo live smoke + close FOR-166

**Goal:** Run the acceptance matrix on deployed dev lane; post sign-off; close epic.

**Branch:** none unless smoke reveals gaps (fix-forward PRs on `main`).

### Prerequisites (verify before matrix)

- [ ] Canopy dev deploy includes `ONBOARD_AUTO_APPROVE=true` (FOR-176)
- [ ] GitHub **dev** / Doppler `canopy` has `SUPPORTED_CHAINS_RPC` with Alchemy
- [ ] Mandate Doppler `e2e` + GitHub **live-signer** secrets:
  `E2E_CANOPY_API_URL`, `E2E_CANOPY_CHAIN_ID`, `E2E_CANOPY_UNIVOCITY_ADDR`
- [ ] Mandate `live-onboard` job green on latest `workflow_dispatch`

### Acceptance matrix

| # | Step | Command / action | Expected |
|---|------|------------------|----------|
| 1 | Request | `doppler run -- task onboard:request` (mandate) | `201`, redeem code |
| 2 | Poll | `task onboard:status` | `approved` (auto-approve or ops) |
| 3 | Redeem | `task onboard:redeem` | Plaintext bearer once |
| 4 | Provision | `task provision` | PA genesis `201` |
| 5 | Consume | Repeat genesis with same token | `403` / binding consumed |
| 6 | Binding | Request with wrong Univocity addr | `422` |
| 7 | CI | `gh workflow run live-owned-wallet.yml -R forestrie/mandate` | `live-onboard` green |
| 8 | Docs | [FORKING.md §2](../../mandate/FORKING.md) | Matches lived path |

Row 6 can use mandate CLI with intentional wrong addr or curl CBOR create.

### Deliverables

1. Comment on [FOR-178](https://linear.app/forestrie/issue/FOR-178) with:
   - request IDs from rows 1–4
   - deploy-workers run URL (FOR-176)
   - live workflow run URL (row 7)
2. Update [plan-0039](plan-0039-self-service-onboard-provisioning.md) → **COMPLETE**
3. Mark FOR-178 → Done; FOR-166 → Done

### Estimated effort

**~2–4 hours** (mostly Doppler/env alignment and one full provision cycle).

### Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Create `502`/gate fail | RPC / Univocity addr | Check `SUPPORTED_CHAINS_RPC`, chain id |
| Stuck `pending` | Auto-approve off or wrong chain | FOR-176 vars or manual ops approve |
| Redeem `410` | Expired approved | Re-request; check TTL vars |
| Provision `403` | Token consumed or wrong binding | New redeem; verify `consumedForestR` |
| `live-onboard` red | Secrets or undeployed API | Sync Doppler → GitHub live-signer |

---

## FOR-172 — Canopy admin UI completion

**Goal:** Static ops console for pending queue, tokens, reject reason, kill switch.

**Repo:** canopy  
**Worktree:** `~/Dev/personal/forestrie-wt/canopy-onboard-close`  
**Branch:** `for/onboard-close-3-admin-ui`  
**Stack:** on `main` after FOR-176 merge

```bash
cd ~/Dev/personal/forestrie-wt/canopy-onboard-close
git fetch origin && git checkout -B for/onboard-close-3-admin-ui origin/main
gt create for/onboard-close-3-admin-ui -m "feat(canopy-admin): FOR-172 ops console"
```

### Current state (~40%)

`packages/apps/canopy-admin/index.html`:

- SessionStorage config (base URL + ops bearer)
- Pending queue via `GET /api/onboarding/admin/requests`
- Approve / reject (no reason) via admin JSON POST routes

### API surfaces (already implemented)

| UI need | Route | Notes |
|---------|-------|-------|
| Request list | `GET /api/onboarding/admin/requests` | JSON; pagination `limit`/`cursor` |
| Approve | `POST .../admin/requests/{id}/approve` | JSON |
| Reject | `POST .../admin/requests/{id}/reject` | **Reject reason: CBOR body today** — add JSON `{ rejectReason }` on admin route or bundle `cbor-x` in static UI |
| Token list | `GET /api/onboarding/admin/tokens` | ref, label, status, chainBinding, `consumedForestR` |
| Kill switch GET | `GET /api/payments/registrations/{R}/enabled` | Per-forest UUID |
| Kill switch PUT | `PUT /api/payments/registrations/{R}/enabled` | JSON `{ enabled: boolean }` |

No list-all-registrations API — derive `R` from token list `consumedForestR` or
manual UUID input.

### Implementation slices (vertical)

1. **Navigation + layout** — tabs: Requests | Tokens | Kill switch; shared config bar
2. **Request detail** — expand row: mandateOrigin, univocityAddr, expiresAt,
   rejectReason display; reject modal with reason textarea
3. **Reject body** — prefer small API change: accept `application/json` on admin
   reject (mirror CBOR `rejectReason` key) over pulling cbor-x into static HTML
4. **Token list** — table from `/admin/tokens`; link `consumedForestR` to kill-switch tab
5. **Kill switch** — input forest `R` + toggle; GET then PUT; show enabled state
6. **CORS smoke** — verify browser fetch from Pages origin to dev API (existing
   CORS on onboarding + payments ops routes)
7. **Deploy** — Cloudflare Pages project `canopy-admin` or document static
   hosting; update `packages/apps/canopy-admin/README.md`

### Acceptance criteria (from FOR-172)

- [ ] Operator approves pending request without curl
- [ ] Operator rejects with reason persisted on record
- [ ] Token list shows `consumedForestR` after mandate genesis
- [ ] Kill switch toggle changes coordinator enabled state
- [ ] Manual test against dev lane documented in PR

### Tests

- No new unit test package required for static HTML
- Optional: Playwright smoke in `@canopy/api-e2e` **only if** we add a served
  Pages URL in CI (defer unless requested)
- Manual checklist in PR is sufficient for v1

### Estimated effort

**~1–2 days** (UI polish + optional JSON reject + Pages deploy).

### Out of scope (v1)

- Auth beyond sessionStorage bearer
- Webhook inbox / email (FOR-171)
- Replacing mandate CLI for fork operators

---

## Linear updates (when executing)

| Issue | Action after work |
|-------|-------------------|
| FOR-176 | Done (deploy #41 merged + deploy-workers green) |
| FOR-177 | Done (mandate #9 merged) |
| FOR-178 | In Progress during matrix → Done on sign-off |
| FOR-172 | Backlog → In Progress when UI branch starts |
| FOR-166 | Done when FOR-178 complete (FOR-172 may remain open) |

---

## Commands reference

```bash
# FOR-178 local smoke (mandate worktree, Doppler)
doppler run --project mandate-forestrie --config dev -- task test:live:onboard
doppler run -- task onboard:request -- --label smoke-$(date +%s) ...
doppler run -- task provision

# Dispatch CI live suite
gh workflow run live-owned-wallet.yml -R forestrie/mandate --ref main
gh run list -R forestrie/mandate --workflow=live-owned-wallet.yml --limit 1
gh run watch <run-id> -R forestrie/mandate --exit-status

# Dev deploy (if needed)
gh workflow run deploy-workers.yml -R forestrie/canopy \
  -f environment=dev -f app=canopy-api -f run_e2e=true
```
