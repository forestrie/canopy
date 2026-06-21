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

1. Generate P-256 PKCS#8 PEM: `openssl ecparam -genkey -name prime256v1 -noout -out webhook.pem`
2. Create Cloudflare Secrets Store `forestrie-coordinator` (account-level).
3. Upload PEM as secret `webhook-signing-key`.
4. Wrangler binding `WEBHOOK_SIGNING_KEY` is configured in `wrangler.jsonc`
   (`secrets_store_secrets`).

Local dev without Secrets Store: set `WEBHOOK_SIGNING_KEY_PEM` via Doppler or
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
