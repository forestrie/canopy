# Plan 0011: Custodian integration and current state (canopy)

**Status**: DRAFT  
**Date**: 2026-03-17  
**Related**: [Plan 0004 log bootstrapping](plan-0004-log-bootstraping/overview.md), [Subplan 08 grant-first bootstrap](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [Subplan 04 delegation-signer in Canopy](plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md), [archived plan-0001](archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md), [archived plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md), devdocs [Plan 0013 Custodian](https://github.com/forestrie/devdocs/blob/main/plans/plan-0013-custodian-implementation.md)

## 0. Auth model: grantData and signer endorsement (Univocity contract alignment)

The Univocity contracts enforce that **the first checkpoint for any log** is signed by the key **endorsed in the grant’s grantData**. Canopy currently mints the **bootstrap grant** with **empty grantData**, which does not match the contract and will cause the root’s first checkpoint to revert. This section summarizes the contract auth model and gives an agent-optimised plan to align canopy.

### 0.1 Contract auth model (Univocity)

**Source:** `univocity/src/contracts/_Univocity.sol`, `ImutableUnivocity.sol`, `interfaces/types.sol` (PublishGrant.grantData); design: `docs/plans/plan-0026-verify-only-no-recovery.md`, `plan-0027-abstract-base-bootstrap-pattern.md`, `adr/adr-0005-grant-constrains-checkpoint-signer.md`.

- **First checkpoint to a log:** The consistency receipt must be signed by the key that is **supplied in the grant’s grantData** (verify-only; no on-chain recovery). That key is then stored as the log’s `rootKey` for all future checkpoints.
- **Root’s first checkpoint (bootstrap):** `grantData` must be **exactly 64 bytes** (ES256) and **equal to the bootstrap key bytes** (`keccak256(grantData) == keccak256(bootstrapKey)`). So the bootstrap grant must have `grantData = bootstrap public key` (64 bytes: P-256 x || y, no 04 prefix). See `_checkpointSignersES256` and `_verifyCheckpointSignatureES256` (root branch): `GrantDataInvalidKeyLength`, `GrantDataMustMatchBootstrap`.
- **Non-root first checkpoint (child auth or data log):** The grant that authorizes creation (included in the parent log) must have `grantData` = the **public key of the signer** that will sign this log’s first checkpoint. That key is stored as the new log’s `rootKey`. So the grant **endorses** a specific checkpoint signer; the contract ensures the first checkpoint is signed by that key.
- **Hierarchy:** M0 = root authority log; B1 = bootstrap grant (first leaf in M0). CP0 in M0 is authorized by B1 (self-referencing); the receipt is signed by the bootstrap key; B1 must have `grantData = bootstrap key`. For a child log M1, a grant Gn in M0 authorizes creation; Gn must have `grantData = signer of CP0 in M1`. Univocity does not care who appends leaves; it only enforces that **checkpoint publishers** (first and subsequent) match the key from the grant (first) or stored rootKey (later).

**Enforceability and viability:** The model is enforced on-chain: wrong or missing grantData on first checkpoint reverts. Canopy must produce grants whose grantData matches this contract so that when the sealer (or any submitter) publishes the first checkpoint, the contract accepts it.

### 0.2 Current canopy gap

- **Bootstrap grant** (`packages/apps/canopy-api/src/scrapi/bootstrap-grant.ts`): the grant is built with `grantData: new Uint8Array(0)`. The contract expects `grantData.length == 64` and `keccak256(grantData) == keccak256(bootstrapKey)` for the root’s first checkpoint. So **canopy is incorrect**: the root’s first checkpoint will revert with `GrantDataInvalidKeyLength(0)`.
- **Child-log grants:** When canopy (or paid-grant flow) creates grants for non-root logs (subplan 06), those grants must set `grantData` to the endorsed signer’s public key (64 bytes ES256 or 20 bytes KS256). Not yet implemented; required when first-checkpoint publishing is implemented for child logs.

### 0.3 Agent-optimised alignment plan

| Step | Action | Input | Output | Location | Verification |
|------|--------|-------|--------|----------|--------------|
| **0.1** | Fetch bootstrap public key before building grant | `BootstrapMintEnv` (delegation-signer URL, optional token) | 65-byte uncompressed (04\|\|x\|\|y) or 64-byte (x\|\|y) | `bootstrap-grant.ts`: call `getBootstrapPublicKey(env)` (or equivalent) **before** building the grant payload. Reuse `getBootstrapPublicKey` from `bootstrap-public-key.ts`; ensure env has `delegationSignerUrl` and optional `delegationSignerPublicKeyToken`. | Key bytes available for grantData. |
| **0.2** | Normalize to 64 bytes (ES256) for grantData | Public key bytes (65 or 64) | 64 bytes (x \|\| y) | If length 65 and first byte 0x04, strip prefix: `keyBytes.slice(1, 65)`. If length 64, use as-is. Contract expects 64 for ES256 (see `_decodeLogRootKeyES256`, `_checkpointSignersES256`). | grantData.length === 64. |
| **0.3** | Build bootstrap grant with grantData = bootstrap key | 64-byte key from 0.2 | Grant object with `grantData` set | In `handlePostBootstrapGrant`, set `grant.grantData = bootstrapKey64` instead of `new Uint8Array(0)`. Build payload **after** grantData is set (payload is hashed for signature). | Leaf commitment includes grantData; contract will accept root’s first checkpoint when grant is used. |
| **0.4** | Preserve signature flow | Grant with grantData set | Same as today: encode payload → digest → POST /api/delegate/bootstrap → build COSE Sign1 | No change to delegation-signer call. Payload now includes grantData, so digest and signature differ from current (wrong) grant. | Bootstrap grant verifies with bootstrap key; grantData in stored/transmitted grant matches contract. |
| **0.5** | (Optional) KS256 bootstrap | If alg === KS256 | grantData 20 bytes (address) | Contract: KS256 first checkpoint expects `grantData.length == 20`. If canopy supports KS256 bootstrap, set grantData to 20-byte address from delegation-signer or config. | Only if KS256 bootstrap is in scope. |
| **0.6** | Child-log grants (subplan 06) | When creating grants for non-root logs | grantData = endorsed signer public key (64 or 20) | When implementing paid-grant / settlement → grant creation, set `grantData` to the public key of the signer that will sign the first checkpoint for that log (e.g. parent auth log key or per-log key). Document in subplan 06. | First checkpoint for child log succeeds when published with that signer. |

**Order of operations (bootstrap mint):** (1) Fetch bootstrap public key (GET /api/public-key/:bootstrap or reuse cached). (2) Normalize to 64 bytes. (3) Build grant with `grantData = bootstrapKey64`. (4) Encode payload, compute digest, call POST /api/delegate/bootstrap, build transparent statement. (5) Return 201 with statement. No change to register-grant or register-signed-statement **logic**; the fix is that the **bootstrap grant** they accept and sequence must contain the correct grantData so that when the first checkpoint is published to the contract, the decoded grant matches the contract’s expectations.

**Files to touch:** `packages/apps/canopy-api/src/scrapi/bootstrap-grant.ts` (fetch key, normalize, set grantData). Optionally `bootstrap-public-key.ts` (export or use a 64-byte form if only 65-byte is returned). Tests: update bootstrap-grant and any flow tests to assert grantData length 64 and, if possible, match delegation-signer public key.


## 1. Where we are (minimal)

| Area | State |
|------|--------|
| **Register-grant and register-statement auth** | Done (Plan 0001, archived). Grant-based auth: `Authorization: Forestrie-Grant <base64>`, locate → retrieve from R2 → verify signer; receipt-based inclusion when `inclusionEnv` set. See [archived plan-0001](archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md). |
| **Bootstrap grant mint** | Implemented. POST /api/grants/bootstrap builds grant, calls **delegation-signer** POST /api/delegate/bootstrap with a **Bearer token** (GCP access token for delegation-signer SA), returns transparent statement. No server-side storage. |
| **Delegation-signer** | In Canopy (Cloudflare). Holds bootstrap/root KMS key; POST /api/delegate/bootstrap, POST /api/delegate/parent; GET /api/public-key/:bootstrap. Requires Bearer token; uses that token to call GCP KMS. |
| **Token for delegation-signer** | Currently: canopy-api is configured with **DELEGATION_SIGNER_BEARER_TOKEN** (secret). That value must be a **GCP access token** for the delegation-signer SA. Today this implies a long-lived token or a **token refresh pipeline** (cron/scheduled job that impersonates delegation-signer and updates the Cloudflare secret). See [archived plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md). |
| **Custodian (arbor)** | Deployed. Issues short-lived GCP tokens: **POST /api/token/bootstrap** (bootstrap app token → token for delegation_signer SA), **POST /api/token** (normal app token + key_owner_id → token for custody_signer SA). Also: create key (POST /api/keys), list keys by labels (POST /api/keys/list), delete key / delete key versions (bootstrap-only). No canopy integration yet. |

## 2. What is needed on canopy to use Custodian for bootstrap and auth

### 2.1 Bootstrap path (replace long-lived / cron token)

**Goal:** Canopy-api obtains the Bearer token used when calling the delegation-signer from **Custodian** instead of from a static secret or a token-refresh pipeline.

**Current flow:**  
Canopy-api has `DELEGATION_SIGNER_BEARER_TOKEN`. On POST /api/grants/bootstrap (and when fetching bootstrap public key), it sends that token as `Authorization: Bearer <token>` to the delegation-signer. The delegation-signer forwards the token to GCP KMS.

**New flow:**  
- Add config: **CUSTODIAN_URL**, **CUSTODIAN_BOOTSTRAP_APP_TOKEN** (secret).  
- When handling POST /api/grants/bootstrap (and any path that needs to call the delegation-signer with a valid GCP token):  
  1. Call Custodian **POST /api/token/bootstrap** with `Authorization: Bearer <CUSTODIAN_BOOTSTRAP_APP_TOKEN>`.  
  2. Parse response `{ "access_token": "...", "expires_in": 3600 }`.  
  3. Use `access_token` as the Bearer token when calling the delegation-signer.  
- Optionally **cache** the token in memory (or in a short-lived cache) until near expiry to avoid a Custodian call on every bootstrap mint or public-key fetch.  
- **Remove** (or stop using) **DELEGATION_SIGNER_BEARER_TOKEN** as the source of the token; Custodian becomes the only source.  
- **Retire** any token-refresh pipeline (GKE CronJob, GitHub Actions scheduled, etc.) that was updating the Cloudflare secret for DELEGATION_SIGNER_BEARER_TOKEN.

**Code touchpoints:**  
- `packages/apps/canopy-api/src/index.ts`: bootstrap route and bootstrapEnv construction. Today it reads `env.DELEGATION_SIGNER_BEARER_TOKEN` and passes it to `handlePostBootstrapGrant` and to `bootstrapEnv.delegationSignerBearerToken`. Replace with: obtain token from Custodian (with optional cache), then pass that token.  
- `packages/apps/canopy-api/src/scrapi/bootstrap-grant.ts`: receives `delegationSignerBearerToken`; no change if the caller passes the Custodian-issued token.  
- `packages/apps/canopy-api/src/scrapi/bootstrap-public-key.ts`: used when verifying bootstrap grant (e.g. in register-grant). It calls GET /api/public-key/:bootstrap with optional Bearer. That Bearer must be a valid GCP token (or the delegation-signer’s PUBLIC_KEY_ACCESS_TOKEN). So the same Custodian bootstrap token can be used: ensure any path that calls the delegation-signer (bootstrap mint or public-key fetch) gets the token from the same Custodian + cache layer.

**Verification:**  
- With CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN set, POST /api/grants/bootstrap succeeds without DELEGATION_SIGNER_BEARER_TOKEN.  
- Register-grant with bootstrap branch and register-signed-statement (with grant auth) still work; bootstrap public key fetch uses the Custodian-issued token.

### 2.2 Auth for log creation (register-grant bootstrap branch)

**Goal:** First call that creates the root is allowed when the caller supplies the **bootstrap grant** as auth (signed by the bootstrap key). No change to **who** can create the root; the change is only **how** canopy-api gets the token to call the delegation-signer (Custodian instead of static/cron).

Bootstrap **grant** creation (POST /api/grants/bootstrap) is already covered in §2.1. The **register-grant** bootstrap branch (log not initialized, auth = bootstrap grant) and **register-signed-statement** grant auth are already implemented; they use the same delegation-signer for public key and verification. So once §2.1 is done, **log creation** (first register-grant with bootstrap grant) and **authorization of callers** for register-signed-statement (grant auth + receipt-based inclusion) continue to work; the only difference is the token source for calls to the delegation-signer.

No additional Custodian API is required for “auth log creation” beyond bootstrap token: the bootstrap key remains in the **Canopy** delegation-signer (KMS in Canopy’s GCP); Custodian only provides the **token** for that SA.

### 2.3 Authorize callers to register-signed-statement

**Goal:** Callers present a valid grant (and, when required, receipt proving inclusion). No change to the **auth model**; only the **token** used by canopy-api to talk to the delegation-signer comes from Custodian.

- **register-signed-statement** already requires **Authorization: Forestrie-Grant <base64>** (transparent statement). Canopy resolves the grant, verifies signer matches statement, and when `inclusionEnv` is set verifies receipt-based inclusion.  
- Canopy uses the delegation-signer to **fetch the bootstrap public key** when verifying the bootstrap grant (e.g. in register-grant bootstrap branch). That fetch needs a Bearer token; with §2.1 that token comes from Custodian.  
- So **authorizing callers** for register-signed-statement is unchanged; only the backend dependency (token for delegation-signer) is satisfied via Custodian.

### 2.4 Optional: per-log keys (Custodian) and list keys

For **future** multi–auth-log or dynamic key creation:

- **Create key for a log owner:** Canopy (or an ops flow) could call Custodian **POST /api/keys** with `key_owner_id` (e.g. log id or owner id) and optional **labels** (e.g. `env=prod`, `log_kind=authority`). Custodian creates the key in the custody key ring and sets IAM for the custody_signer SA.  
- **Obtain token for that key:** Canopy would call Custodian **POST /api/token** with `key_owner_id` to get a short-lived token for the custody_signer SA (which can then sign with that key).  
- **List keys:** Custodian **POST /api/keys/list** with `labels` and `predicate` (and/or) returns keys matching labels; useful for ops and for resolving “which key for this log?” if keys are created per log and labeled.

Current Plan 0004 design keeps the **bootstrap** key in the Canopy delegation-signer; **parent** (derived) keys can be resolved via DELEGATION_SIGNER_PARENT_KEYS_JSON or a future key map. If we later move to Custodian-created keys per auth log, canopy would call Custodian for create key + token and the delegation-signer (or a separate signer in arbor using custody_signer) would perform the sign. Out of scope for this minimal assessment.

## 3. Implementation checklist (canopy)

| # | Task | Depends |
|---|------|--------|
| 1 | Add env: **CUSTODIAN_URL**, **CUSTODIAN_BOOTSTRAP_APP_TOKEN** (secret). Document in workers-environments or plan. | — |
| 2 | Implement **fetchDelegationSignerTokenFromCustodian()**: POST CUSTODIAN_URL/api/token/bootstrap with Bearer CUSTODIAN_BOOTSTRAP_APP_TOKEN; return access_token and expires_in. | 1 |
| 3 | Add an **in-memory (or cache) token cache** for the delegation-signer token: key = "bootstrap", value = { access_token, expires_at }. Refresh when near expiry (e.g. 5 min before). | 2 |
| 4 | In **POST /api/grants/bootstrap** path: obtain Bearer token via cache/Custodian (not DELEGATION_SIGNER_BEARER_TOKEN); pass to handlePostBootstrapGrant. | 2, 3 |
| 5 | In **bootstrapEnv** (register-grant, register-signed-statement): when fetching bootstrap public key or calling delegation-signer, use token from cache/Custodian. | 2, 3 |
| 6 | **Config guard**: If CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN are set, require that DELEGATION_SIGNER_BEARER_TOKEN is not used (or ignore it). Prefer Custodian. | 4, 5 |
| 7 | **Docs**: Update [archived plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md) pointer to this plan; document Custodian as the recommended token source in workers-environments or README. | — |
| 8 | **Retire** token-refresh pipeline (if any) once Custodian integration is live. | 4, 5, 6 |

## 4. References

- **§0 (grantData / auth model):** Univocity repo (sibling `../univocity`): `src/contracts/_Univocity.sol` (`_checkpointSignersES256`, `_verifyCheckpointSignatureES256`, root branch grantData checks), `ImutableUnivocity.sol`, `src/interfaces/types.sol` (PublishGrant.grantData); `docs/plans/plan-0026-verify-only-no-recovery.md`, `plan-0027-abstract-base-bootstrap-pattern.md`, `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md`.
- **Archived:** [plan-0001](archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md) (register-grant, grant auth), [plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md) (env vars and token refresh options, superseded by Custodian).
- **Active:** [Plan 0004 overview](plan-0004-log-bootstraping/overview.md), [Subplan 08 grant-first bootstrap](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [Subplan 04 delegation-signer in Canopy](plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md).
- **Custodian API:** arbor services/custodian README and devdocs Plan 0013 (Phase 4 token issuance, Phase 6 canopy-api config).
- **Canopy code:** `packages/apps/canopy-api/src/index.ts`, `scrapi/bootstrap-grant.ts`, `scrapi/bootstrap-public-key.ts`, `scrapi/register-grant.ts`, `scrapi/register-signed-statement.ts`.
