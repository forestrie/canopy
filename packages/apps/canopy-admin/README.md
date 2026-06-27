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

## FOR-182 (next)

Tokens and kill-switch tabs are stubbed until FOR-182.

## Manual smoke

Cross-check plan-0041 scenario rows S1–S7 and S14–S15 against dev lane after
mandate `onboard request` (see plan-0040 FOR-178 matrix).
