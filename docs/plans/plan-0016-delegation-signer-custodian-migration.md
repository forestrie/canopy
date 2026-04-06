---
Status: ACCEPTED
Date: 2026-03-28
Related:
  - [plan-0011-custodian-integration-and-current-state.md](plan-0011-custodian-integration-and-current-state.md)
  - [plan-0014-register-grant-custodian-signing.md](plan-0014-register-grant-custodian-signing.md)
  - [plan-0004-log-bootstraping/subplan-07-sealer-key-resolution-per-log.md](plan-0004-log-bootstraping/subplan-07-sealer-key-resolution-per-log.md)
  - arbor `services/custodian/README.md`
  - `packages/apps/delegation-signer/` (Canopy Worker; optional / legacy path)
  - arbor `services/pkgs/delegationcert/`
  - arbor `services/sealer/` (`global_delegation.go`, config, future `delegationcert` issuance)
---

# Plan 0016: Delegation signing via Custodian (discovery + target architecture)

This plan **front-loads discovery** and records the **intended production shape**: **Sealer calls Custodian directly** for raw ECDSA over the delegation `Sig_structure` digest, assembles the Forestrie delegation COSE Sign1 in **Go** via **`delegationcert`**, and **resolves the Custodian signing `keyId` from `logId`** (see **§7**) rather than carrying a static per-deployment map of all logs. **`:bootstrap`** remains a valid **resolved** `keyId` for the platform root when that is the Custodian HTTP path for the bootstrap KMS resource; resolution rules choose it when appropriate, not hard-coded app logic scattered in Sealer.

**Canopy delegation-signer** may remain for HTTP compatibility tests, non-Sealer callers, or a transition window; it is **not** the long-term owner of sealing-path policy for GKE Sealer.

---

## 0. Discovery (findings)

### 0.1 Custodian: signing surface today

**Endpoints** (`arbor/services/custodian/src/api.go`, `README.md`):

| Route                                         | Auth                                                               | Body / response                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /api/keys/{keyId}/public`                | None                                                               | CBOR public key; optional **`?log-id=true`** resolves **`keyId`** as log id                              |
| `POST /api/keys`                              | `APP_TOKEN`                                                        | Create custody key                                                                                       |
| `GET /api/keys/list` / `POST /api/keys/list`  | `APP_TOKEN`                                                        | List keys (GET: label query params; POST: CBOR **`labels`**)                                             |
| `GET /api/keys/curator/log-key`               | `APP_TOKEN`                                                        | **`?logId=`** → CBOR **`{ keyId }`**                                                                     |
| `POST /api/keys/{keyId}/sign`                 | `APP_TOKEN` (custody keys) or `BOOTSTRAP_APP_TOKEN` (`:bootstrap`) | CBOR `SignRequest`; optional **`rawSignatureOnly`** → `{ signature: bstr }`; optional **`?log-id=true`** |
| `POST .../delete`, `.../versions/delete-from` | `BOOTSTRAP_APP_TOKEN`                                              | Key lifecycle; optional **`?log-id=true`**                                                               |

**Sign behaviour:** Normal sign builds custodian-statement COSE Sign1; **`rawSignatureOnly`** returns only IEEE P1363 signature bytes over the same digest KMS uses for asymmetric sign — suitable for Sealer/delegation assembly off-Custodian.

### 0.2 Custodian: authorization model

- **`APP_TOKEN`**: custody keys created via `POST /api/keys`.
- **`BOOTSTRAP_APP_TOKEN`**: `:bootstrap` sign/destroy and any route Custodian binds to the bootstrap KMS resource.

Sealer must present the **token that matches the key id** it uses (per Custodian, not per alias magic).

### 0.3 Target: Sealer → Custodian (primary)

- **Sealer** holds **`CUSTODIAN_URL`**, **`CUSTODIAN_APP_TOKEN`** (list + custody sign), **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** when resolution returns **`keyId`** `:bootstrap`, and **minimal platform constants** (e.g. **`ROOT_LOG_ID`**) only where **§7** says a fallback is needed.
- **`logId` → `keyId`** via Custodian (see **§7**); then **`GET .../{keyId}/public`** (kid), **`POST .../{keyId}/sign`** with **`rawSignatureOnly`**.
- **`delegationcert`**: issuance (TBS digest, assemble Sign1) after raw signature returned.

No Worker hop for this path; drop GCP impersonation of delegation-signer SA for production Sealer once direct path ships.

### 0.4 Sealer, `logId`, and bootstrap (superseded by §7)

Per-log signing roots are **unified** under **§7** (label-based lookup + root fallback). [Subplan 07](plan-0004-log-bootstraping/subplan-07-sealer-key-resolution-per-log.md) remains an **alternative** resolver if product later needs data **outside** Custodian KMS labels (e.g. on-chain–only truth).

### 0.5 Shared Go module (`delegationcert`)

- **Module:** `github.com/forestrie/arbor/services/pkgs/delegationcert`
- **Today:** parse-only (`CertificateInfo`, `ParseCertificate`, `Curve`).
- **Target:** add issuance helpers (TBS digest, assemble Sign1) shared only on the Go side; **golden vectors** vs historical Worker output during migration.

---

## 1. Goal

- **Primary:** **Sealer → Custodian**: resolve **`keyId` from `logId`** (**§7**), **`delegationcert`** issuance, **`rawSignatureOnly`** sign.
- **No static table** of per-log key ids in Sealer; **optional** in-process **cache** by `logId`, optionally **validated** against the previous checkpoint’s embedded delegation cert (**§7.4**).
- **Secondary:** Retire Sealer → delegation-signer for production GKE Sealer.
- Preserve **verifiable** delegation COSE profile unless version bump.

## 2. Non-goals

- Sealer queue consumer / ingress (separate ops track).
- **Subplan 07 REST** as the **primary** resolver — only if Custodian label model is insufficient.

---

## 3. Phases

### Phase 1 — Custodian: raw digest signature

**Done:** `SignRequest.rawSignatureOnly` on `POST /api/keys/{keyId}/sign` → `{ signature }`.

### Phase 2 — `delegationcert`: issuance API

- Build global/prefix delegation payload + protected map, digest, HTTP hooks, assemble Sign1.
- Goldens vs `@canopy/delegation-signer`.

### Phase 3 — Custodian: log-id resolution APIs + cache (**done**)

- **Ops prerequisite (bootstrap parity):** Label the **platform root** CryptoKey in KMS with the same **`fo-log_id=<normalized 32-hex ROOT_LOG_ID>`** convention as custody keys (Plan §7.3 approach **A**), so **list-by-log-id** and **resolution code paths are identical** for every log. Until that is true, configure **`ROOT_LOG_ID`** on Custodian for the narrow list-miss → **`:bootstrap`** fallback (**§7.3 B**). **Breaking change (2026-04):** legacy KMS keys labeled `forestrie_log_id` / `owner_id` must be relabeled to **`fo-log_id`** / **`fo-owner_id`** (or rely on **`ROOT_LOG_ID`** until relabeled).
- **Curator (read-only):** **`GET /api/keys/curator/log-key?logId=<hex>`** (normal app token) → CBOR **`{ keyId }`** — primary alternative to **client list + filter**; cheap to cache at the edge compared to full list.
- **Path alias:** On **`GET/POST /api/keys/{keyId}/…`** routes, optional query **`log-id=true`** (or **`log-id=1`**) treats **`{keyId}`** as a **log id**; Custodian resolves to the real Custodian key id (custody short id or **`:bootstrap`**) via shared **`ResolveCustodianKeyIDForLogID`** logic.
- **LRU:** In-process **`log id → key id`** cache capped by **`LOG_ID_CACHE_SIZE`** (default **1024**; set **0** to disable). Eviction is LRU; **misconfiguration** (duplicate labels) may be masked until eviction — enforce **unique `fo-log_id`** in ops.
- **List semantics:** **`GET /api/keys/list?labelKey=value&predicate=and`** added for **read-only** use (same auth as POST); **`POST /api/keys/list`** retained for CBOR bodies with arbitrary label maps. Rationale for historical POST: uniform **application/cbor** request bodies; GET fixes **HTTP semantics** and **cacheability** for simple predicates.

### Phase 4 — Sealer: direct Custodian + resolution

- Implement **§7** resolution + lease acquisition; drop signer URL / GCP impersonation for production.

### Phase 5 — delegation-signer Worker

- **Demote** to optional for dev / legacy.

---

## 4. Verification

- Goldens for issuance; staging seal/receipt unchanged.
- Tests: **0 / 1 / many** hits on label list; bootstrap fallback; cache invalidation.

---

## 5. Open questions

1. Canonical **log id** string form beyond **lowercase hex** (e.g. fixed-width UUID) — **Custodian normalizes** to lowercase hex without `0x`; label values must remain consistent with **`buildLabelFilter`** sanitization.
2. Dedicated **`CUSTODIAN_SEALER_TOKEN`** vs reusing **`APP_TOKEN`** for list + curator + resolve.

**Resolved for implementation:** Prefer **KMS labeling** of the bootstrap key with **`fo-log_id`** so Sealer resolution is **one code path**; **`ROOT_LOG_ID`** remains for transition when the root key is **outside** the custody ring listing surface.

---

## 6. Implementation record (interim — Worker path)

The following **landed** as an **intermediate** step (Sealer unchanged; Worker optional Custodian):

- **Custodian:** `rawSignatureOnly` (see README).
- **delegation-signer:** Optional `CUSTODIAN_URL` + `CUSTODIAN_BOOTSTRAP_APP_TOKEN`, `:bootstrap` discovery in Worker only — **not** the long-term Sealer architecture described above.

**Target (§3 Phases 2–4)** supersedes the Worker-centric rollout for **production Sealer** (resolution in **§7**).

---

## 7. Log-id → signing key resolution (Custodian) — **for review**

This section evaluates whether Sealer can **discover** the Custodian **`keyId`** (and thus public key / signing route) from **`logId`**, without pre-configuring a full map of log → key.

### 7.1 What exists today (viable core)

**`POST /api/keys/list`** (`arbor/services/custodian/src/kms_list.go`, `handle_list_keys.go`):

- Authenticated with **`APP_TOKEN`**.
- Body: **`labels`**: map of string → string, **`predicate`**: `"and"` | `"or"`.
- Custodian builds a **GCP KMS `ListCryptoKeys` filter** on **`labels.<key>=<value>`** for CryptoKeys under **`CUSTODY_KEY_RING_ID`**.
- Returns **`keyId`** (short CryptoKey name), **version**, optional **count**.

**Key creation** (`kms_create.go`): custody CryptoKeys receive **operator KMS labels** **`fo-owner_id`** and **`fo-log_id`** (Custodian sets these from **`keyOwnerId`** / **`selfLogId`**, normalized to **32 lowercase hex**). **User-supplied** `labels` on create must **not** start with **`fo-`** (reserved Forestrie operator prefix). Additional **caller-supplied** labels are merged after sanitization (GCP: lowercase, `[a-z0-9_-]` via `buildLabelFilter`).

**Implication:** If every **authority signing key** that Sealer might use for a log is a **CryptoKey in the custody ring** and is tagged with a **stable label** whose value is derived from **`logId`**, then Sealer can **lookup by log id**:

1. Normalize `logId` (e.g. UUID bytes → **lowercase hex without `0x`**, fixed width).
2. **`GET /api/keys/curator/log-key?logId=<hex>`** with **`APP_TOKEN`**, or **`GET /api/keys/list?fo-log_id=<hex>&predicate=and`**, or **`POST /api/keys/list`** with CBOR `labels: { "fo-log_id": "<hex>" }`, `predicate: "and"`.
3. Require **exactly one** matching key; treat **0** as misconfiguration / missing key; **>1** as operator error.
4. Use returned **`keyId`** for **`GET /api/keys/{keyId}/public`** and **`POST /api/keys/{keyId}/sign`** (**`rawSignatureOnly`**). Custody keys use **`APP_TOKEN`** for sign.

**Public key:** **`GET /api/keys/{keyId}/public`** is already **unauthenticated** for custody keys; Sealer can fetch kid material after resolve.

### 7.2 Curator and shared resolution (implemented on Custodian)

**Primary lookup:** **`GET /api/keys/curator/log-key?logId=<hex>`** ( **`APP_TOKEN`** ) → CBOR **`{ keyId }`**. Uses **`fo-log_id`** KMS label (**constant `ForestrieLogIDLabelKey` / `fo-log_id`** in arbor `custodian`).

**Optional path alias:** Any **`/api/keys/{keyId}/(public|sign|delete|…)`** may pass **`?log-id=true`** so **`{keyId}`** is interpreted as **log id** and resolved through the **same** function as the curator endpoint. **`GET …/public?log-id=true`** is unauthenticated today (same as plain public); operators should treat log-id exposure like any other public metadata policy.

**List:** **`GET /api/keys/list?fo-log_id=<hex>&predicate=and`** returns the same shape as **`POST /api/keys/list`** without a CBOR body. **`POST …/list`** remains for arbitrary multi-label maps in CBOR.

**Why `POST /api/keys/list` existed:** Custodian standardizes **request bodies** as **CBOR**; a rich `labels` map is awkward in query strings. **GET** is appropriate for **read-only** narrow cases and **HTTP caching**; POST is retained for full expressiveness.

### 7.3 Bootstrap / platform root key (`:bootstrap`)

**Issue:** **`BOOTSTRAP_KMS_CRYPTO_KEY_ID`** may refer to a CryptoKey **outside** the custody ring’s `ListCryptoKeys` scope, exposed only as **`:bootstrap`**.

**Ways to unify behavior:**

| Approach                                | Pros                                                             | Cons                                                                       |
| --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A. Label the root key in KMS**        | Same **list / curator / `log-id`** path for **all** logs         | Ops must set **`fo-log_id`** on the root key (same as custody keys) |
| **B. Custodian `ROOT_LOG_ID` fallback** | Transition without relabeling root; list miss → **`:bootstrap`** | Two mechanisms until **A** is done                                         |
| **C. Mirror root as custody key**       | Pure list path                                                   | Duplication / drift risk                                                   |

**Plan:** **Adopt A in ops** so bootstrap is not a special case in resolution logic. **B** (**`ROOT_LOG_ID`** env on Custodian) remains for **migration** when the root key is not returned by custody **`ListCryptoKeys`**.

### 7.3.1 In-process LRU (`LOG_ID_CACHE_SIZE`)

Custodian caches **normalized log id → resolved `keyId`** (including **`:bootstrap`**) up to **`LOG_ID_CACHE_SIZE`** entries (default **1024** when unset; **0** disables). **Dup-key misconfiguration** can be hidden until an entry is evicted — ops must guarantee **at most one** CryptoKey per **`fo-log_id`**.

### 7.4 Checkpoint reuse (optional optimization)

On **subsequent** seals for the **same** `logId`, Sealer already reads the **last checkpoint**.

**Possible optimizations:**

1. **In-memory cache:** `logId` → **`{ keyId, issuerKid, expiresAt? }`** after first successful resolve; skip **`list`** on next seal if cache hit (process lifetime).
2. **Cross-check:** Decode checkpoint COSE; read delegation cert from **unprotected label `1000`**; **`delegationcert.ParseCertificate`** → **issuer `kid`** in protected headers; verify it equals **`GET .../public`** kid for cached **`keyId`**. If mismatch, **invalidate** cache and re-resolve.
3. **kid-only shortcut:** Custodian **does not** expose **`kid` → keyId** reverse lookup today. **Do not** rely on kid alone without cache of **`keyId`** unless a future index is added.

**Endorsement:** **(1)+(2)** is enough for a strong optimization without new Custodian APIs.

### 7.5 Auth and trust

- **List / curator / custody sign / log-id resolution** (except unauthenticated **public**) use **`APP_TOKEN`** — Sealer is already high-trust; same secret tier as custody operations.
- **`:bootstrap` sign** uses **`BOOTSTRAP_APP_TOKEN`** when the resolved **`keyId`** is **`:bootstrap`** (after §7.3 **A** or **B**).

### 7.6 Gaps / risks

- **Label discipline:** Wrong or missing GCP labels → **no key** at seal time; needs **alerting** and runbooks.
- **Uniqueness:** **Multiple** keys matching one `logId` label → **ambiguous**; must be **impossible by policy** or Sealer **fails closed**.
- **Curve / alg:** After resolve, **issuer `alg`** (from public response) must **match** delegated ephemeral curve policy (**ES256** vs **KS256**) — same invariant as today; **wrong key** → sign or verifier failure.
- **Non-custody roots:** If some logs’ keys **never** enter this KMS ring, **Custodian-only** resolution is insufficient; then **subplan 07** or another registry is still needed.

**Bottom line:** **Yes, it is viable** for Sealer to resolve **`keyId` from `logId`** using **KMS labels**, **`GET /api/keys/curator/log-key`**, **`GET/POST /api/keys/list`**, or **`?log-id=true`** on key routes, plus **labeled bootstrap** and/or **`ROOT_LOG_ID`**. Custodian’s **LRU** reduces repeated **`ListCryptoKeys`** calls. **Checkpoint-assisted cache** in Sealer remains **optional** and does not require **kid → keyId** reverse lookup if Sealer caches **`keyId`** and validates **issuer kid** from the last cert.
