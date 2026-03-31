---
Status: DRAFT
Date: 2026-03-31
Related:
  - [plan-0015](plan-0015-custody-grant-signing-canopy-api.md)
  - [plan-0011](plan-0011-custodian-integration-and-current-state.md)
---

# Plan 0017 — Custodian custody key sign IAM (`useToSign`)

## Root cause (from live logs)

`kubectl logs -n forestrie-dev deployment/custodian` (2026-03-31) shows custody
Sign1 failing with:

```text
Permission 'cloudkms.cryptoKeyVersions.useToSign' denied on resource
'projects/forest-dev-1/locations/europe-west2/keyRings/forestrie-custody-forest-dev-1/cryptoKeys/<32-hex-id>'
```

Custodian returns HTTP **500** with Problem title **signing failed** (empty
`detail`); the real error is only in pod logs (`build cose sign1`).

**Behaviour**

- `POST /api/keys` creates the CryptoKey and grants **`roles/cloudkms.signerVerifier`**
  to **CUSTODY_SIGNER_SA_EMAIL** only (plus optional **publicKeyViewer** for
  **CUSTODIAN_RUNTIME_SA_EMAIL** when set).
- `POST /api/keys/{keyId}/sign` uses **application default credentials** (the
  Custodian pod’s GCP service account via Workload Identity), **not** impersonation
  of `custody_signer`.
- That runtime identity therefore needs **`useToSign`** on the CryptoKeyVersion.

**Why bootstrap still works:** `:bootstrap` signing uses
**BOOTSTRAP_KMS_CRYPTO_KEY_ID**, where Custodian’s SA already has matching IAM
(see `forest-1` `custodian_kms_sign_bootstrap_secp256r1`).

## Fix options (pick one primary + optional belt-and-suspenders)

### A — Per-key IAM in Custodian (recommended with explicit SA)

In `arbor/services/custodian/src/kms_create.go`, when
**`CUSTODIAN_RUNTIME_SA_EMAIL`** is non-empty, grant on the **new** CryptoKey:

- `roles/cloudkms.signerVerifier` (not only `publicKeyViewer`)

for `serviceAccount:{CUSTODIAN_RUNTIME_SA_EMAIL}`.

**Ops:** set **`CUSTODIAN_RUNTIME_SA_EMAIL`** in the Custodian Deployment/ConfigMap
to the same email as the Custodian GSA (e.g.
`forest-dev-1-custodian@forest-dev-1.iam.gserviceaccount.com`), matching
**`forest-1`** `google_service_account.custodian.email`.

**Pros:** Least surprise, aligns “who calls KMS sign” with “who has signerVerifier”.
**Cons:** Must deploy env + new Custodian image; each key gets two signer holders
(Custodian + custody_signer).

### B — Key ring IAM in Terraform (`forest-1`)

Add **`google_kms_key_ring_iam_member`** on the custody **key ring** with
**`roles/cloudkms.signerVerifier`** for **`google_service_account.custodian`**.

**Pros:** One Terraform change; covers all custody keys (including old keys) without
per-key updates.
**Cons:** Broader: Custodian can sign **every** key in that ring.

### C — Sign via impersonated `custody_signer` (larger change)

Change the sign path to obtain credentials as **CUSTODY_SIGNER_SA_EMAIL** (token
or impersonation) before `AsymmetricSign`. **Not** required if A or B is acceptable.

## Further investigation (if A/B do not clear the failure)

1. **Confirm WI binding**
   - `kubectl -n forestrie-dev get sa custodian -o yaml` → `iam.gke.io/gcp-service-account`
   - Must equal `forest-dev-1-custodian@forest-dev-1.iam.gserviceaccount.com` (or
     whatever `forest-1` defines).

2. **Effective IAM**
   - `gcloud kms keys versions get-iam-policy` / keys get-iam-policy on a failing
     CryptoKey id; compare with key ring policy.

3. **Org policies / denies**
   - Rare, but `useToSign` can be blocked by deny or constraints.

4. **Observability**
   - Optionally include a redacted `error` snippet in Problem `detail` for 500
     signing failures (dev-only or behind flag) so e2e does not rely only on logs.

## Suggested sequence

1. Implement **A** (code) + set **CUSTODIAN_RUNTIME_SA_EMAIL** in **arbor-flux**
   (or equivalent) for dev/prod.
2. Optionally add **B** if you want ring-level guarantee without relying on
   per-key Grants after key create.
3. Re-run **`bootstrap-child-auth-grant`** e2e with Doppler.
