# Canopy onboard admin UI

Static ops console for [FOR-172](https://linear.app/forestrie/issue/FOR-172)
(plan-0041). Serves JSON admin routes under `/api/onboarding/admin/**` and
`/api/payments/admin/**` (ADR-0009).

## Local use

1. Open `index.html` in a browser, or serve the directory:

   ```bash
   cd packages/apps/canopy-admin
   python3 -m http.server 8080
   ```

2. Configure **Canopy API base URL** and **`CANOPY_OPS_ADMIN_TOKEN`**
   (stored in `sessionStorage` for the tab only).

3. Dev lane secrets via Doppler (example):

   ```bash
   doppler run --project canopy --config dev -- printenv CANOPY_OPS_ADMIN_TOKEN
   ```

## FOR-181 (request queue)

- Status filters, pagination (Load more), row detail panel
- Approve (confirm) / reject (optional reason, max 512 chars)
- JSON problem-detail error toasts (FOR-185)
- DOM-safe rendering (no `innerHTML` for operator-supplied fields)

## FOR-182 (tokens + kill switch)

- **Tokens:** `GET /api/onboarding/admin/tokens` — label, status, chain, request
  ref, hash prefix, consumed forest R, created/expiry
- Click **Forest R** on a redeemed token to open the kill-switch tab with R
  prefilled
- **Kill switch:** load `GET /api/payments/admin/registrations/{R}/enabled`,
  toggle via `PUT` with `{ enabled: boolean }` (confirm dialog)
- Error toasts for 404 (not registered) and 503 (coordinator unavailable)

## Manual smoke

Cross-check plan-0041 scenario rows S1–S15 against dev lane after mandate
`onboard request` (see plan-0040 FOR-178 matrix).

## Deploy (Cloudflare Pages)

- **Project:** `canopy-admin-dev` (dev lane, deploys on push to `main` when this
  directory changes)
- **Workflow:** `.github/workflows/deploy-canopy-admin.yml` (also
  `workflow_dispatch`)
- Requires GitHub **dev** environment: `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`

## Manual acceptance checklist (S1–S15)

Cross-check [plan-0041](../../docs/plans/plan-0041-canopy-admin-ops-console.md)
scenario matrix on the dev lane with Doppler ops token and mandate onboard smoke.

| # | Scenario | Check |
|---|----------|-------|
| S1 | Pending request visible | Pending row shows label, chain, contact, expiresAt |
| S2 | Approve pending | Status → approved; mandate redeem works |
| S3 | Reject with reason | Status → rejected; reason in detail + list |
| S4 | Reject without reason | Status → rejected; no reason stored |
| S5 | Approve non-pending | Error toast; no state change |
| S6 | Missing ops token | Config prompt; API calls blocked |
| S7 | Invalid ops token | 401 on fetch; clear error message |
| S8 | Token list after redeem | Entry with requestId, hash prefix, active status |
| S9 | Token list after genesis | `consumedForestR` populated on token row |
| S10 | Kill switch read | Shows enabled true/false for registered R |
| S11 | Kill switch disable | PUT `enabled=false`; coordinator updated |
| S12 | Kill switch re-enable | PUT `enabled=true`; coordinator updated |
| S13 | Unknown forest R | 404 registration not found toast |
| S14 | Pagination | Load more requests when cursor present |
| S15 | CORS from Pages origin | Preflight succeeds for GET/POST/PUT from Pages URL |

Rows S1–S7, S14–S15: API unit tests + manual UI. Rows S8–S13: manual UI after
mandate provision smoke (FOR-178).
