# Canopy grant verification — implementation map

**Status**: DRAFT  
**Date**: 2026-03-19 (§8–§9 partially corrected 2026-08-09 — see the §9 banner; several P0 gaps are closed and the P4 split is implemented)  
**Related**: [ARC-0019 grant verification model](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md), [arc-statement-cose-encoding.md](arc/arc-statement-cose-encoding.md), [arc-grant-statement-signer-binding.md](arc/arc-grant-statement-signer-binding.md)

Platform logical model (§0–7): [devdocs ARC-0019](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md).

Implementations live under `packages/apps/canopy-api/src/grant/` and `scrapi/`
(register-grant, register-signed-statement).

## 8. Current implementation locations

| Concern                      | Location                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grant types                  | `packages/apps/canopy-api/src/grant/grant.ts`, `grant-assembly.ts`, `grant-commitment.ts`                                                                                                                           |
| Leaf commitment              | `packages/apps/canopy-api/src/grant/leaf-commitment.ts`                                                                                                                                                             |
| Receipt parse / verify       | `packages/apps/canopy-api/src/grant/receipt-verify.ts`                                                                                                                                                              |
| Transparent statement decode | `packages/apps/canopy-api/src/grant/transparent-statement.ts` — **decode only; no signature verify**                                                                                                                |
| Register-grant               | `packages/apps/canopy-api/src/scrapi/register-grant.ts`                                                                                                                                                             |
| Bootstrap signature          | `packages/apps/canopy-api/src/scrapi/bootstrap-public-key.ts` — `verifyBootstrapCoseSign1` (**§4.3 only**)                                                                                                          |
| Grant auth / get grant       | `packages/apps/canopy-api/src/scrapi/auth-grant.ts` — `getGrantFromRequest` decodes only; **authenticity is verified downstream** — receipt inclusion vs the `ownerLogId` authority in `grantAuthorize` (`auth-grant.ts:292-375`) and issuance-path envelope verify (§9 banner) |
| Statement signer binding     | `packages/apps/canopy-api/src/grant/statement-signer-binding.ts` — `isStatementRegistrationGrant`, `statementSignerBindingBytes` (**grantData** only)                                                               |
| Grant bitmap                 | `packages/apps/canopy-api/src/grant/grant-flags.ts` — **`hasCreateAndExtend`**, **`isDataLogStatementGrantFlags`**, **`hasExtendCapability`**, **`hasDataLogClass`** (assumed low-byte layout; verify vs univocity) |
| Register-signed-statement    | `packages/apps/canopy-api/src/scrapi/register-signed-statement.ts` — **`isStatementRegistrationGrant`** + **`statementSignerBindingBytes`** vs **kid**                                                              |

---

## 9. Required implementation changes in Canopy (gap list)

> **Correction 2026-08-09 (verified against `main`, file:line).** Much of this
> gap list is **stale** — it was written before the child-log onboarding and
> creation-validation work landed. What is now implemented:
>
> - **Grant envelope IS verified against the owning authority** on the issuance
>   paths. Creation grants: `register-grant.ts:208-254` delegates to
>   `env.creationGrantValidator.validate(...)` (univocity verifies the envelope
>   against the owner authority key), and the pre-sign path verifies locally in
>   `prepare-child-log.ts:125-195` (`verifyCreateGrantAgainstParent`) against the
>   **parent `K(L)` / genesis bootstrap** key. Derived-endorsement grants:
>   `verify-derived-endorsement-envelope.ts:12-47` against the endorser bootstrap
>   key. The verifying key is the **authority**, never the grant's own
>   `grantData` — so the "issuance signer vs endorsed statement signer" split
>   (P4 / §6.3.3 below) is **implemented**, not pending.
> - **A `K(L)`-by-`ownerLogId` resolver exists** — `env.resolveReceiptAuthority`
>   (`auth-grant.ts:292-375`, wired at `register-grant.ts:260`), closing the core
>   of §9.2.
> - **`register-signed-statement` establishes grant authenticity by receipt
>   inclusion** (`grantAuthorize`, `register-signed-statement.ts:154`) against the
>   `ownerLogId` authority, then enforces §6 (`kid` binding + statement signature
>   vs the `grantData` key, `:208-269`) and requires `ownerLogId != logId` for
>   data-log statement grants (`:195-202`). It does **not** re-verify the grant
>   envelope in-handler — **by design**, not as a gap (authenticity comes from
>   inclusion against the authority).
>
> Platform reference: **devdocs [ARC-0019 §6.3](https://github.com/forestrie/devdocs/blob/main/archive/2603/arc/arc-0019-grant-verification-model.md)** (revised 2026-08-09) now documents this as the shipped model. **Residual real gap:** test coverage of the parent-authority verify path and the `ownerLogId != logId` guard — tracked as **[FOR-535](https://linear.app/forestrie/issue/FOR-535)** (see §9.5). The per-row notes below mark what is closed vs. still open.

This section is **normative for engineering planning**. **Priority:**

| Tier                         | §§                     | Meaning                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 — security / issuance** | **§9.1–9.4**           | **§4** envelope signature on Forestrie-Grant, **K(L)** resolution, register-grant order of checks. Without these, grants are not cryptographically tied to the authority log signer.                                         |
| **P1 — tests & contracts**   | **§9.5–9.6**           | Coverage and API docs for **§4**; clarify envelope vs **§6** **kid** in arc-grant-statement-signer-binding.                                                                                                                  |
| **P2 — later**               | **§9.7**               | Receipt signature, on-chain witness tie-in.                                                                                                                                                                                  |
| **P3 — contract alignment**  | **§9.8**               | **`GF_*`** checks on **register-signed-statement** once univocity bit layout lives in-repo (**§6.1**). Parity with **`PublishGrant.grant`**; **not** a substitute for **P0** (bitmap checks do not replace envelope verify). |
| **P4 — product model**       | **§6.3.3** (**D1–D6**) | **Issuance vs endorsed statement signer — IMPLEMENTED** (2026-08-09). The envelope is verified against the `ownerLogId` authority; `grantData` endorses a distinct statement signer. Only test coverage remains ([FOR-535](https://linear.app/forestrie/issue/FOR-535)). See devdocs ARC-0019 §6.3. |

**§5** (receipt / inclusion) is **already implemented** when **`inclusionEnv`** is set (**§9** does not re-list it as a gap). The tables above emphasize **P0** (**§4** envelope + **K(L)**) and **P3** (recommended **§6.1** bitmap checks).

### 9.1 Grant transparent statement — cryptographic verification

**Status 2026-08-09: largely CLOSED on the issuance paths** (creation → univocity `creationGrantValidator` + `prepare-child-log.ts` parent-authority verify; derived → `verify-derived-endorsement-envelope.ts`). The gap text below is retained as historical context; the blanket "no COSE Sign1 verify" claim is no longer accurate — see the §9 banner.

| Gap                                                  | Action                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No COSE Sign1 verify on Forestrie-Grant envelope** | After obtaining raw transparent statement bytes, **verify** the outer COSE Sign1 signature per RFC 9053 (`Sig_structure`, algorithm from protected header) before treating the grant as authentic. Reuse or extend helpers (cf. `@canopy/encoding` `verifyCoseSign1` used in tests; `decodeCoseSign1` in `bootstrap-public-key.ts`). |
| **Decode vs verify conflated**                       | Split **`getGrantFromRequest`**: (a) parse + verify signature → (b) decode payload. Fail closed if signature invalid.                                                                                                                                                                                                                |

**Scope:** **`getGrantFromRequest`** is used for **register-grant** and **register-signed-statement**; missing envelope verify (**§4**) affects **both** paths until this gap is closed (bootstrap **§4.3** remains separate).

### 9.2 Resolving **K(L)** and delegates

**Status 2026-08-09: CLOSED (core).** `env.resolveReceiptAuthority(ownerLogId)` exists and is used (`auth-grant.ts:292-375`, `register-grant.ts:260`); it keys off `ownerLogId`, not the URL target `logId`. Caching/invalidation specifics below may still apply.

| Gap                                                   | Action                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No resolver for checkpoint signer by `ownerLogId`** | Implement **`resolveCheckpointVerifyingKeys(ownerLogId)`** that returns **K(L)** plus configured delegates. Sources: (1) Univocity / on-chain reader; (2) bootstrap grant → **`grantData`**; (3) operator env allow-list (dev). |
| **Child vs parent logs**                              | Ensure **`ownerLogId`** on the inner grant is the **MMR parent** for the leaf; resolver must key off **that** id, not only URL **`logId`** (target). |
| **Caching**                                           | Cache **K(L)** per **L** with invalidation on new bootstrap or checkpoint policy (TTL or event-driven).                                              |

### 9.3 Delegation model (wire + config)

| Gap                               | Action                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delegates not defined**         | Specify how a delegate proves authority: e.g. **x5c** chain in COSE protected header, **CWT** `delegation` claim, or **config-only** extra keys certified offline. Document in a short ADR or extend ARC-0019. |
| **Bootstrap / platform delegate** | Formalise current **Custodian** as **K(L)** when **L** uninitialised (**§4.3**); ensure env documents trust assumptions.                                                                            |

### 9.4 register-grant control flow

**Status 2026-08-09: partially superseded.** Issuance now branches by target-log state and flags (creation → `creationGrantValidator`; derived → `verifyDerivedEndorsementEnvelope`; steady-state → receipt inclusion via `grantAuthorize`) — `register-grant.ts:169-263`. The "non-bootstrap path skips §4" line is no longer accurate for the creation/derived paths. Steady-state authenticity is by receipt inclusion against the `ownerLogId` authority, by design.

| Gap                                        | Action                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Non-bootstrap path skips §4**            | After `grantAuthorize` / receipt success, **still insufficient** — add **`verifyGrantTransparentStatement(bytes, assembly)`** that runs **§4** using **`assembly.ownerLogId`**.                                                                  |
| **Queue-only mode** (`bootstrapEnv` unset) | Today enqueues with **no** inclusion and **no** envelope verify — **unsafe** for production. **Options:** require **`bootstrapEnv`** whenever queue is on; or require **§4** even without receipt; document **dev-only** if kept. |
| **Order of checks**                        | Recommended: **parse → §4 signature → §5 receipt** (fail fast on bad crypto).                                                                                                                                                                    |

### 9.5 Testing and observability

**Status 2026-08-09: this is the main OPEN gap.** Tracked as **[FOR-535](https://linear.app/forestrie/issue/FOR-535)**. Direct canopy-side coverage of the parent-authority verify path (`prepare-child-log.ts` `verifyCreateGrantAgainstParent`) and the `ownerLogId != logId` 403 guard (`register-signed-statement.ts:195-202`) is absent; only the derived-endorsement path and the mock-`CreationGrantValidator` decision mapping are tested.

| Gap                                                   | Action                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **No tests for envelope signature on register-grant** | Add integration tests: valid signature with **K(L)** → 303; wrong key → 403; bootstrap path unchanged. Cover `ownerLogId != logId` → 403 and the parent-authority create-grant verify. ([FOR-535](https://linear.app/forestrie/issue/FOR-535)) |
| **Logging**                                           | On §4 failure, log **L**, key id / thumbprint (no raw secrets), and reason (no key resolved vs bad sig). |

### 9.6 Documentation and API contracts

| Gap                                    | Action                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **register-grant.md / Plan 0005**      | State that **Forestrie-Grant** MUST be a **valid COSE Sign1** under **K(ownerLogId)** or delegate.      |
| **arc-grant-statement-signer-binding** | Distinguish **envelope** signer (**§4**, register-grant) vs **statement kid** (**§6**, register-entry). |

### 9.7 Optional hardening (later)

- Verify **receipt** COSE signature (**§5**) where the receipt is signed by **log builder** / ranger.
- Tie **K(L)** to **contract** `publishCheckpoint` witness instead of only off-chain store.

### 9.8 register-signed-statement — univocity **`grant`** bitmap (P3 — recommended)

| Gap                              | Action                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bitmap vs univocity**          | Confirm **`GF_*`** bit positions in **`grant-flags.ts`** match **`constants.sol`**; **`isStatementRegistrationGrant`** already combines data-log and bootstrap auth paths. |
| **`request` / `GC_*` vs bitmap** | When univocity defines **`GC_*` ↔ `GF_*`** invariants, add **`assertRequestMatchesGrantFlags`** for hydrated **`Grant.request`** (**§6.2**).                              |
| **logId vs flags**               | Optionally cross-check URL **`logId`** / **`grant.logId`** against policy (out of scope until log-kind API is stable).                                                     |

---

MMR verification uses `@canopy/merklelog` with an async digest (e.g. `crypto.subtle.digest("SHA-256", …)`) on Workers.
