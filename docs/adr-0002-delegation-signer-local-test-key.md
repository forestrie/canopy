# ADR-0002: Delegation-signer local testing and test-only key

**Status**: SUPERSEDED  
**Date**: 2026-03-14  
**Superseded**: 2026-04-15 — delegation-signer has been removed. Sealer now obtains
delegation certificates directly from Custodian via the per-log delegation API
(`POST /api/keys/{logId}/sign?log-id=true`). See
[Plan 0016](plans/plan-0016-delegation-signer-custodian-migration.md).  
**Related**: [Plan 0010](plans/plan-0010-deploy-and-test-on-branch.md), [Subplan 04](docs/plans/plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md)

## Context

The delegation-signer Worker signs bootstrap (and parent) grants using GCP Cloud KMS. When running locally (`wrangler dev`), the same code path is used: the Worker receives a Bearer token from the caller (canopy-api) and uses that token to call `cloudkms.googleapis.com` for asymmetric sign and get public key. So:

- **Using the deployed delegation-signer from local canopy-api**: Configure `DELEGATION_SIGNER_URL` to the deployed worker URL and `DELEGATION_SIGNER_BEARER_TOKEN` to the secret the deployed worker expects. No local KMS access is needed.
- **Running delegation-signer locally with real KMS**: The token passed by canopy-api to the local Worker is used as the GCP access token for KMS. So that token must be a valid GCP access token (e.g. from `gcloud auth application-default print-access-token` or a service account) with **roles/cloudkms.signerVerifier** (and for public key, **roles/cloudkms.publicKeyViewer**) on the same key. Many devs do not have that permission on the project’s root keys, so local bootstrap flow fails with 401/403 from KMS.

We want to support full local bootstrap flow (mint → register → poll → resolve) without requiring GCP KMS access.

## Decision

1. **Treat local KMS 401/403 as a permissions issue**: The identity behind the token (e.g. Application Default Credentials when running locally) must have KMS signer and public-key viewer on the keys configured in the Worker’s env. This is documented; no code change.
2. **Add an optional test-key mode** in the delegation-signer:
   - When **DELEGATION_SIGNER_USE_TEST_KEY=1** (or `true`), the Worker uses a **well-known test-only secp256k1 key** for:
     - **POST /api/delegate/bootstrap**: sign the digest in-process (no KMS call).
     - **GET /api/public-key/:bootstrap?alg=KS256**: return the test key’s public key (PEM) without calling KMS; token optional in this mode for convenience.
   - Optional **DELEGATION_SIGNER_TEST_KEY_PRIVATE_HEX**: 64 hex chars (32-byte private key). If unset, a fixed well-known test key is used (documented in code and ADR).
   - Test-key mode is for local/dev only; never enable in production.
3. **Task support**: Add a task (e.g. `wrangler:dev:delegation-signer`) that starts the delegation-signer with test-key mode and document the env vars for canopy-api (e.g. `DELEGATION_SIGNER_URL=http://localhost:8791`, `DELEGATION_SIGNER_BEARER_TOKEN=test`, `ROOT_LOG_ID=…`) so the full bootstrap flow can be run locally without GCP KMS.

## Bootstrap algorithm: ES256 default, KS256 optional

Bootstrap signing **defaults to ES256** (P-256). The delegation-signer accepts an optional `alg` in the POST /api/delegate/bootstrap body (`"ES256"` or `"KS256"`); GET /api/public-key/:bootstrap uses query `?alg=ES256` (default) or `?alg=KS256`. Canopy-api requests the key with the same alg used for the mint and verifies with the matching curve (Web Crypto for P-256, viem for secp256k1). **KS256** remains available for EVM compatibility when requested explicitly.

## Consequences

- Local bootstrap testing does not require GCP KMS permissions when using test-key mode.
- Verifiers (canopy-api, e2e, k6) that need to validate bootstrap grants must use the same well-known public key when talking to a test-key delegation-signer; the public key is deterministic, so no extra config if they fetch it from GET /api/public-key/:bootstrap.
- K6 and e2e can run against a local stack (canopy-api + local delegation-signer in test-key mode) without any GCP credentials.
