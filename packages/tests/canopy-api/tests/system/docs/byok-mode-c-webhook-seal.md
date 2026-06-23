# Mode C webhook-driven BYOK checkpoint seal

**Spec:** [`byok-mode-c-webhook-seal.spec.ts`](../byok-mode-c-webhook-seal.spec.ts)  
**Opt-in:** `E2E_MODE_C_WEBHOOK_STRETCH=1`  
**Linear:** FOR-76

## What this proves

Unlike [`byok-checkpoint-seal.spec.ts`](../byok-checkpoint-seal.spec.ts) (runner
polls `pending-delegation` and signs material), this spec exercises the
**push** path:

1. `POST /api/forest/{R}/genesis?webhookUrl=` forwards coordinator
   `public-root` + `webhook` (plan-0037).
2. Coordinator `POST /api/delegations` miss → `202` → signed
   `delegation.required` webhook.
3. In-repo receiver verifies JWKS signature, signs KS256 material, `POST`s
   `/api/delegations/material`.
4. Sealer checkpoint + receipt; delegation cert verifies against registered
   `publicRoot`.

## Env

| Variable                         | Required | Purpose                                                   |
| -------------------------------- | -------- | --------------------------------------------------------- |
| `E2E_MODE_C_WEBHOOK_STRETCH`     | `1`      | Enable spec                                               |
| `DELEGATION_COORDINATOR_URL`     | yes      | Coordinator + JWKS                                        |
| `COORDINATOR_APP_TOKEN`          | yes      | Material POST auth                                        |
| `CANOPY_OPS_ADMIN_TOKEN`         | yes      | Onboard token mint                                        |
| `E2E_MODE_C_WEBHOOK_PUBLIC_BASE` | no       | Public URL base when coordinator cannot reach `localhost` |

## Run

```bash
E2E_MODE_C_WEBHOOK_STRETCH=1 \
  doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/byok-mode-c-webhook-seal.spec.ts
```
