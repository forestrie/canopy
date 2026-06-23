# plan-0037 — Mode C genesis coordinator forward + webhook seal e2e

**Status:** IMPLEMENTED  
**Linear:** (genesis forward — new issue); FOR-76 (webhook seal e2e promotion)  
**Related:** [arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md),
[plan-0021](plan-0021-delegation-coordinator-apis.md),
[plan-0036](plan-0036-webhook-delivery.md)

## Summary

Operators holding only an **onboard token** could not register coordinator
`public-root` or `webhook` (both require `COORDINATOR_APP_TOKEN`). This plan
adds a one-shot forward during `POST /api/forest/{R}/genesis?webhookUrl=`
and a webhook-driven Mode C seal stretch e2e with an in-repo receiver.

## PR A — genesis one-shot forward (canopy-api)

- `?webhookUrl=` query param (never stored in genesis CBOR).
- `forward-coordinator-registration.ts`: derive `publicRoot` from genesis
  `bootstrapKey` (ES256 `x||y` or KS256 address); `POST …/public-root` then
  `PUT …/webhook` with canopy's `COORDINATOR_APP_TOKEN`.
- Validate `webhookUrl` before genesis write; 503 when coordinator unset.
- 201 response includes optional `coordinator: { publicRoot, webhook }` status.
- Unit tests: `forest-genesis-coordinator-forward.test.ts`.

## PR B — webhook-driven Mode C seal e2e

- `tests/system/helpers/mode-c-webhook-receiver.ts`: JWKS verify, `requestKey`
  dedup, KS256 sign via `@forestrie/delegation-cose`, `POST …/material`.
- `byok-mode-c-webhook-seal.spec.ts`: genesis forward → coordinator assert →
  `delegation.required` → material → receipt verify vs `publicRoot`.
- Opt-in: `E2E_MODE_C_WEBHOOK_STRETCH=1`; optional
  `E2E_MODE_C_WEBHOOK_PUBLIC_BASE` when deployed coordinator cannot reach
  `127.0.0.1`.

## Run locally

```bash
doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e \
  exec playwright test tests/system/byok-mode-c-webhook-seal.spec.ts
```

Set `E2E_MODE_C_WEBHOOK_STRETCH=1` in Doppler or the shell.

## Operations

If coordinator forward fails after genesis write, see
[ops-0011-canopy-coordinator-forward-orphan-recovery.md](https://github.com/forestrie/devdocs/blob/main/ops/ops-0011-canopy-coordinator-forward-orphan-recovery.md)
(FOR-125).
