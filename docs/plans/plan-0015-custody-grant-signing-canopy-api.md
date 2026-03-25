---
Status: DRAFT
Date: 2026-03-23
Related:
  - [plan-0014-register-grant-custodian-signing.md](plan-0014-register-grant-custodian-signing.md)
  - [plan-0011-custodian-integration-and-current-state.md](plan-0011-custodian-integration-and-current-state.md)
  - arbor `services/custodian/README.md`
  - arbor [plan-0001-custodian-cbor-api.md](../../../arbor/docs/plan-0001-custodian-cbor-api.md)
---

# Plan 0015: Custody-key Forestrie-Grant signing (canopy-api)

## Goal

Ship **server-minted** Forestrie-Grant transparent statements signed with a **Custodian custody key** (`APP_TOKEN` / non-`:bootstrap` `keyId`), reusing the same COSE profile and canopy helpers as bootstrap (Plan 0014). The work is **canopy-api–centric** unless assessment shows a Custodian gap.

## Assessment: existing Custodian signing API vs grant coupling

### Custodian remains grant-agnostic

| Layer | Responsibility | Grant-specific? |
|-------|----------------|-----------------|
| **`POST /api/keys/{keyId}/sign`** | CBOR body: **`payload`** (opaque bytes) XOR **`payloadHash`** (32 bytes). Server computes SHA-256(payload) when using `payload`, then builds **COSE_Sign1** with **COSE payload = 32-byte digest** (`arbor/services/custodian/src/types_key_sign.go`, `handle_sign_key.go`, `BuildCustodianCOSESign1`). | **No.** Any byte string can be signed. |
| **COSE protected headers** | `alg`, `cty` = `application/forestrie.custodian-statement+cbor`, `kid` from pubkey — generic “custodian attestation” profile (`cose_custodian_sign1.go`). | **No** grant CBOR in headers. |
| **Auth** | `:bootstrap` routes require `BOOTSTRAP_APP_TOKEN`; other keys require `APP_TOKEN` (`api.go`). | **No** grant awareness. |

**Conclusion:** Custodian does **not** need to understand Forestrie grant maps, `grantData`, or transparent-statement layout. **Coupling belongs in canopy-api only:** `encodeGrantPayload` → bytes → Custodian `payload` → `mergeGrantHeadersIntoCustodianSign1` → base64/text response.

### Coupling already localized in canopy-api

| Module | Coupling |
|--------|----------|
| `grant/codec.ts` | Grant v0 CBOR wire. |
| `grant/transparent-statement.ts` | Decode expects digest payload + unprotected `-65538` (full grant v0). |
| `scrapi/custodian-grant.ts` | HTTP to Custodian + `mergeGrantHeadersIntoCustodianSign1` + `verifyCustodianEs256GrantSign1`. |

**Phase 2 helper already exists:** `signGrantPayloadWithCustodianCustodyKey` (`custodian-grant.ts`) calls `postCustodianSignGrantPayload` + `mergeGrantHeadersIntoCustodianSign1`. **No behavioral gap** in Custodian for the standard path.

### When Custodian changes would be needed (not required for this plan)

Extend arbor **only if** product later requires something the API does not offer today, for example:

- A **different** signed COSE `cty` or header policy per consumer (today one custodian statement `cty` for all keys).
- **Non-COSE** or **non-KMS** signing on the same route.
- **Rate / policy** hooks keyed off grant fields (would wrongly couple the service).

None of these are necessary to mint custody-signed grants: **treat Custodian as a digest-signing oracle; keep grant semantics in canopy.**

---

## Scope and non-goals

**In scope**

- One clear **call path** from canopy-api that builds a `Grant`, signs with **`CUSTODIAN_APP_TOKEN`** and a **caller-supplied or configured `keyId`**, returns the same **transparent statement** shape as bootstrap (base64 COSE bytes).
- **Reuse:** `encodeGrantPayload`, `postCustodianSignGrantPayload` (or a thin rename/wrapper), `mergeGrantHeadersIntoCustodianSign1`, `fetchCustodianPublicKey`, `verifyCustodianEs256GrantSign1` where tests need round-trip verification.
- **Conventions:** Match `bootstrap-grant.ts` / `index.ts` patterns (problem responses, env guards, `trim()` on URLs, Vitest + workerd like `bootstrap-grant.test.ts`).

**Out of scope (unless explicitly pulled in)**

- Changing Univocity / on-chain `grantData` rules (see Plan 0011).
- Register-grant **policy** for custody-minted grants (receipt bootstrap vs inclusion) — only ensure **verification** still works if someone registers such a grant (same verifier as any ES256 Custodian Sign1).
- **ES256K / secp256k1** custody keys: Custodian KMS can emit them; `verifyCustodianEs256GrantSign1` and `importSpkiPemEs256VerifyKey` are **P-256–only**. If product needs k1, add a **separate** follow-up in canopy-api + tests (still **no** Custodian change).

---

## Design (minimal)

### Token and key selection

- **Rule:** `keyId === ":bootstrap"` → use **`CUSTODIAN_BOOTSTRAP_APP_TOKEN`** (existing bootstrap route only).
- **Custody signing:** `keyId` must be **not** `:bootstrap`; use **`CUSTODIAN_APP_TOKEN`**.
- **Guard in code:** Reject custody calls that pass `:bootstrap` with app token or vice versa (mirror Custodian 401 behavior in client for clearer errors).

### Suggested HTTP surface (pick one in implementation)

**Option A (recommended for agents):** `POST /api/grants/sign` with JSON body describing grant fields + `keyId` (and optional `rootLogId` pattern mirroring bootstrap), authenticated same as bootstrap (or stricter if product adds auth later).  
**Option B:** Internal module only, no new route — first consumer is another handler (e.g. future x402 / subplan 06) that calls a shared `mintCustodySignedGrant(...)`.

The plan does not mandate A vs B; **deliver at least one executable path** with tests.

### `grantData` source

Callers minting child or authority grants must supply **`grantData`** consistent with Univocity (64-byte ES256 root key or 20-byte KS256 address). For parity with bootstrap, allow **fetching** pubkey from Custodian when `grantData` should match the signing key:

- `fetchCustodianPublicKey(custodianUrl, keyId)` → PEM → `publicKeyPemToUncompressed65` → `publicKeyToGrantData64` (extract **shared** normalization from `bootstrap-grant.ts` into `custodian-grant.ts` or `grant/grant-data.ts` **only if** duplication would otherwise grow; prefer a small exported helper used by bootstrap and custody).

---

## Implementation checklist (canopy-api)

Use this list in order for agentic runs.

1. **Read (no edits):** `scrapi/bootstrap-grant.ts`, `scrapi/custodian-grant.ts`, `grant/codec.ts`, `grant/transparent-statement.ts`, `index.ts` (bootstrap route wiring), `test/bootstrap-grant.test.ts`, `test/helpers/custodian-transparent-grant.ts`.
2. **Naming cleanup (optional but good):** Add `postCustodianSignOpaquePayload` as an alias or rename of `postCustodianSignGrantPayload` with JSDoc stating “opaque bytes; Custodian hashes to 32-byte COSE payload.” Keep the old export name re-exported for one release **or** update all call sites in the same change (prefer single PR, no deprecation period if repo is pre-release).
3. **Shared helper:** `signOpaquePayloadToForestrieGrantStatement({ custodianUrl, keyId, bearerToken, payloadBytes })` → `postCustodian…` + `mergeGrantHeadersIntoCustodianSign1` — used by bootstrap path and custody path to avoid drift.
4. **Custody mint handler:** Build `Grant` from request (validate flags, lengths, `logId` / `ownerLogId` wire rules — **reuse** validation patterns from bootstrap where possible). Resolve `grantData` (body bytes or derived from `fetchCustodianPublicKey` + normalize). `encodeGrantPayload` → sign with **`CUSTODIAN_APP_TOKEN`** → base64 response like bootstrap.
5. **`index.ts`:** Wire route when Option A; require `CUSTODIAN_URL` + `CUSTODIAN_APP_TOKEN` + validate `keyId !== ":bootstrap"` for this route.
6. **`wrangler.jsonc` / `.dev.vars` example:** Document new secret if not already present (0014 may already list `CUSTODIAN_APP_TOKEN`).
7. **Tests:** Vitest: mock fetch for `GET …/public` + `POST …/sign` (copy patterns from `bootstrap-grant.test.ts`); assert round-trip `decodeTransparentStatement` + `verifyCustodianEs256GrantSign1` with fetched PEM. Negative: wrong token class / `:bootstrap` keyId on custody route → 4xx.
8. **Docs:** Short pointer from Plan 0014 Phase 2 to this plan once implemented.

---

## Acceptance criteria

- Custody mint produces bytes that **`decodeTransparentStatement`** accepts and that **`verifyCustodianEs256GrantSign1`** validates using **`fetchCustodianPublicKey`** for the same `keyId`.
- **No new Custodian dependencies** for the happy path; integration tests (if any) use existing custodian test doubles or HTTP mocks consistent with `services/custodian` behavior.
- `pnpm run typecheck` and `pnpm run test` pass under `packages/apps/canopy-api`.

---

## Agent execution order (optimized)

1. Run checklist items **1–2** (read + optional rename) and freeze the public helper surface in `custodian-grant.ts`.
2. Implement **3–4** (shared sign wrapper + custody handler) with **no** `index.ts` exposure if using Option B first; add route in **5** when ready.
3. **7** tests before **6** docs if TDD preferred; otherwise tests immediately after handler.
4. **8** cross-link Plan 0014.

---

## Appendix: Custodian implementation plan (only if assessment fails)

**Trigger:** If future product requires Custodian to interpret grant CBOR, embed grant fields in COSE headers, or use a second signing protocol — **do not** do that for grant signing; keep using opaque `payload` / `payloadHash`.

If the **only** gap is operational (e.g. new env for KMS key ring), that is **deployment/README**, not a code plan here.

**If** a true API gap appears (example: batch sign, sync HSM, non-ECDSA alg):

1. Extend **`SignRequest`** / `DigestFromSignRequest` in arbor only with **backward-compatible** CBOR fields.
2. Add tests in `services/custodian/src/*_test.go` mirroring `sign_digest_test.go`.
3. Update `services/custodian/README.md` and arbor plan-0001 addendum.
4. Bump canopy-api client only if request shape changes.

---

## References

- Plan 0014 Phase 2 sketch and terminology.
- `arbor/services/custodian/src/handle_sign_key.go`, `types_key_sign.go`, `cose_custodian_sign1.go`.
- Canopy: `packages/apps/canopy-api/src/scrapi/custodian-grant.ts`, `scrapi/bootstrap-grant.ts`.
