---
Status: DRAFT
Date: 2026-03-23
Related:
  - [plan-0014-register-grant-custodian-signing.md](plan-0014-register-grant-custodian-signing.md)
  - [plan-0004-log-bootstraping/overview.md](plan-0004-log-bootstraping/overview.md)
  - [plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md)
  - [plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md](plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md)
  - [archived plan-0001](archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md)
  - [archived plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md)
  - arbor [plan-0001-custodian-cbor-api.md](../../../arbor/docs/plan-0001-custodian-cbor-api.md) (Custodian HTTP surface)
  - devdocs [Plan 0013 Custodian](https://github.com/forestrie/devdocs/blob/main/plans/plan-0013-custodian-implementation.md)
---

# Plan 0011: Custodian integration and current state (canopy)

This plan records the **Univocity `grantData` contract**, how **canopy-api** aligns with it, and how **Custodian (arbor)** fits in **after** [Plan 0014](plan-0014-register-grant-custodian-signing.md). **Historical and superseded** design notes (token-broker model, legacy delegation-signer, old checklists) live in the [appendix](#appendix-historical-and-superseded-material) at the end.

## 0. Auth model: grantData and signer endorsement (Univocity contract alignment)

The Univocity contracts tie the **first checkpoint** to the **authority key** carried in the grant’s **`grantData`**. For **ES256**, that key is the log **root** persisted as `rootKey`; the **consistency receipt** may be signed by that root **or**, when a **`DelegationProof`** is present, by a **delegate** that the root has authorized for a bounded MMR index range. This section summarizes the contract model and how that relates to canopy-api and Custodian.

### 0.1 Contract auth model (Univocity)

**Source:** `univocity/src/contracts/_Univocity.sol` (`_verifyCheckpointSignature`, `_checkpointSignersES256`, `_verifyCheckpointSignatureKS256`), `univocity/src/checkpoints/lib/delegationVerifier.sol`, `univocity/src/interfaces/types.sol` (`PublishGrant`, `ConsistencyReceipt`, `DelegationProof`); design: `docs/plans/plan-0026-verify-only-no-recovery.md`, `plan-0027-abstract-base-bootstrap-pattern.md`, `adr/adr-0005-grant-constrains-checkpoint-signer.md`.

- **First checkpoint — what `grantData` means:** On the first checkpoint for a log, **`grantData` supplies the log’s root (authority) public key** (verify-only; no on-chain recovery). That material is stored as **`rootKey`**. It does **not** name the delegate; see §0.1.1 for when the receipt is signed by someone other than `rootKey`.
- **Root’s first checkpoint (bootstrap, ES256):** `grantData` must be **exactly 64 bytes** (P-256 x || y) and **byte-identical to the bootstrap key bytes** deployed with the contract (`keccak256(grantData) == keccak256(bootstrapKey)`). The bootstrap **root** may still sign the first consistency receipt **directly**, or **delegate** receipt signing under the ES256 rules in §0.1.1. See `GrantDataInvalidKeyLength`, `GrantDataMustMatchBootstrap`, `RootSignerMustMatchBootstrap`.
- **Non-root first checkpoint (child auth or data log, ES256):** The authorizing grant’s `grantData` must be the **64-byte root (authority) key** for the new log—the same key material that will be stored as that log’s `rootKey`. The first (and later) consistency receipts are verified against **`rootKey` and optional `DelegationProof`** as in §0.1.1, not by stuffing the delegate’s key into `grantData`.
- **KS256:** First checkpoint still uses `grantData` as the root key material (20-byte address for the log). **`DelegationProof` is not supported** for KS256: if `delegationProof.signature` is non-empty, the contract reverts (`DelegationUnsupportedForAlg`). The receipt signer must be the root (bootstrap or stored `rootKey`).
- **Hierarchy (unchanged):** M0 = root authority log; B1 = bootstrap grant (first leaf in M0). B1 must carry `grantData = bootstrap root key`. For a child log M1, the creating grant Gn must carry `grantData =` that child log’s **root** key. Univocity does not care who appends leaves; checkpoint **verification** uses `rootKey` plus optional ES256 delegation.

**Enforceability and viability:** Wrong or missing `grantData` on first checkpoint reverts. Canopy must mint grants whose `grantData` is the **contract root key** (bootstrap key on the root log; endorsed root on children), not a delegate key. Delegation of **receipt** signing is a **checkpoint-transaction** concern (`DelegationProof` beside the receipt), not a grant-field extension.

### 0.1.1 ES256 delegation: delegate signs the receipt, root stays in `grantData`

**Supported on-chain (ES256 only):** Yes. `_Univocity.sol` distinguishes the **root** key (`rootX`, `rootY` from `grantData` on first CP, else from storage) from the **verifier** key that must have signed the **consistency receipt**. If `delegationProof.signature` is empty, verifier = root and the root signs the receipt. If a delegation proof is present, the verifier is **`delegationKey`** (64-byte P-256 pubkey in the proof); the **root** must have signed a canonical binding `SHA-256(abi.encodePacked(logId, mmrStart, mmrEnd, delegatedKeyX, delegatedKeyY))` (`verifyDelegationProofES256` in `delegationVerifier.sol`). The checkpoint index must lie in `[mmrStart, mmrEnd]`.

| Scenario | `grantData` (first CP) | Who signs the consistency receipt | Extra calldata |
|----------|-------------------------|-----------------------------------|----------------|
| Bootstrap, no delegation | Bootstrap root (64 B) | Same bootstrap root | Empty `delegationProof` |
| Bootstrap, with delegation | Bootstrap root (64 B) | **Delegate** (`delegationKey`) | Root-signed `DelegationProof` |
| Child log, no delegation | Child root (64 B) | Child root | Empty `delegationProof` |
| Child log, with delegation | Child root (64 B) | **Delegate** | Root-signed `DelegationProof` |

**Bootstrap vs child:** The same delegation mechanism applies to **both** the root log’s first checkpoint and any **child** log’s first (and subsequent) checkpoints: `grantData` always anchors the **root**; delegation only changes **who may sign the receipt**, not what is committed in the grant leaf.

**Grant / `grantData` format:** The Forestrie grant v0 payload already carries **`grantData` as opaque bytes** for the Univocity commitment. There is **no separate grant field** for the delegate pubkey; the delegate is **not** part of the grant leaf hash. That is consistent with the contract: delegation is scoped per checkpoint via **`ConsistencyReceipt.delegationProof`**, not via `PublishGrant.grantData`.

**Canopy-api today:** Register-grant and bootstrap mint only enforce **grant** shape, COSE verification, sequencing, and (where configured) receipt-based **inclusion** of the grant in a parent log. They do **not** assemble or validate Univocity **checkpoint** transactions or **`DelegationProof`**. So:

- **Compatible without code changes:** If operators use **Custodian / canopy-api** only to mint grants with `grantData =` the true **root** key (bootstrap or child), the on-chain story already allows a **separate pipeline** (e.g. sealer) to publish checkpoints with a **delegate** signing the receipt and a proper `DelegationProof`.
- **Not “supported” inside canopy-api:** There is nothing to “turn on” in canopy-api for delegation; it is not the layer that submits checkpoints. No **Custodian** API is *required* for delegation solely because Custodian signs **grants**; signing **delegation bindings** or **receipts** for the delegate is the concern of whatever component holds the root vs delegate private keys (often the sealer / ops keys, not the grant-mint path).

**When would new work be needed?**

- **Custodian:** Only if product wants **KMS-backed signing of delegation messages** or delegate receipts in one place; that would be **new signing surfaces** (e.g. sign canonical delegation hash or COSE receipt), not a change to grant `grantData`.
- **Canopy-api:** Only if product wanted canopy to **validate or carry** delegation structures in an API (unusual); the **grant format does not need extending** for standard Univocity delegation.

**Summary:** The contract **does** support “signer is a delegate of the key endorsed in the grant” for **ES256**, provided **`grantData` still names the root** and the checkpoint includes a valid **`DelegationProof`**. **KS256** does not support that indirection. **Canopy-api + Custodian as implemented for grants** already align: keep `grantData` as the **root** pubkey; delegation remains the **checkpoint publisher’s** responsibility.

### 0.2 Canopy alignment (bootstrap vs child logs)

| Topic | State (2026-03) |
|-------|------------------|
| **Bootstrap `grantData`** | **Aligned.** `packages/apps/canopy-api/src/scrapi/bootstrap-grant.ts` loads the `:bootstrap` public key from Custodian (`fetchCustodianPublicKey`), normalizes to 64 bytes (`publicKeyToGrantData64`), and sets `grant.grantData` before encoding the grant payload. Minting signs via Custodian `POST /api/keys/:bootstrap/sign` (`custodian-grant.ts`). |
| **Transparent statement wire format** | **Custodian / RFC 8152 profile only** (Plan 0014 hard cutover): COSE Sign1 payload is the **32-byte SHA-256 digest** of the grant v0 CBOR; full grant bytes live in unprotected header `-65538` (`HEADER_FORESTRIE_GRANT_V0`). Decode/verify in `transparent-statement.ts`, `custodian-grant.ts` (`verifyCustodianEs256GrantSign1`). |
| **Child-log grants** | When canopy (or paid-grant flow) creates grants for non-root logs (subplan 06), `grantData` must be the **log root (authority)** key (64 bytes ES256 or 20 bytes KS256), not a delegate. If operators use ES256 delegation at checkpoint time, the delegate is **not** placed in `grantData` (§0.1.1). Not fully productized here; Phase 2 of Plan 0014 adds **`CUSTODIAN_APP_TOKEN`** and `signGrantPayloadWithCustodianCustodyKey` for custody-key signing when a call site exists. |

**Implementation touchpoints:** `bootstrap-grant.ts`, `custodian-grant.ts`, `register-grant.ts` (bootstrap branch), `grant/transparent-statement.ts`, `index.ts` (`CUSTODIAN_*` env). A step-by-step checklist that predates Custodian naming is preserved [in the appendix](#a-original-bootstrap-grantdata-checklist-delegation-signer-era).

---

## 1. Where we are (minimal)

| Area | State |
|------|--------|
| **Register-grant and register-statement auth** | Done (Plan 0001, archived). Grant-based auth: `Authorization: Forestrie-Grant <base64>`; locate → verify; receipt-based inclusion when `inclusionEnv` set. Transparent statements use the **Custodian COSE profile** only (Plan 0014). |
| **Bootstrap grant mint** | **Custodian.** `POST /api/grants/bootstrap` builds the grant (with correct `grantData`), calls Custodian `POST /api/keys/:bootstrap/sign` with **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**, returns the transparent statement. |
| **Canopy-api Custodian env** | **`CUSTODIAN_URL`**, secrets **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** (Custodian `BOOTSTRAP_APP_TOKEN`), **`CUSTODIAN_APP_TOKEN`** (Custodian `APP_TOKEN`, Phase 2 / custody signing). Optional **`ROOT_LOG_ID`**, **`BOOTSTRAP_ALG`**. See `wrangler.jsonc` and `.dev.vars.bootstrap-example`. |
| **Custodian (arbor)** | **Integrated with canopy-api** for bootstrap: CBOR `GET /api/keys/{id}/public`, `POST /api/keys/{id}/sign` (COSE Sign1 response), per arbor services/custodian and [arbor plan-0001](../../../arbor/docs/plan-0001-custodian-cbor-api.md). Key ops (create, list, delete) remain available for ops and future per-log keys. |

---

## 2. Custodian and canopy (current design)

### 2.1 Bootstrap path (implemented)

- **Config:** `CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`.
- **Mint:** `bootstrap-grant.ts` → `postCustodianSignGrantPayload` / `mergeGrantHeadersIntoCustodianSign1` in `custodian-grant.ts`.
- **Register-grant bootstrap branch:** `fetchCustodianPublicKey` + `verifyCustodianEs256GrantSign1` against the PEM from Custodian.

No additional Custodian API is required for “auth log creation” beyond the bootstrap app token on **`:bootstrap`** routes: the bootstrap key material lives in **Custodian/KMS**; canopy-api only needs HTTP access with the correct secret.

### 2.2 Authorize callers to register-signed-statement

**Unchanged in purpose:** Callers present a valid grant (and, when required, receipt proving inclusion). The **backend** verifies **Custodian-profile** Sign1 and decodes grants via `transparent-statement.ts` (digest + `-65538` grant v0). Bootstrap public key for verification comes from **Custodian `GET …/public`**.

### 2.3 Optional: per-log keys (Custodian) and list keys

For **future** multi–auth-log or dynamic key creation:

- **Create key:** Custodian `POST /api/keys` with `key_owner_id` and labels (`CUSTODIAN_APP_TOKEN`).
- **Sign:** `POST /api/keys/{id}/sign` with the same token.
- **List:** `POST /api/keys/list` for ops / resolution.

Plan 0004 still discusses **parent** keys via config (e.g. `DELEGATION_SIGNER_PARENT_KEYS_JSON`) in the abstract; if keys move to Custodian per log, canopy would use **create + sign** above. `custodian-grant.ts` already exposes a custody signing helper for when a product call site exists (Plan 0014 Phase 2).

---

## 3. Checklist status

### 3.1 Done (cross-plan)

- Env vars **`CUSTODIAN_URL`**, **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**, **`CUSTODIAN_APP_TOKEN`** wired in `index.ts` / Wrangler.
- Bootstrap mint and register-grant bootstrap verification use **Custodian** and **one** COSE profile (RFC 8152 / Custodian output).
- **grantData** on bootstrap grants matches Univocity **64-byte** bootstrap key expectation.
- Legacy delegation-signer grant mint/verify paths and **`bootstrap-public-key.ts`** removed from canopy-api (hard cutover per Plan 0014).

### 3.2 Remaining / ops

- **Docs:** Keep workers/Doppler runbooks aligned with `CUSTODIAN_*` only (no `DELEGATION_SIGNER_*` for grant flows). Pointer: archived plan-0010 is historical ([appendix](#c-superseded-canopy-implementation-checklist-token-broker-era)).
- **Child-log `grantData`** and first **non-bootstrap** server-minted grants when subplan 06 / product surfaces land.
- **Optional:** Token caching — not applicable in the same way as GCP SA tokens; app tokens are **long-lived secrets** unless you introduce rotation policy separately.

---

## 4. References

- **§0 (grantData / auth model / delegation):** Univocity repo (sibling `../univocity`): `src/contracts/_Univocity.sol` (`_checkpointSignersES256`, `_verifyCheckpointSignatureES256`, `_verifyCheckpointSignatureKS256`), `src/checkpoints/lib/delegationVerifier.sol`, `src/interfaces/types.sol` (`PublishGrant`, `DelegationProof`, `ConsistencyReceipt`); `docs/plans/plan-0026-verify-only-no-recovery.md`, `plan-0027-abstract-base-bootstrap-pattern.md`, `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md`.
- **Plan 0014:** [plan-0014-register-grant-custodian-signing.md](plan-0014-register-grant-custodian-signing.md) — normative COSE, env mapping, Phases 1–2, hard cutover.
- **Arbor Custodian API:** `services/custodian/README.md`, [arbor plan-0001](../../../arbor/docs/plan-0001-custodian-cbor-api.md).
- **Archived:** [plan-0001](archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md), [plan-0010-bootstrap-env](archived/plan-0010-bootstrap-env/plan-0010-bootstrap-env.md).
- **Active (bootstrap narrative):** [Plan 0004 overview](plan-0004-log-bootstraping/overview.md), [Subplan 08](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md).
- **Canopy code (Custodian integration):** `packages/apps/canopy-api/src/index.ts`, `scrapi/bootstrap-grant.ts`, `scrapi/custodian-grant.ts`, `scrapi/register-grant.ts`, `grant/transparent-statement.ts`, `scrapi/auth-grant.ts` (decode path).

---

## Appendix: Historical and superseded material

This appendix preserves earlier Plan 0011 content that described a **token-broker** integration, an in-Canopy **delegation-signer**, and checklist steps that assumed those components. **Do not use it for new work**; follow [Plan 0014](plan-0014-register-grant-custodian-signing.md) and the main sections above.

### A. Token-broker model and delegation-signer (superseded)

**Original idea (early Plan 0011):** Canopy-api would keep calling an in-Canopy **delegation-signer** with a **GCP access token**, and Custodian would issue that token (e.g. `POST /api/token/bootstrap` with an app secret), replacing long-lived **`DELEGATION_SIGNER_BEARER_TOKEN`** / cron refresh.

**Why this is no longer the canopy story:** [Plan 0014](plan-0014-register-grant-custodian-signing.md) implemented **direct Custodian signing** and **RFC 8152** grant statements. Canopy-api uses **app tokens as Bearer** on Custodian’s **key API**, not as forwarded GCP credentials to another service. There is **no** `DELEGATION_SIGNER_*` wiring in `canopy-api` `index.ts` for bootstrap after that cutover.

**Legacy delegation-signer (design record only):** After Plan 0014, canopy-api does **not** use an in-Canopy delegation-signer for grant mint or verify. [Plan 0004 subplan 04](plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md) remains the design record for the old Cloudflare worker that held the bootstrap KMS key; new deployments use **Custodian in arbor** and **`CUSTODIAN_*`** env vars.

### B. Original bootstrap `grantData` checklist (delegation-signer era)

The table below was written when bootstrap relied on a **delegation-signer** public-key fetch. The same logical steps now use **Custodian** as key source and signer: read “delegation-signer” as “Custodian `:bootstrap`”, and note that **`bootstrap-public-key.ts`** was removed from canopy-api.

| Step | Action | Implemented as (today) |
|------|--------|------------------------|
| **0.1** | Fetch bootstrap public key before building grant | `fetchCustodianPublicKey(custodianUrl, ":bootstrap")` in `bootstrap-grant.ts`. |
| **0.2** | Normalize to 64 bytes (ES256) for grantData | `publicKeyToGrantData64` after PEM → uncompressed (`publicKeyPemToUncompressed65`). |
| **0.3** | Build bootstrap grant with grantData = bootstrap key | Grant built with non-empty `grantData` before `encodeGrantPayload` / Custodian sign. |
| **0.4** | Preserve signature flow end-to-end | Payload digest + Sign1 from Custodian; `mergeGrantHeadersIntoCustodianSign1` for idtimestamp when needed. |
| **0.5** | (Optional) KS256 bootstrap | `BOOTSTRAP_ALG` / `bootstrapAlg` exists; KS256 paths return “not implemented” where applicable. |
| **0.6** | Child-log grants (subplan 06) | Still future when first-checkpoint publishing for child logs is implemented. |

### C. Superseded canopy implementation checklist (token-broker era)

An older Plan 0011 **§3 implementation checklist** called for: **`CUSTODIAN_URL`** + **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**; **`fetchDelegationSignerTokenFromCustodian()`** (`POST …/api/token/bootstrap` → `access_token`); an **in-memory cache** of the delegation-signer GCP token with refresh before expiry; wiring that token into **`handlePostBootstrapGrant`** and **`bootstrapEnv`** for public-key fetch; a **config guard** around **`DELEGATION_SIGNER_BEARER_TOKEN`**; docs updates; and **retiring** a token-refresh pipeline.

That checklist applied to the **token-broker** design (Custodian issues GCP credentials for a separate delegation-signer). It is **superseded** by Plan 0014’s **direct signing** model. Use Plan 0014’s agent checklist and acceptance criteria instead; do not execute the token-broker checklist as written.
