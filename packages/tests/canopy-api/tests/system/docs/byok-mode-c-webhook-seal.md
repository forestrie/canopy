# Mode C webhook-driven BYOK checkpoint seal

**Spec:** [`byok-mode-c-webhook-seal.spec.ts`](../byok-mode-c-webhook-seal.spec.ts)  
**Playwright project:** `system` (default tier — Package D / FOR-126)  
**Linear:** [FOR-201](https://linear.app/forestrie/issue/FOR-201)

## What this proves

Unlike [`byok-checkpoint-seal.spec.ts`](../byok-checkpoint-seal.spec.ts) (runner
polls `pending-delegation` and signs material), this spec exercises the
**webhook push path**:

1. `POST /api/forest/{R}/genesis?webhookUrl=` forwards coordinator
   `public-root` + `webhook` (plan-0037).
2. Coordinator `POST /api/delegations` miss → `202` → signed
   `delegation.required` webhook delivered to a **public HTTPS URL**.
3. In-repo receiver verifies JWKS signature, signs KS256 material, `POST`s
   `/api/delegations/certificate`.
4. Sealer checkpoint + receipt; delegation cert verifies against registered
   `publicRoot`.

## Push vs pull

| Path | When | Meaning |
|------|------|---------|
| **Webhook push** | Default CI and local runs | Coordinator POSTs `delegation.required` to registered URL; receiver signs material |
| **Pending-delegation pull** | `E2E_MODE_C_ALLOW_PULL_FALLBACK=1` only | Test polls `GET …/pending-delegation` and signs (ADR-0005 backstop); local debug |

Default tier **requires push**. Pull without the opt-in env throws.

## Env

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `DELEGATION_COORDINATOR_URL` | yes | Coordinator + JWKS |
| `COORDINATOR_APP_TOKEN` | yes | Certificate POST auth |
| `CANOPY_OPS_ADMIN_TOKEN` | yes | Onboard token mint |
| `E2E_MODE_C_WEBHOOK_PUBLIC_BASE` | no | Manual public base (ngrok); skips auto cloudflared |
| `E2E_MODE_C_ALLOW_PULL_FALLBACK` | no | Local only: allow pending-delegation pull when push fails |

**CI:** `cloudflared` quick tunnel starts automatically when
`E2E_MODE_C_WEBHOOK_PUBLIC_BASE` is unset (`tests-system.yml`).

## Run

```bash
doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/byok-mode-c-webhook-seal.spec.ts

# Local pull backstop (debug only — not CI)
E2E_MODE_C_ALLOW_PULL_FALLBACK=1 doppler run --project canopy --config dev -- \
  pnpm --filter @canopy/api-e2e exec playwright test \
  tests/system/byok-mode-c-webhook-seal.spec.ts
```

## Prerequisites

Run `task test:e2e:preflight` (validates `CANOPY_OPS_ADMIN_TOKEN`, coordinator
env, Univocity provision). See [FOR-202](https://linear.app/forestrie/issue/FOR-202).
