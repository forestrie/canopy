---
Status: DRAFT
Date: 2026-03-23
Related:
  - [plan-0011-custodian-integration-and-current-state.md](plan-0011-custodian-integration-and-current-state.md)
  - [plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md](plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md)
  - arbor `services/custodian/README.md` (Custodian wire format and tokens)
  - devdocs [Plan 0013 Custodian](https://github.com/forestrie/devdocs/blob/main/plans/plan-0013-custodian-implementation.md)
---

# Plan 0014: Custodian-signed grants for bootstrap and regular paths (canopy-api)

## Goal

Move grant **signing** and **bootstrap public-key** sourcing for canopy-api from
the in-Canopy **delegation-signer** (JSON `POST /api/delegate/bootstrap`, PEM/JSON
public key) to **Custodian** (arbor), using the same token model as the
Custodian service. **Signing and verification** for grants under this plan must
follow the **normative COSE Sign1 model (RFC 8152)** end-to-end, matching
Custodian’s `POST /api/keys/{keyId}/sign` output — see §Decision: normative COSE.

| Custodian secret (cluster) | Canopy Workers secret (suggested name) | Custodian usage |
|----------------------------|----------------------------------------|-------------------|
| `BOOTSTRAP_APP_TOKEN` | `CUSTODIAN_BOOTSTRAP_APP_TOKEN` | `:bootstrap` key routes (`POST /api/keys/:bootstrap/sign`, destructive key ops, etc.) |
| `APP_TOKEN` | `CUSTODIAN_APP_TOKEN` | Custody keys: `POST /api/keys`, `POST /api/keys/{id}/sign`, `POST /api/keys/list`, etc. |

**Terminology:** **Custodian** is the arbor key-custody service (`services/custodian`).

**Scope:** `packages/apps/canopy-api/src/scrapi/register-grant.ts` is the
**registration** endpoint: it mostly **verifies** a caller-supplied
`Authorization: Forestrie-Grant` transparent statement. **Minting** the
bootstrap transparent statement today lives in `bootstrap-grant.ts`
(`POST /api/grants/bootstrap`). After this plan, **bootstrap mint and bootstrap
verification** both use **normative COSE Sign1** (RFC 8152) compatible with
Custodian’s signing output.

**Pre-release stance:** Forestrie is **not** released. This plan assumes a
**hard cutover**: **no** migration tooling, **no** backwards compatibility, **no**
dual verification paths, and **no** attempt to read or accept legacy
delegation-signer grant statements. **Delete** the old signing/verification code
and tests outright. Operators may **wipe** environments (logs, queues, R2, chain
state, client-held grants) as needed when deploying this change.

Implementation order:

1. **Bootstrap path first** — shared **RFC 8152** verifier + bootstrap mint +
   register-grant bootstrap branch + Custodian public key for `grantData`.
2. **Regular grant path second** — custody signing with `APP_TOKEN` wherever
   canopy-api **creates** a signed non-bootstrap grant; unify **decode/verify**
   with the same normative COSE model (`grantAuthorize` / receipt flow unchanged
   in purpose, but transparent statement parsing must align).

---

## Current behaviour (to be removed)

The following describes the **delegation-signer** profile (empty protected,
hand-built Sign1) that this plan **deletes** — not supported after cutover. Do
not retain branches that accept it.

### `register-grant.ts`

- **Bootstrap branch** (uninitialized root log, first grant): loads bootstrap
  public key via `getBootstrapPublicKey()` → **delegation-signer**
  `GET /api/public-key/:bootstrap` (optional Bearer), then
  `verifyBootstrapCoseSign1(grantResult.bytes, …)` — expects COSE Sign1 with
  **empty protected** (`0xa0`) and **64-byte raw r||s** over
  `SHA-256(Sig_structure)` matching `bootstrap-grant.ts` mint
  (`encodeSigStructure(protectedEmpty, aad, payload)`).
- **Regular branch**: `grantAuthorize` (receipt + MMR inclusion); **no**
  server-side signing.

### `bootstrap-grant.ts`

- Fetches public key from delegation-signer (same as above).
- Builds grant CBOR payload, computes `cose_tbs_hash` (hex of SHA-256 of
  Sig_structure), calls delegation-signer `POST /api/delegate/bootstrap` with
  **JSON** body and Bearer **GCP access token** (today often via static
  `DELEGATION_SIGNER_BEARER_TOKEN` or future Custodian-issued SA token per
  plan-0011).

### Custodian (target)

- `GET /api/keys/{keyId}/public` — **no auth**; CBOR: `keyId`, `publicKey`,
  `alg`.
- `POST /api/keys/{keyId}/sign` — **CBOR** body: `payload` (bstr) *or*
  `payloadHash` (bstr, 32 bytes). **`BOOTSTRAP_APP_TOKEN`** for key id
  **`:bootstrap`**; **`APP_TOKEN`** for custody keys. Response:
  **`application/cose; cose-type="cose-sign1"`** — raw **COSE_Sign1** with
  protected headers (`alg`, `cty`, `kid`, …).

---

## Decision: normative COSE (RFC 8152) — path A only

**Chosen:** Implement **RFC 8152–style** signing and verification for **all**
grant transparent statements that canopy-api **mints** or **verifies** in this
workstream, aligned with Custodian’s **`POST /api/keys/{keyId}/sign`** output
(protected headers include `alg`, `cty`, `kid`, … per Custodian README).

**Discarded:** **Path B** — Custodian will **not** add or maintain a “legacy”
signing mode that reproduces empty-protected (`0xa0`) Sign1 to match the old
delegation-signer mint. No second COSE profile in Custodian for grants.

**Rationale:** One wire format reduces ambiguity, matches KMS-backed signing in
Custodian, and keeps verification a single code path based on **Sig_structure**
over the **actual** serialized protected bucket and payload (RFC 8152 §4.4).

### What “normative COSE model” means here

- **Sign1** is a standard four-element array; **protected** is a **bstr**
  encoding a **definite-length CBOR map** of header parameters (at minimum
  `alg`; Custodian adds `cty`, `kid`, etc. as documented).
- **Verification** computes **Sig_structure** from the Sign1’s protected map
  bytes, optional external AAD, and payload, then verifies the signature with
  the key resolved from **`kid`** (and/or config) against the grant-issuing key
  material from Custodian (`GET …/public` or equivalent).
- **Minting:** `bootstrap-grant.ts` (and any Phase 2 grant mint) uses
  **Custodian’s returned Sign1 bytes** as the transparent statement body (or a
  documented canonical serialization thereof) — **do not** re-wrap or replace
  signatures with ad hoc r||s assembly.
- **Bootstrap verification** in `register-grant.ts` must use the **same**
  normative verifier as used for other grant checks (replace
  `verifyBootstrapCoseSign1` and any empty-protected-only helpers; **remove**
  dead code, do not keep fallbacks).

### Rollout: hard cutover only

- **Single** supported wire format: Custodian-issued **RFC 8152** Sign1 for grant
  transparent statements in scope of this plan.
- **No** reading or verifying of pre-cutover grants; **no** feature flags for
  “legacy verify”; **no** Custodian path-B compatibility mode (unchanged from
  above).
- **Data:** Pre-release — reset or discard any persisted grants, MMR state, or
  client caches as required; not a migration problem.

---

## Phase 1 — Bootstrap path (`BOOTSTRAP_APP_TOKEN` / `:bootstrap`)

**Objective:** Mint and verify bootstrap grants using Custodian’s `:bootstrap`
key and **bootstrap app token** (Canopy: `CUSTODIAN_BOOTSTRAP_APP_TOKEN`).

### 1.1 Config (canopy-api / Wrangler)

- Add **`CUSTODIAN_URL`** (base URL, no trailing slash).
- Add secret **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** (maps to Custodian env
  **`BOOTSTRAP_APP_TOKEN`**).
- **Remove** bootstrap’s dependency on **`DELEGATION_SIGNER_URL`**,
  **`DELEGATION_SIGNER_BEARER_TOKEN`**, and **`DELEGATION_SIGNER_PUBLIC_KEY_TOKEN`**
  for mint and for register-grant bootstrap verification; Custodian replaces
  that path entirely for bootstrap. (If any non-bootstrap feature still used
  delegation-signer, re-evaluate under Phase 2 — prefer removal or Custodian
  there too; do not keep dead env vars “just in case”.)

### 1.2 Public key for `grantData` and verification

- Implement **`getBootstrapPublicKeyFromCustodian(custodianUrl, alg)`** (new
  module or extend `bootstrap-public-key.ts`):
  - `GET {CUSTODIAN_URL}/api/keys/:bootstrap/public`
  - `Accept: application/cbor` (or whatever Custodian returns); decode CBOR
    `publicKey` into the same **65-byte uncompressed** form
    `getBootstrapPublicKey` uses today (or normalize to it for ES256).
- Use this in **`handlePostBootstrapGrant`** for `grantData` normalization
  (`publicKeyToGrantData64`).

### 1.3 Sign bootstrap transparent statement via Custodian

- Replace `POST …/api/delegate/bootstrap` in **`bootstrap-grant.ts`** with:
  - `POST {CUSTODIAN_URL}/api/keys/:bootstrap/sign`
  - Headers: `Authorization: Bearer <CUSTODIAN_BOOTSTRAP_APP_TOKEN>`,
    `Content-Type: application/cbor`
  - Body (CBOR): prefer **`payload`** = **grant payload bytes**
    (`encodeGrantPayload(grant)`) so the signed payload matches registration;
    alternatively `payloadHash` = SHA-256(Sig_structure) **only** if Custodian’s
    COSE payload convention is documented to be that digest (confirm in
    custodian handler + tests — do not guess).
- Response: raw **COSE_Sign1** bytes (normative profile). Return as transparent
  statement (`text/plain` base64 as today, or align content-type with Plan 0005
  if required). **Do not** strip or replace Custodian’s protected headers.

### 1.4 `register-grant.ts` bootstrap branch

- Replace `getBootstrapPublicKey({ delegationSigner… })` with Custodian public
  key fetch (same helper as mint) for **key material** and/or **`kid`**
  resolution as required by the normative verifier.
- Verify caller’s `Forestrie-Grant` with the **shared RFC 8152 grant Sign1
  verifier** used for Phase 1.3 output (**delete** `verifyBootstrapCoseSign1`
  and delegation-signer public-key fetch used only for the old profile).

### 1.5 `index.ts` wiring

- Bootstrap route: require **`CUSTODIAN_URL`** + **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`**
  (no fallback to `DELEGATION_SIGNER_*` for bootstrap mint).
- `bootstrapEnv` for **register-grant**: pass `custodianUrl` + bootstrap token
  (or a small facade env object) so register-grant does not read global `env`
  directly if you want testability.

### 1.6 Tests

- **`bootstrap-grant.test.ts`** and **`register-grant.test.ts`** (and shared
  COSE helpers): fixtures for Custodian CBOR + **normative COSE_Sign1** only.
- **Remove** tests and mocks that assert empty-protected Sign1 or
  delegation-signer `/api/delegate/bootstrap` / `public-key` flows for grants.

### 1.7 Docs

- Update plan-0011 §2.1 note: bootstrap is no longer “token for
  delegation-signer only” when full Custodian signing is enabled.
- Workers env docs / Doppler: document `CUSTODIAN_*` secrets.

---

## Phase 2 — Regular grant path (`APP_TOKEN`)

**Objective:** Use Custodian **`APP_TOKEN`** (Canopy: `CUSTODIAN_APP_TOKEN`) to
**create appropriately signed grants** for **non-bootstrap** operations, using
the **same normative COSE Sign1 model** as Phase 1 (RFC 8152, Custodian wire
format).

### 2.1 Clarify product surface

Today **register-grant does not mint** regular grants; clients submit pre-signed
statements. Phase 2 applies when canopy-api **signs** a grant payload, for
example:

- Future **paid-grant / settlement → grant issuance** (subplan 06 / x402),
- **Parent delegation** mint if implemented in canopy-api (`delegate/parent`
  analogue),
- Any admin or API that builds a `Forestrie-Grant` transparent statement
  server-side.

If no such code path exists yet, Phase 2 is **(a)** add an internal
**`signGrantWithCustodianKey({ custodianUrl, appToken, keyId, grant })`** (or
equivalent) that returns **raw Custodian COSE_Sign1** bytes and **(b)** wire it
at the first call site; **(c)** ensure any verifier for those statements is the
**same RFC 8152 module** as bootstrap (parameterize by key resolution / purpose).

### 2.2 Implementation sketch

- `POST {CUSTODIAN_URL}/api/keys/{keyId}/sign` with **`Authorization: Bearer
  <CUSTODIAN_APP_TOKEN>`**, CBOR `payload` or `payloadHash` per grant-encoding
  rules **and** Custodian’s documented semantics for what is hashed/signed.
- Map **keyId** from config or from grant metadata (document per feature).
- **Verification** of server-minted or client-presented grants must go through
  the **shared normative COSE verifier** (RFC 8152); do not add one-off
  signature checks per endpoint.

### 2.3 Register-grant “regular” branch

- **Receipt + inclusion** (`grantAuthorize`) remains as today for **authorization
  to enqueue**; if the transparent statement’s Sign1 format changes for **any**
  caller (not only bootstrap), **`getGrantFromRequest` / decode path** must
  accept **normative COSE** consistently.
- Audit **`auth-grant.ts`**, **`transparent-statement.ts`**, and related decode
  paths so **all** supported grant statements use **one** COSE profile (RFC 8152
  / Custodian); **delete** parsing branches that exist only for the old profile.
- When adding **server-minted** regular grants, align **optional COSE headers**
  (e.g. idtimestamp, receipt in unprotected map) with Plan 0005 / existing
  Forestrie-Grant conventions **without** breaking RFC 8152 Sig_structure
  verification.

---

## Acceptance criteria

- With Custodian configured, **`POST /api/grants/bootstrap`** returns a
  transparent statement that **`POST /logs/{logId}/grants`** accepts on the
  bootstrap branch for an uninitialized root log (same log id / grant shape).
- That statement is **normative COSE Sign1** (RFC 8152), verifiable with the
  **same** verifier logic used elsewhere for Custodian-issued grant Sign1 (**no**
  legacy verifier, **no** parallel digest+raw-signature path).
- **All** grant signing and verification touched by this plan is **compatible
  with the normative COSE model** (protected map as bstr, standard
  Sig_structure, key resolution consistent with `kid` / public key from
  Custodian).
- Custodian **`:bootstrap`** operations use the bootstrap app token only; custody
  **`POST /api/keys/.../sign`** uses **`APP_TOKEN`** only.
- No accidental use of **`APP_TOKEN`** for `:bootstrap` or vice versa (unit
  tests or integration tests with wrong token → 401 on Custodian).
- Documentation lists required Worker secrets and Custodian endpoints; **path B
  is not implemented** in Custodian.
- **No** backwards compatibility: codebase contains **no** code path that
  verifies empty-protected delegation-signer grant Sign1 after this work lands.

---

## Agent checklist (execution order)

1. Read Custodian handlers for `GET …/public` and `POST …/sign` (arbor) and
   confirm CBOR field names, COSE protected headers, and payload / payloadHash
   semantics.
2. Implement **RFC 8152** Sign1 verification (shared module); wire **bootstrap
   mint** to return Custodian bytes unchanged; wire **register-grant** bootstrap
   branch to the shared verifier. **Do not implement path B** in Custodian.
3. Implement Phase 1.2 → 1.3 → 1.4 → 1.5 → 1.6.
4. Unify **decode + verify** for grants (`auth-grant` / transparent statement)
   on the **normative COSE model only**; **delete** legacy parsers/verifiers.
5. Identify or add the first **regular** signing call site; implement Phase 2
   using the **same** normative COSE verifier.
6. **Delete** delegation-signer bootstrap mint/verify code paths, related env
   vars from docs and Wrangler templates, and obsolete tests (no gates, no
   “after migration” follow-up).

---

## Effort

Roughly **1–3 days** depending on COSE verification complexity, test depth, and
whether Phase 2 has an existing call site or only a helper + stub. Deleting
legacy paths outright is **simpler** than maintaining compatibility.
