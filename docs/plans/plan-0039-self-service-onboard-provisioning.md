# Plan 0039 — Self-service onboard provisioning

**Status:** ACTIVE — code complete; pending dev-lane deploy smoke and cross-repo E2E (FOR-166).
**Date:** 2026-06-26
**Related:**
[ADR-0009](../adr/adr-0009-self-service-onboard-provisioning.md),
[FOR-166](https://linear.app/forestrie/issue/FOR-166),
[devdocs ARC-021.7](../../../devdocs/arc/arc-021-payment-onboarding/07-self-service-onboard-request.md)

---

## Goal

Implement self-service onboard request → approve → redeem per ADR-0009.

## Linear issues

| Phase | Issue | Branch |
|-------|-------|--------|
| 0 | FOR-167 | `robin/for-167-onboard-design` |
| 1–2 | FOR-168, FOR-169 | `robin/for-168-request-api`, `robin/for-169-ops-redeem` |
| 3 | FOR-170 | `robin/for-170-token-binding` |
| 4 | FOR-171 | `robin/for-171-notify-hooks` |
| 5 | FOR-172 | `robin/for-172-admin-ui` |
| 6 | FOR-173 | `robin/for-173-mandate-cli` |
| 7 | FOR-174 | `robin/for-174-auto-approve` |

## Scenario matrix

See delivery plan grill section; all rows covered by `onboard-request.test.ts`,
`onboard-notify.test.ts`, `onboard-auto-approve.test.ts`, and forest-genesis tests.

## Env vars

| Var | Purpose |
|-----|---------|
| `ONBOARD_ALLOWED_CHAIN_ID` | v1 single-chain gate |
| `ONBOARD_REQUEST_TTL_SEC` | Request expiry (default 604800) |
| `ONBOARD_REQUEST_WEBHOOK_URL` | Operator notification |
| `ONBOARD_REQUEST_WEBHOOK_SECRET` | HMAC signing |
| `ONBOARD_AUTO_APPROVE` | Dev lane auto-approve |
| `ONBOARD_AUTO_APPROVE_CHAIN_IDS` | Comma-separated allowlist |

## R2 layout

- `onboarding/requests/{requestId}.json`

## Validation commands

```bash
pnpm --filter @canopy/api test -- test/onboard-request.test.ts
pnpm --filter @canopy/api test -- test/onboard-notify.test.ts
pnpm --filter @canopy/api test -- test/onboard-auto-approve.test.ts
```

## Dev-lane E2E (post-deploy)

1. Deploy `canopy-api` dev with `ONBOARD_ALLOWED_CHAIN_ID` and
   `UNIVOCITY_CONTRACT_RPC_URL` secret (see `wrangler.jsonc` dev env).
2. `task test:live:onboard` (mandate worktree) — request → approve → redeem.
3. `task onboard:request` / `task onboard:redeem` — operator CLI path.
4. `task provision` with redeemed token — PA genesis + binding (`consumedForestR`).
5. Close FOR-166 when steps 2–4 pass on dev lane.
