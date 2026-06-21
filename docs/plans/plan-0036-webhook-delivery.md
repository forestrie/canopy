# plan-0036 — Coordinator webhook delivery (FOR-93)

**Status:** IMPLEMENTED  
**Linear:** FOR-93  
**Related:** [ADR-0005](../adr/adr-0005-delegation-webhook-delivery.md),
[ADR-0006](../adr/adr-0006-webhook-source-authentication.md),
[arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md)

## Summary

Delegation-coordinator emits signed `delegation.required` v1 webhooks on
`POST /api/delegations` material miss (pending insert). Delivery uses ADR-0005
B+C: `ctx.waitUntil` attempt 0 + DO `alarm()` retry ladder. Source auth per
ADR-0006: ES256 coordinator identity key (Secrets Store in deploy, PEM in
vitest), public key at `GET /api/coordinator/webhook-signing-key`.

## Ops — webhook signing key

Account-level coordinator ES256 identity key (ADR-0006). Canonical PEM in
**Doppler `canopy` `dev` + `prd`** (same value); CI pushes to Cloudflare Secrets
Store before coordinator deploy.

```bash
# 1. Generate + store PEM (once, idempotent)
doppler run --project canopy --config dev -- task cf:coordinator:bootstrap-webhook-signing-key

# 2. Sync PEM to GitHub Environment secrets (dev + prod, same PEM)
gh secret set WEBHOOK_SIGNING_KEY_PEM --env dev --repo forestrie/canopy
gh secret set WEBHOOK_SIGNING_KEY_PEM --env prod --repo forestrie/canopy

# 3. Push to Cloudflare Secrets Store (or rely on deploy-workers CI)
doppler run --project canopy --config dev -- task cf:coordinator:ensure-webhook-signing-key
```

- **Store:** `forestrie-coordinator` (Secrets Store)
- **Secret:** `webhook-signing-key` (PKCS#8 ES256 PEM)
- **Worker binding:** `WEBHOOK_SIGNING_KEY` in `wrangler.jsonc` (`secrets_store_secrets`)
- **Deploy gate:** `deploy-workers.yml` requires `WEBHOOK_SIGNING_KEY_PEM` and runs ensure before `wrangler deploy`

Local dev without Secrets Store: `WEBHOOK_SIGNING_KEY_PEM` via Doppler or
`wrangler dev --var`.

## Config

| Var | Default | Purpose |
|-----|---------|---------|
| `COORDINATOR_PUBLIC_URL` | from `DELEGATION_COORDINATOR_URL` at deploy | `materialSubmitUrl` in events |
| `WEBHOOK_RETRY_LADDER` | `[1,2,4,8]` | Retry multipliers |
| `WEBHOOK_RETRY_SCALE_MS` | `1000` | Base backoff ms |

## Out of scope (follow-ups)

- FOR-91: canopy-api kill-switch admin + serving suppression on issue path
- FOR-98: mandate-agent webhook receiver + signature verify
