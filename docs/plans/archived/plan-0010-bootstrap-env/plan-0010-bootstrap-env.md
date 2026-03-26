# Plan 0010: Bootstrap env vars and secrets (Cloudflare)

**Status**: SUPERSEDED (archived) — Use Custodian for token source; see [plan-0011-custodian-integration-and-current-state.md](../../plan-0011-custodian-integration-and-current-state.md).  
**Date**: 2026-03-15  
**Related**: [Plan 0010 deploy and test](../../plan-0010-deploy-and-test-on-branch.md), [ADR-0002](../../adr-0002-delegation-signer-local-test-key.md)

This doc describes how to set **DELEGATION_SIGNER_URL**, **ROOT_LOG_ID**, and **DELEGATION_SIGNER_BEARER_TOKEN** for the canopy-api worker so bootstrap mint and grant flow work against a deployed delegation-signer.

---

## Where to set them

| Variable | Set in | Where |
|--------|--------|--------|
| **DELEGATION_SIGNER_URL** | canopy-api | Wrangler **vars** (or Cloudflare dashboard → Workers → canopy-api-dev → Settings → Variables). |
| **ROOT_LOG_ID** | canopy-api | Wrangler **vars** (or Cloudflare Variables). |
| **DELEGATION_SIGNER_BEARER_TOKEN** | canopy-api | **Secret** only (Cloudflare dashboard → Workers → canopy-api-dev → Settings → Secrets, or `wrangler secret put DELEGATION_SIGNER_BEARER_TOKEN`). |

The **delegation-signer** worker does **not** store or configure this token. It only requires that callers send a `Bearer` token; it then uses that same token to call GCP KMS for signing. So the token is configured **only on canopy-api** (as the secret it sends when calling the delegation-signer).

---

## Values to use

### DELEGATION_SIGNER_URL

Base URL of the delegation-signer worker (no trailing slash).

- **Dev**: `https://api-dev.forestrie.dev/canopy/delegation-signer`
- **Prod**: `https://api.forestrie.dev/canopy/delegation-signer`

These match the routes in `packages/apps/delegation-signer/wrangler.jsonc` (pattern `api-dev.forestrie.dev/canopy/delegation-signer/*` and `api.forestrie.dev/canopy/delegation-signer/*`).

### ROOT_LOG_ID

The root log identifier for bootstrap. Either:

- **32 hex chars** (e.g. UUID without dashes): `123e4567e89b12d3a456426614174000`
- **64 hex chars** (full 32-byte id): e.g. `00000000000000000000000000000000123e4567e89b12d3a456426614174000`

The wrangler dev config uses an example value (`123e4567e89b12d3a456426614174000`); you can override it via Cloudflare vars or replace it with your chosen root log id.

### DELEGATION_SIGNER_BEARER_TOKEN (secret)

**What it is:** In the current implementation, the delegation-signer uses the Bearer token from the request **as the GCP access token** when calling Cloud KMS. So this value must be a **valid GCP access token** that has:

- `roles/cloudkms.signerVerifier` on the KMS key(s) used for bootstrap (dev: `log-root-signing-secp256r1-forest-dev-1` for ES256, or secp256k1 for KS256)
- `roles/cloudkms.publicKeyViewer` on the same key(s) if canopy-api fetches the public key without a separate token

**How to obtain a GCP access token:**

1. **Short-lived (e.g. 1 hour), manual:**  
   Using a service account key or gcloud:  
   `gcloud auth print-access-token`  
   (or from a key file: use the Google Auth Library to get an access token.)  
   Then set it as the secret. You must rotate it before expiry (e.g. via a cron that updates the Cloudflare secret).

2. **Automated / production (recommended):**  
   Use a **token refresh pipeline** that runs inside GCP and impersonates the same **delegation-signer** service account that the arbor sealer uses (see [Best practice: token refresh pipeline](#best-practice-token-refresh-pipeline) below). No long-lived keys in Cloudflare; the pipeline obtains a short-lived token and updates the Cloudflare Worker secret via the Cloudflare API.

**Is it configured in the delegation-signer service?**  
No. The token is **not** stored in the delegation-signer worker. You configure it **only on canopy-api** as the secret `DELEGATION_SIGNER_BEARER_TOKEN`. Canopy-api sends it in the `Authorization: Bearer <token>` header when calling the delegation-signer; the delegation-signer forwards that token to GCP KMS. So the same token must be a valid GCP access token with the KMS permissions above.

---

## Wrangler config (canopy-api)

In `packages/apps/canopy-api/wrangler.jsonc`, the **dev** env already has:

- `DELEGATION_SIGNER_URL`: `https://api-dev.forestrie.dev/canopy/delegation-signer`
- `ROOT_LOG_ID`: placeholder `00000000000000000000000000000000` (replace with your value)

Do **not** put the token in wrangler (it would be committed). Set it only as a **secret**:

```bash
cd packages/apps/canopy-api
wrangler secret put DELEGATION_SIGNER_BEARER_TOKEN --env dev
# Paste the GCP access token when prompted.
```

---

## Optional: public key fetch

If canopy-api needs to fetch the bootstrap public key without sending a Bearer (e.g. from a context that doesn’t have the token), you can set **DELEGATION_SIGNER_PUBLIC_KEY_TOKEN** on the delegation-signer (or the same token on canopy-api as **DELEGATION_SIGNER_PUBLIC_KEY_TOKEN**). In practice, bootstrap verification uses the same delegation-signer URL and the same token, so **DELEGATION_SIGNER_BEARER_TOKEN** is usually enough.

---

## Best practice: token refresh pipeline

**Problem:** Canopy-api runs as a Cloudflare Worker and cannot use GCP Workload Identity. The arbor sealer runs in GKE and obtains a token by impersonating the **delegation-signer** GCP service account (see `forest-1/infra/kms.tf`: sealer SA has `roles/iam.serviceAccountTokenCreator` on the delegation-signer SA; sealer uses `impersonate.CredentialsTokenSource` in `arbor/services/sealer/src/gcp_token.go`). The Worker needs the same effective token (a GCP access token for the delegation-signer SA) to call the delegation-signer, which forwards it to KMS.

**Best practice:** Run a **token refresh job inside GCP** that:

1. Uses an identity that can **impersonate** the existing **delegation-signer** service account (same as the sealer).
2. Obtains a **short-lived** GCP access token (e.g. 55–60 minutes) for that SA.
3. Updates the Cloudflare Worker secret **DELEGATION_SIGNER_BEARER_TOKEN** for canopy-api via the [Cloudflare API](https://developers.cloudflare.com/api/operations/workers-secret-put-secret) (or `wrangler secret put` in CI).

**Why this is best practice:**

- **No long-lived keys in Cloudflare** – Only short-lived tokens are stored; they are refreshed before expiry.
- **Same trust model as the sealer** – The token is for the same delegation-signer SA that already has KMS permissions in `forest-1/infra/kms.tf`; no new KMS IAM is required.
- **No service account keys** – The refresh job uses Workload Identity (or another token source in GCP), not a JSON key file.
- **Consistent with existing infra** – forest-1 already defines the delegation-signer SA and who may impersonate it (sealer); you extend that to one more principal (the token-syncer).

**Implementation options:**

| Option | Where | How |
|--------|--------|-----|
| **A. GKE CronJob (forest-1)** | Same GKE cluster that runs the sealer | Create a GCP SA (e.g. `canopy-api-token-syncer`) with `roles/iam.serviceAccountTokenCreator` on the delegation-signer SA. Bind it via Workload Identity to a K8s SA. CronJob (e.g. every 50 min) runs a small image that: uses ambient credentials → impersonates delegation-signer → gets token → calls Cloudflare API to set the secret. Store Cloudflare API token in a K8s Secret. |
| **B. GitHub Actions scheduled workflow** | Canopy repo | Grant a GCP SA (or the existing flux_sa) `roles/iam.serviceAccountTokenCreator` on the delegation-signer SA. Scheduled workflow uses OIDC to authenticate to GCP, impersonates delegation-signer, gets token, then updates Cloudflare secret via API or `wrangler secret put`. No new workload in forest-1. |
| **C. Cloud Run Job + Cloud Scheduler** | GCP (no GKE) | Run a small Cloud Run Job on a schedule; its SA has TokenCreator on delegation-signer. Job fetches token and updates Cloudflare secret. |

**Recommendation:** Prefer **A (GKE CronJob)** if forest-1 is the canonical place for IAM and key lifecycle; the token syncer is infra and lives next to the sealer. Use **B** if you prefer to keep all canopy automation in the canopy repo and avoid adding workloads to forest-1.

**Terraform (forest-1) for option A:** In `forest-1/infra/kms.tf` (or `iam.tf`), add a new service account for the token syncer and grant it `roles/iam.serviceAccountTokenCreator` on `google_service_account.delegation_signer`. Add a Workload Identity binding so a K8s SA (e.g. in `canopy` or `forestrie-dev` namespace) can act as that GCP SA. The CronJob and Secret (Cloudflare API token) can be managed via Flux or a separate manifest repo.
