# ADR-0006 — Webhook source authentication (asymmetric ES256)

**Status:** ACCEPTED
**Date:** 2026-06-21
**Related:**
[arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md),
[ADR-0005 delegation webhook delivery](adr-0005-delegation-webhook-delivery.md),
[arc-checkpoint-delegation-isolation.md](../arc/arc-checkpoint-delegation-isolation.md)

---

## Context

When the delegation-coordinator delivers a `delegation.required` event (ADR-0005),
the operator webhook (`mandate-agent`) must verify that the POST genuinely
originated from Forestrie's coordinator. The payload is **not sensitive**
(isolation ARC); the requirement is **integrity + source authentication**, not
confidentiality.

The registration ARC initially assumed **per-log symmetric HMAC** secrets
(`webhook_secret_hash`). That pattern fits closed systems where the producer
controls both ends. Here the consumer runs on **operator-owned infrastructure**
(FOR-99: independent Cloudflare account). Standard Webhooks guidance applies:
when the producer does not control consumer security, **asymmetric** signing is
preferred.

Forestrie already standardises on **ES256 (P-256)** for COSE and trust roots;
`mandate-agent` verifies ES256 material today.

## Options

### A. Per-log symmetric HMAC (original ARC)

Coordinator generates a random secret per log, stores it, returns it once at
registration; receiver verifies `HMAC-SHA256(body, secret)`.

- + Simple receiver libraries (Standard Webhooks `v1`).
- − Shared-secret sprawl across independent operators; rotation requires
  re-registration per log; producer does not control consumer infra.

### B. Asymmetric ES256 — single coordinator identity key (local sign)

One P-256 key pair for the coordinator service. Private key in Cloudflare
Secrets Store (write-only, centrally rotatable); coordinator signs outbound
webhooks via **Web Crypto** in the Worker (no network hop). Public key published
at a coordinator endpoint; receivers verify ECDSA over a canonical signed string.

- + No per-log secret distribution; receiver needs only the public key.
- + Aligns with ES256 trust-root tooling mandate already uses.
- + Signing stays on the delivery hot path inside the Worker (ADR-0005 B+C).
- − New public-key publication endpoint (FOR-93); signature format must be
  documented.

### C. Asymmetric via custodian/KMS

Dedicated non-log KMS key; coordinator calls custodian `POST /api/keys/{id}/sign`
on each delivery.

- + Hardware-backed private key.
- − Cross-cloud sync dependency (Worker → GKE → KMS) on every webhook attempt;
  custodian keys are per-log custody keys today, not a service identity; no JWKS.

## Decision

Adopt **B**: **one coordinator ES256 identity key**, sign locally in the Worker,
publish the public key for verification. **No per-log webhook secret** is stored
in FOR-92 CRUD — the `log_delegation_config` row holds only `webhook_url` and
`enabled`.

Key material lifecycle (generation, Secrets Store binding, public-key GET,
signature header format on delivery) is **FOR-93** scope. This ADR commits the
authentication model so FOR-92 storage and docs are correct before delivery
lands.

### Signature shape (target for FOR-93)

Integrity over the raw JSON body plus freshness (separate from idempotency):

- `X-Forestrie-Webhook-Timestamp` — Unix seconds.
- `X-Forestrie-Webhook-Signature` — ES256 over a canonical string such as
  `{timestamp}.{rawBody}` (exact construction specified in FOR-93).

Receivers verify with the coordinator's published P-256 public key (COSE or PEM).

## Consequences

- [arc-univocity-instance-registration.md](../arc/arc-univocity-instance-registration.md)
  corrected: `log_delegation_config` table replaces `signing_routes` webhook
  columns; HMAC header replaced by ES256 signature header.
- FOR-92 implements CRUD + storage only; no signing secret fields.
- FOR-93 adds Secrets Store binding, public-key endpoint, and signs deliveries.
- Custodian/KMS is **not** on the webhook delivery path unless a future ADR
  revisits hardware custody requirements.
