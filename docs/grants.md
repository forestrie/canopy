# Grants in Canopy

**Status:** DRAFT  
**Date:** 2026-03-28  
**Related:** [ARC-0001: Grant verification](arc-0001-grant-verification.md), [Univocity ARC-0017 — Authorization overview](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md) (on-chain two-check model; [§5.1 ingress vs verifier](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md#51-off-chain-ingress-vs-this-contract-forestrie--canopy)), [Univocity ARC-0017 — Log hierarchy](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-log-hierarchy-and-authority.md) (`authLogId`, `ownerLogId`, Phase 0), [Grant–statement signer binding (code paths)](arc-grant-statement-signer-binding.md), [Register-grant API](api/register-grant.md), [Plan 0007 grant type alignment](plans/plan-0007-grant-type-and-commitment-alignment.md)

This page is a **single entry point** for Forestrie grant **shapes**, **wire formats**, and how **creation** (register-grant) and **consumption** (register-signed-statement) differ in what they verify. Normative security obligations live in **ARC-0001**; this document orients readers before diving there.

---

## 1. Three log roles (bootstrap vs auth vs data)

Univocity models an **authority tree**. Canopy exposes HTTP paths that mention a **log id** in the URL; that id can refer to different **kinds** of log.


| Concept | Meaning |
| ------- | ------- |
| **Bootstrap (root) auth log** | The **first** authority log in a deployment. It has **no parent** in the forest. Its first grant is special: there is no prior MMR leaf, so issuance uses a **platform bootstrap** path (Custodian) instead of a receipt. After sequencing, **grantData** on that leaf establishes **K(L)**—checkpoint signer material for root authority log **L**. |
| **Child auth log** | A **descendant** authority log. Grants that **create** it are **leaves in the parent’s** authority MMR (**ownerLogId** = parent). The child’s **logId** is the **target** of those grants. Later grants may append under **ownerLogId** = child (or parent), per product rules. |
| **Data log** | A **subject** log for transparency **statements** (entries). It is **owned** by an **authority log**: checkpoint and **grant policy** for that data log are expressed as leaves in **that auth log’s** MMR—not as special entry types inside the data log. |

An **auth log** UUID names an **AUTH_LOG** node in the tree. A **data log** UUID names a **DATA_LOG** subject; some **owning** authority log (via **ownerLogId** on grants targeting it) issues policy as MMR leaves. **Bootstrap** is not a separate log *kind*—it is the **root** auth log in the window before and through its first grant.

In the Forestrie / Univocity **authorization** story, a grant that can **authorize** anything—on-chain checkpoint publication, **Forestrie-Grant** issuance ([ARC-0001](arc-0001-grant-verification.md) §4–§5), or **`POST …/entries`** (§6)—is a **leaf in an authority log’s** MMR, i.e. under **ownerLogId** ([ARC-0001 §0.3](arc-0001-grant-verification.md)). Register-signed-statement consumes a grant already committed in the **owning** auth tree. Opaque **data log entry** payloads, even grant-shaped CBOR, do not replace that: `grantAuthorize` and receipts bind the **grant commitment** to **ownerLogId**’s authority MMR, not to entry bodies on the target data log.

**Verification**, not raw **inclusion** in a queue, enforces the model. The sequencing queue and log builders may treat ids as opaque (e.g. UUID + content hash only) and skip AUTH vs DATA classification—on purpose, for **throughput** and simpler workers. Producers must still set **ownerLogId** to the real **owning authority**; wrong ids or “grant as entry only” still fail checks against the correct authority MMR.

**`publishCheckpoint`** on Univocity applies the same **two gates** as in [ARC-0017 (auth overview)](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md): **grant** inclusion in the target’s **owner** ([`authLogId` semantics](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-log-hierarchy-and-authority.md#42-single-authlogid-owning-data-or-parent-authority)) and a **receipt** verifiable under **rootKey** / bootstrap rules. A rejected checkpoint does not advance that log’s **split-view–protected**, **univocal** on-chain history. The split between cheap ingress and strict verification is spelled out in Univocity [§5.1](https://github.com/forestrie/univocity/blob/main/docs/arc/arc-0017-auth-overview.md#51-off-chain-ingress-vs-this-contract-forestrie--canopy); Forestrie-Grant HTTP paths follow the same idea ([Takeaways](#takeaways) below).

### Takeaways

- **Roles:** Auth log vs data log vs bootstrap (root’s first-grant story); data logs are **owned** by an auth log.
- **Where policy lives:** Authorizing grants are **authority MMR** leaves under **ownerLogId**; data-log **entries** are not a substitute.
- **Who enforces:** **Verifiers** (Canopy + contract), not sequencers’ log-kind checks; wrong **ownerLogId** still fails verification.
- **On-chain:** Invalid checkpoints do not extend **univocal** history; see Univocity ARC-0017 §5.1.

---

## 2. `logId` vs `ownerLogId` (authorized vs owning)

Every inner grant (Forestrie-Grant **v0**) carries two UUIDs (16-byte wire form in API docs; commitment uses 32-byte padded form in code—see `grant-commitment.ts`).


| Field            | Role                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**logId`**      | **Target** of the grant: the log being authorized or described by this grant (e.g. the **data log** receiving checkpoint/statement rights, or the **child auth log** being created). **`POST /register/grants`** and **`POST /register/entries`** use **`grant.logId`** only—no redundant path segment. |
| `**ownerLogId**` | **Owning authority log** under whose **authority MMR** this grant will be sequenced as a **leaf**. That is: the new leaf extends `**ownerLogId`’s** Merkle history—not the target log’s, unless target and owner coincide (bootstrap).                                          |


So:

- `**logId**` answers: *what entity does this grant apply to?*  
- `**ownerLogId**` answers: *whose authority log accrues this leaf, and whose checkpoint signer **K(ownerLogId)** must issue the grant envelope (ARC-0001 §3–4)?*

**Bootstrap:** `**logId` = `ownerLogId**` (same root UUID): the first grant both **targets** and **extends** that root authority log.

**Child first grants:** `**logId` ≠ `ownerLogId**`: **`grant.logId**` is the **uninitialized child** (data or auth); `**ownerLogId**` is the **initialized parent** authority log that is ready to sponsor the first leaf for that child.

**Routine grants** on initialized logs: typically `**ownerLogId**` is the authority log that already contains policy, and `**logId**` is the data log (or child) being granted—exact pairing follows product/univocity rules; the commitment always commits **both** fields.

---

## 3. Wire format: Forestrie-Grant v0 and transparent statement

### 3.1 Inner grant (payload CBOR)

The **inner** artifact is a CBOR map with **keys 1–6 only**:


| Key | Field                    | Role                                                                               |
| --- | ------------------------ | ---------------------------------------------------------------------------------- |
| 1   | `logId`                  | Target log (canonical POST has no URL `logId`; value comes from the grant only).      |
| 2   | `ownerLogId`             | Authority log that owns the grant leaf.                                            |
| 3   | `grant`                  | 8-byte `**GF_***` bitmap (create/extend, auth-vs-data class, …).                   |
| 4–5 | `maxHeight`, `minGrowth` | Optional bounds (also in commitment preimage).                                     |
| 6   | `grantData`              | Opaque committed bytes; **only** v0 attestation slot for statement-signer binding. |


Keys **7** (`signer`) and **8** (`kind`) are **rejected** by decoders. There is **no** separate wire “signer”: anything committed about **who may sign statements** must live in `**grantData**` (or a future structured layout inside it—ARC-0001 §6.3).

### 3.2 Custodian transparent statement profile (Plan 0014)

For `**Authorization: Forestrie-Grant**`, the bytes are a **COSE Sign1** “transparent statement” where:

- **Payload** = **32-byte** `SHA-256(inner grant v0 CBOR)` (digest ties signature to exact grant bytes).
- **Unprotected** header `**-65538**` = **full** grant v0 CBOR (embedded copy).
- `**-65537**` = **idtimestamp** (8 bytes), required for **completed** grants on receipt paths.
- `**396**` = embedded **receipt** COSE Sign1 (MMR inclusion proof) when not on a bootstrap / first-grant shortcut path.

Decoding checks digest **matches** embedded grant bytes (`transparent-statement.ts`).

### 3.3 Grant commitment (what the chain commits)

The **grant commitment hash** (leaf **inner** hash input, modulo idtimestamp) is:

`SHA-256( logId(32) || grant_flags(32) || maxHeight_be(8) || minGrowth_be(8) || ownerLogId(32) || grantData )`

- `**grant**` on wire is 8 bytes; the preimage pads it to 32 bytes (`grant-commitment.ts`).
- `**PublishGrant.request**` / `**GC_***` is **not** in this preimage (may exist on-chain only).
- **Idtimestamp** is **not** in the grant preimage; it participates in the **leaf** hash with the commitment hash (`ARC-0001` §5.3).

Anything **not** in this preimage cannot be enforced by comparing to on-chain **PublishGrant** commitment—only by ancillary policy.

---

## 4. Signer commitments vs actual grant (envelope) signer

Two different questions must not be conflated:

| Question | Where answered | Typical key material |
| -------- | -------------- | -------------------- |
| **Who signed the transparent Forestrie-Grant?** | **COSE Sign1** on `Authorization: Forestrie-Grant` (issuance / **envelope** signer). | Must be **K(ownerLogId)** or an **authorised delegate** (ARC-0001 §4)—**bootstrap** uses Custodian as delegate when the log is uninitialized. |
| **Who may sign data statements** (`POST …/entries`) **for statement-registration grants?** | **grantData** only → `statementSignerBindingBytes(grant)` vs statement COSE **kid** (ARC-0001 §6). | Often **ES256 x‖y (64 bytes)**; binding uses **first 32 bytes (x)** when length is 64. |

Only **grantData** (inside the **commitment preimage**) binds who may sign **entries** on wire v0; there is no parallel “signer” field. The **envelope** (COSE on `Authorization: Forestrie-Grant`) proves **who issued** the leaf under **ownerLogId**. **grantData** is the issuer’s attestation of who may sign **statements**, for grants that satisfy `isStatementRegistrationGrant`.

### Child first-grant paths: issuance tied to grantData

On **child auth first** and **child data first**, `register-grant.ts` uses `verifyCustodianEs256GrantSign1WithGrantDataXy`: the transparent statement must verify against the **ES256** key encoded in the same **64-byte grantData (x‖y)**—so the signer holds **grantData**’s private key, not an abstract **K(parent)** alone.

That does **not** weaken **register-signed-statement**: §6 still requires **kid** = **`statementSignerBindingBytes(grant)`** from **grantData** only. One party holding both keys stays coherent. The **product gap** is narrower: **first-grant** registration cannot yet combine a **parent-signed** envelope with **grantData** that names a **different** endorsed entry signer ([ARC-0001 §6.3](arc-0001-grant-verification.md), D1–D6). **Root bootstrap** is different: Custodian verifies the envelope; **grantData** then fixes **K(L)** ([ARC-0001 §4.3](arc-0001-grant-verification.md)).

### Signer takeaways

- **Two keys:** Envelope = who **issued**; **grantData** = who may sign **entries** (§6 **`kid`**).
- **Child first path:** Envelope signer must equal **grantData** key today; parent-only issuance + different endorser is future work (§6.3).
- **Bootstrap:** Custodian envelope; **grantData** establishes root **K(L)**.

---

## 5. Flag shapes: statement registration vs “other” grants

`**GF_*` live in the 8-byte `grant` field** and **are** in the commitment preimage. `**GC_*` / `request**` is a separate on-chain field, **not** in the preimage (ARC-0001 §6.0).

### 5.1 `isStatementRegistrationGrant` (register-signed-statement gate)

The API allows `**POST /register/entries**` only when this predicate holds (`statement-signer-binding.ts`):

1. **Data-log path:** `**GF_DATA_LOG**` set in the low class byte, `**GF_AUTH_LOG` not** set for class, and **extend capability** (including **GF_CREATE|GF_EXTEND** first-grant pattern): `isDataLogStatementGrantFlags`.
2. **Root auth bootstrap / checkpoint shape:** low byte is **auth-only** (`GF_AUTH_LOG`, not `GF_DATA_LOG` in the **0x03** nibble) **and** `**GF_CREATE|GF_EXTEND**` on byte 4.

So **statement registration** is **either** a **data-log checkpoint grant** **or** the **root auth bootstrap-style** grant (same `statementSignerBindingBytes` rule from `**grantData**`).

### 5.2 Other grant shapes (checkpoint / tree growth)

Many grants are **not** meant for `**/entries**` auth: e.g. grants whose flags do not satisfy the above. They still extend an authority MMR when sequenced; their `**grantData**` semantics follow univocity / product rules. For **register-grant**, shape determines **which branch** runs (bootstrap, child first, receipt).

---

## 6. Register-grant: creation paths (current code)

All successful paths **enqueue** the **grant commitment hash** under `**ownerLogId**` (truncated to sequencing id as implemented). **Target log** **`grant.logId`** is the only operational id for the grant subject (no path duplicate on **`POST /register/grants`**).


| Path                    | When                                                                                                                                                                | Envelope verification (summary)                                                                                                               | Receipt                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **A. Root bootstrap**   | Log **uninitialized**; `**ownerLogId` = `logId**`, `**GF_CREATE                                                                                                     | GF_EXTEND`**,` bootstrapEnv` set                                                                                                              | **Custodian** ES256 verify (`verifyCustodianEs256GrantSign1`) |
| **B. Child auth first** | **Target** log **uninitialized**; `**logId`** = child auth; `**ownerLogId**` = **initialized** parent; `**GF_AUTH_LOG`** class, **create+extend**; **64-byte** `grantData` | `**verifyCustodianEs256GrantSign1WithGrantDataXy`**                                                                                           | None                                                          |
| **C. Child data first** | **Target** log **uninitialized**; `**GF_DATA_LOG`**, not auth class; parent initialized; **64-byte** `grantData`                                                           | Same **grantData**-key verify                                                                                                                 | None                                                          |
| **D. Receipt-backed**   | Log **initialized** (or no `bootstrapEnv`), or any case not matching A–C                                                                                            | `**grantAuthorize`**: idtimestamp + **§5** MMR proof (ARC-0001); **§4** envelope vs **K(owner)** is **normative target**, see ARC **§9** gaps | Required in header **396** when applicable                    |


If `**bootstrapEnv`** is unset, only **D** applies for acceptance (queue still required).

---

## 7. Register-signed-statement: verification summary

After resolving `**Authorization: Forestrie-Grant`** to a `**Grant**`:

1. **Inclusion** when required: receipt / **§5** (same family as register-grant completed artifact).
2. `**isStatementRegistrationGrant(grant)`** must be **true** (403 otherwise).
3. `**grantData` non-empty**; statement COSE `**kid`** must match `**statementSignerBindingBytes(grant)**` (`signer_mismatch` if not).

Full `**§4**` envelope verification on `**/entries**` is tracked as implementation gap (**ARC-0001 §9.1**); `**kid`** binding is `**grantData`–only** and must stay tied to the **commitment** end state (§6.3 non-goals).

---

## 8. Quick reference: “which document?”


| Topic                                                    | Document                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Formal model, §4/§5/§6 obligations, circularity, roadmap | [ARC-0001](arc-0001-grant-verification.md)                                  |
| Byte flow for `kid` vs `grantData`, pool / k6            | [arc-grant-statement-signer-binding](arc-grant-statement-signer-binding.md) |
| HTTP request body vs header (legacy body note)           | [api/register-grant.md](api/register-grant.md)                              |
| COSE / hashing details                                   | [arc-statement-cose-encoding.md](arc-statement-cose-encoding.md)            |


---

## 9. Implementation map


| Concern                           | Location                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Inner grant + preimage            | `packages/apps/canopy-api/src/grant/grant.ts`, `grant-commitment.ts`, `codec.ts` |
| Flags / statement grant predicate | `grant-flags.ts`, `statement-signer-binding.ts`                                  |
| Transparent statement decode      | `grant/transparent-statement.ts`                                                 |
| Register-grant branches           | `scrapi/register-grant.ts`                                                       |
| Receipt + `grantAuthorize`        | `scrapi/auth-grant.ts`, `grant/receipt-verify.ts`                                |
| Register-signed-statement         | `scrapi/register-signed-statement.ts`                                            |


