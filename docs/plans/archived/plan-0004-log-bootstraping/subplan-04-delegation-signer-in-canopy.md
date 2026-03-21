# Subplan 04: Delegation-signer in Canopy (architecture clarification)

**Status**: DRAFT  
**Date**: 2026-03-12  
**Parent**: [Subplan 04](subplan-04-signer-delegation-bootstrap-and-parent.md), [Plan 0004 overview](overview.md)

## 1. Current (pre–subplan 04) architecture — confirmed

- **Arbor cluster** does **not** have access to GCP KMS. The sealer and other arbor services run in a cluster where KMS is not allowed.
- **Sealer** (arbor) signs log checkpoints by first obtaining a **delegation** from the **delegation-signer service that runs in Canopy**:
  - Sealer is configured with `DELEGATION_SIGNER_URL` (Canopy) and `DELEGATION_SIGNER_SERVICE_ACCOUNT_EMAIL`.
  - Sealer acquires a Bearer token (GCP impersonation of the delegation-signer SA), then calls **POST** `{DELEGATION_SIGNER_URL}/api/delegations` with a CBOR body: `delegated_pubkey` (sealer-generated key), `constraints`, `issued_at`, `expires_at` (prefix/no-log shape).
  - The **Canopy delegation-signer** (which has KMS access) signs a COSE_Sign1 delegation certificate with **its** root key (in KMS) and returns it. The sealer then uses that cert plus its own delegated key to sign checkpoints. No private key material and no KMS calls from arbor.
- **Canopy** hosts the delegation-signer app (`packages/apps/delegation-signer`). That app uses `kmsAsymmetricSignSha256`, `kmsGetPublicKeyDer` and has env bindings for KMS key ring and keys (e.g. `KMS_KEY_SECP256K1`, `KMS_KEY_VERSION`). So **KMS access lives only in Canopy**.

So: **one** delegation-signer in Canopy, called by the sealer (and potentially by other clients); arbor never talks to KMS.

---

## 2. Why extend the Canopy delegation-signer (not add a signer in arbor)

- **Constraint**: KMS is not allowed from the arbor cluster. So any service that needs to use KMS (bootstrap key, auth-log keys for signing) must run where KMS is allowed — i.e. in **Canopy** (or another environment that has KMS), not in arbor.
- **Existing asset**: The Canopy delegation-signer already has the trust boundary and KMS integration. It already signs delegation certificates with a root key. To support Plan 0004 (grant signing + multiple checkpoint signers), we should **extend this same service** to:
  - **Grant signing**: Offer “sign this digest with the **bootstrap** key” and “sign this digest with the key for **parent auth log L**”. Callers (canopy when creating grants, or a queue consumer that runs in/has access to Canopy) send a payload or payload_hash and receive a signature. No new service in arbor; no KMS in arbor.
  - **Multiple checkpoint signers (auth log hierarchy)**: When there are multiple auth logs, each has its own key. The sealer must sign checkpoints for a given log with **that log’s key** (for an auth log) or with the **parent auth log’s** key (for a data log). So the sealer needs to obtain a delegation (or a signature) **per key**: e.g. “delegation for auth log L” or “sign this checkpoint digest with the key for auth log L”. The delegation-signer in Canopy can resolve L to the correct KMS key (bootstrap for root, or the key created for that auth log) and either (a) issue a delegation cert signed by that key, or (b) sign the digest and return the signature. Same service, same KMS boundary; extended API and key resolution.
- **No second signer in arbor**: Adding a “signer” service in arbor that called GCP KMS would require the arbor cluster to have KMS permissions, which is not allowed. The subplan 04 deliverable (“delegation for bootstrap”, “delegation for parent log”) should therefore be implemented by **extending the existing Canopy delegation-signer**, not by a new service in arbor.

---

## 3. Intended direction

- **Implement subplan 04 in Canopy**: Extend `packages/apps/delegation-signer` (or the same deployment) to support:
  - **Delegation/sign for bootstrap key**: e.g. POST `/api/delegate/bootstrap` or similar; body: payload_hash (or payload); response: signature (or a short-lived delegation). Used for signing the initial grant.
  - **Delegation/sign for parent (auth) log**: e.g. POST `/api/delegate/parent`; body: parent_log_id, payload_hash (or payload); resolve parent_log_id to KMS key (bootstrap if parent is root, else key for that auth log); return signature or delegation. Used for signing grants that create children and for the sealer to sign checkpoints for logs under that auth log.
- **Sealer (arbor)**: Continues to call the **Canopy** delegation-signer only. For multiple auth logs, the sealer would request a delegation (or sign) **per auth log** from the same Canopy service (e.g. by including auth_log_id or key scope in the request). No new arbor service; no KMS in arbor.
- **Canopy (grant creation)**: When creating a grant after settlement, canopy (or a worker with access to Canopy) calls the same Canopy delegation-signer to obtain a signature for the grant payload (bootstrap or parent key). No arbor signer involved.

The arbor “signer” service that was added under subplan 04 should be treated as **out of scope** for the intended architecture; the work belongs in the Canopy delegation-signer instead.

---

## 4. Agent-optimised instructions (Plan 0004 subplan 04 in Canopy)

### 4.1 How the log (or key scope) is communicated

- **Grant signing — bootstrap:** No log id in the request. The key is implied: “use the **bootstrap** (root) key.” The caller sends only the digest to sign (e.g. `payload_hash`). The delegation-signer uses its configured bootstrap/root KMS key to sign that digest. The **grant** content (which log, owner, etc.) is in the payload that produced the digest; the delegation-signer does not need to read it.
- **Grant signing — parent log:** The **log** is communicated as **`parent_log_id`** in the request body (0x-prefixed 32-byte hex of the parent **auth** log). The delegation-signer uses this to select **which key** to use: if `parent_log_id` equals the chain root log id (from config or from the auth-log status service), use the bootstrap key; otherwise resolve `parent_log_id` to a KMS key id (e.g. from a key map or from key-creation state) and sign with that key. So “log” = which signing key (bootstrap vs parent auth log).
- **Checkpoint delegation (existing / future multi-key):** For the existing POST `/api/delegations`, the **log** is already communicated as **`log_id`** (and `mmr_start`, `mmr_end`) in the CBOR body for log-scoped delegations. The delegation cert payload includes this scope and is signed by the **root** key. For a future multi–auth-log world, the request could include **`auth_log_id`** (or the existing `log_id` when scoped to an auth log); the delegation-signer would then use **that auth log’s** KMS key to sign the delegation cert, so the cert is verifiable as “auth log L’s key attests that this delegated key can sign for L.”

So in all cases the **caller** sends the **log or key scope** in the request (bootstrap implied, `parent_log_id` for parent, `log_id` / `auth_log_id` for delegations). The delegation-signer maps that to a single KMS key and performs the sign (or delegation) with that key.

### 4.2 Why it is secure for the delegation-signer to sign

- **Authentication:** All endpoints require a valid **Bearer token** (e.g. GCP workload identity or impersonation). Only callers that can obtain that token (Canopy, sealer, or other allowed services) can call. Unauthenticated requests are rejected.
- **Key binding:** The delegation-signer only ever signs with **keys it holds in KMS**. It does not sign arbitrary data for arbitrary keys. It resolves the request (bootstrap, `parent_log_id`, or `auth_log_id`) to a **specific** key ref and signs only the **provided digest** (or the structured delegation payload) with that key. The result is verifiably from that key (signature verification against the known public key for that scope).
- **Digest semantics:** For grant signing, the caller sends a **digest** (e.g. SHA-256 of the grant inner or commitment). The delegation-signer does **not** validate the semantic content of the grant (target log, owner, kind). It only attests: “this signature was produced by the key for this scope (bootstrap or parent_log_id).” Trust in **what** is being signed is enforced by (1) the univocity contract (which verifies grant structure and inclusion) and (2) the caller’s identity and authorization. So it is secure for the delegation-signer to sign the digest without interpreting it.
- **Delegation certs:** When issuing a delegation cert, the payload is a **fixed structure** (log_id, mmr range, delegated_pubkey, constraints, expiry). The signer signs that structure with the key for the requested scope. So the cert means “key X attests that this delegated_pubkey can sign for scope Y.” Verifiers check the cert against the known public key for that scope (e.g. from the contract). The signer is not signing arbitrary or attacker-controlled content; it is signing a bounded delegation claim.

### 4.3 Root bootstrap (grant-first)

**Chosen design:** Root bootstrap uses a **grant-first** model. The bootstrap grant is created and signed once (one-time API or ops), published at a well-known URL. register-grant and register-signed-statement **require auth** (a signed grant) on every call; the first call that creates the root uses the bootstrap grant as auth (no inclusion check when logId not initialized and auth is bootstrap-signed). No checkpoint-publisher or runtime trigger. Full design and agent-optimised implementation are in **[Subplan 08: Grant-first root bootstrap](subplan-08-grant-first-bootstrap.md)**. This document (subplan 04) only specifies the **delegation-signer** API used to sign the bootstrap grant (POST /api/delegate/bootstrap, GET /api/public-key/:bootstrap).

### 4.4 Implementation location and steps (delegation-signer)

| Step | Action | Input | Output | Location | Verification |
|------|--------|-------|--------|----------|--------------|
| **4.3.1** | Add POST /api/delegate/bootstrap | Bearer token, JSON body `{ payload_hash }` (64 hex) | JSON `{ signature }` (hex, raw r\|\|s) | Canopy: `packages/apps/delegation-signer`. Use existing KMS root key (bootstrap = root). kmsAsymmetricSignSha256(digest), convert DER→raw, return hex. | Test: request with valid token and payload_hash; response signature verifies with root public key. |
| **4.3.2** | Add POST /api/delegate/parent | Bearer token, JSON `{ parent_log_id, payload_hash }` | JSON `{ signature }` | Same app. Resolve parent_log_id → key: if equals root (env or GET univocity /api/root), use root key; else optional key map env. Sign digest with that key; return hex. | Test: parent_log_id = root → same key as bootstrap; unknown parent → 404. |
| **4.3.3** | Optional: env for root and key map | UNIVOCITY_URL, ROOT_LOG_ID, PARENT_KEYS_JSON | Resolver uses them in 4.3.2 | Env bindings in worker; no new secrets. | Parent resolution returns correct key id. |
| **4.3.4** | Document for queue consumer / canopy | Request/response shapes above | Doc: how to call bootstrap vs parent, attach signature to grant | README or plan doc. | Canopy (subplan 06) can implement “request delegation → sign grant” from doc. |

**Data flow.** Caller (canopy or queue consumer) builds grant, computes digest (e.g. inner hash or commitment hash). For bootstrap grant: POST /api/delegate/bootstrap with `payload_hash`. For derived grant: POST /api/delegate/parent with `parent_log_id` and `payload_hash`. Delegation-signer resolves key, signs digest with KMS, returns `signature`. Caller attaches signature to grant. No private key material leaves the delegation-signer.

### 4.5 Implementation status (Canopy delegation-signer)

| Step | Status | Notes |
|------|--------|--------|
| **4.3.1** | Done | POST /api/delegate/bootstrap in `packages/apps/delegation-signer/src/delegate-grant.ts`. JSON body `{ payload_hash }`, Bearer auth, signs with root key (KMS_KEY_SECP256K1), returns JSON `{ signature }` (hex). |
| **4.3.2** | Done | POST /api/delegate/parent. JSON body `{ parent_log_id, payload_hash }`. Resolves parent: root via DELEGATION_SIGNER_ROOT_LOG_ID or GET univocity /api/root; else DELEGATION_SIGNER_PARENT_KEYS_JSON. Returns 404 if no key. |
| **4.3.3** | Done | Env: DELEGATION_SIGNER_UNIVOCITY_URL, DELEGATION_SIGNER_ROOT_LOG_ID, DELEGATION_SIGNER_PARENT_KEYS_JSON (optional). |
| **4.3.4** | Pending | Doc for queue consumer / canopy in plan or README (request/response shapes in §4.3). |
