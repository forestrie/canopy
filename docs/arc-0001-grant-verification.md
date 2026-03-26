# ARC-0001: Grant verification (receipt-based inclusion, grant-statement signature, and signer binding)

**Status**: DRAFT  
**Date**: 2026-03-19  
**Related**: [Plan 0005 grant and receipt as single artifact](plans/plan-0005-grant-receipt-unified-resolve.md), [Subplan 08 grant-first bootstrap](plans/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md), [Subplan 01 shared encoding](plans/plan-0004-log-bootstraping/subplan-01-shared-encoding-univocity-alignment.md), [Subplan 03 grant-sequencing](plans/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md), [Plan 0007 grant type alignment](plans/plan-0007-grant-type-and-commitment-alignment.md), [ARC — statement COSE vs grant preimage](arc-statement-cose-encoding.md#4-grant-commitment-preimage-vs-cose-headers)

## Purpose

This document is the **single reference** for how Canopy verifies that an auth grant is allowed for a request. It is referenced by subplans, plans, and API docs wherever grant auth or inclusion is specified.

**§0** states the **logical model**. **§§1–6** state **verification obligations** (when they apply, circularity, checkpoint signer, grant-statement signature, receipts, register-entry binding). **§7** is **summary pseudocode**. **§8** maps **current code**. **§9** lists **implementation gaps** by priority: **envelope signature and K(L) resolution (§4)** are **required** for production trust; **§5–§6** items are **receipt / register-statement** alignment; **§9.8** is **recommended** once univocity **`GF_*`** bit layout is duplicated in-repo (contract alignment for data-log `/entries`).

Three verification aspects:

1. **Grant statement signature (register-grant)** — the **transparent statement** (COSE Sign1 wrapping the grant) MUST be **cryptographically verified**, and the signing identity MUST be the **checkpoint signer** for the **authority log the grant leaf is appended under** (`ownerLogId`), or an **authorised delegate** thereof (§4). This is what makes **checkpoint signer** the sole party that can **issue** grants whose leaves extend that subtree: **data log** creation/extension, **child AUTH_LOG** creation, and (by induction on the tree) their descendants—because every such grant is a leaf in some owner authority MMR, and only **K(ownerLogId)** (or its delegate) may sign the issuance envelope.

2. **Receipt-based inclusion verification** — show that the grant’s leaf is included in the relevant authority MMR, using a **grant receipt** (COSE Sign1 carrying an MMR inclusion proof) (§5). Aligns with proving consistency against accumulator state before a checkpoint would be **accepted** on-chain (§0).

3. **Signer binding (register-signed-statement)** — Forestrie-Grant wire **v0** is a CBOR map with keys **1–6** only (no **`kind`**, **`signer`**, **`version`**, **`exp`**, **`nbf`**); see **§6.0**. The **statement**’s signer (e.g. COSE `kid`) MUST match **`grantData`** via **`statementSignerBindingBytes(grant)`** (§6). The **`grant`** bitmap MUST satisfy **`isStatementRegistrationGrant`** (data-log checkpoint grant **or** root auth bootstrap shape). **§6.1** gives plain language and **`GF_*` vs `GC_*`**. **Who may issue** the grant is **§4** only: transparent-statement signature vs **K(ownerLogId)** (or delegate).

Implementations live under `packages/apps/canopy-api/src/grant/` and `scrapi/` (register-grant, register-signed-statement).

---

## 0. Logical model

### 0.1 Formal overview

Let $\mathcal{A}$ be the set of AUTH_LOG Merkle logs.

Let $A_n \in \mathcal{A}$ denote the AUTH_LOG at level $n \in \mathbb{N}$.

Define the parent relation by

$$
\operatorname{parent}(A_n) =
\begin{cases}
A_{n-1} & n > 0, \\
A_0     & n = 0.
\end{cases}
$$

#### Grants

Let $G_i^{(n)} \in A_n$ denote the grant at index $i$.

Each grant carries parameters

$$
\operatorname{range}(G_i^{(n)}) \in \mathbb{N}, \qquad
\operatorname{granularity}(G_i^{(n)}) \in \mathbb{N}.
$$

Grants authorise publication of receipts:

$$
G_i^{(n)} \vdash \operatorname{publish}(C_j, S)
$$

#### Receipts (checkpoints)

A checkpoint is a consistency proof (receipt) for an MMR.

$$
C_j = \operatorname{receipt}(A_n, k)
$$

$$
\operatorname{index}(C_j) = k
$$

Each receipt proves that the log has grown append-only to index $k$.

#### Contract acceptance

Let $S$ denote the split-view protecting smart contract.

A receipt is accepted iff its consistency proof verifies against the current accumulator state:

$$
\operatorname{accepts}(S, C_j)
\iff
\operatorname{verifyConsistency}(C_j,
\operatorname{peaks}(S, A_n))
$$

#### MMR accumulator

The contract stores only the MMR peaks:

$$
\operatorname{peaks}(S, A_n)
$$

Acceptance updates the accumulator:

$$
\operatorname{accepts}(S, C_j)
\;\Longrightarrow\;
\operatorname{peaks}(S, A_n)
\leftarrow
\operatorname{updateMMR}(
\operatorname{peaks}(S, A_n),
C_j
)
$$

#### Constraints from grants

Publication is constrained by the grant:

$$
\operatorname{index}(C_j) \leq \operatorname{range}(G_i^{(n)})
$$

$$
\forall C_j, C_{j+1} :
\Delta(C_j, C_{j+1}) \leq
\operatorname{granularity}(G_i^{(n)})
$$

Thus, grants expire via index exhaustion rather than revocation.

#### Global consistency

Accepted receipts define a globally consistent log view:

$$
\operatorname{accepts}(S, C_j)
\;\Longrightarrow\;
\operatorname{globally\_consistent}(A_n)
$$

### 0.2 Informal illustrations (non-normative)

**Parent log** — example sequence on $A_0$:

$$
A_0 = (G_b,\; L_0,\; G_1,\; G_2,\; L_i)
$$

Here $G_b$ can be read as a **bootstrap** grant, $G_1$, $G_2$ as further grants, and $L_*$ as non-grant leaves (e.g. data-log or other entries), illustrating that grants and other leaves share the same append-only structure.

**Child log** — example on $A_1$ (a descendant authority log):

$$
A_1 = (L_0,\; L_1,\; G_2,\; L_i)
$$

**Receipt over child log** — a checkpoint for $A_1$ up to index $1$:

$$
C_0 = \operatorname{receipt}(A_1, 1)
$$

**Publication** — grant $G_1$ authorises publishing that receipt to the contract:

$$
G_1 \vdash \operatorname{publish}(C_0, S)
$$

**Contract verification** — acceptance uses peaks for $A_1$:

$$
\operatorname{verifyConsistency}(C_0,
\operatorname{peaks}(S, A_1))
$$

**MMR update intuition** — after acceptance, peaks advance:

$$
\operatorname{peaks}(S, A_1)
\;\rightarrow\;
\operatorname{updateMMR}(\cdot, C_0)
$$

### 0.3 Mapping to Canopy (this ARC)

| Model (§0.1) | Role in Canopy |
|--------------|----------------|
| AUTH_LOG $A_n$ | The **owner authority log** identified by the grant’s **`ownerLogId`**. New grant leaves are appended to **that** log’s authority MMR (Subplan 03 / ranger). **`logId`** is the **target** of the grant (e.g. data log or child auth log UUID); **`ownerLogId`** is where the **grant leaf** lives. |
| Checkpoint signer **K(L)** | For authority log **L**, the key material Univocity uses to validate **checkpoints** for **L** (root case: **ES256** key in bootstrap **`grantData`**). **Register-grant** MUST verify the **transparent statement** is signed by **K(L)** or a **delegate** (§4), where **L** is **`bytesToUuid(ownerLogId)`** for the inner grant. |
| Grant $G_i^{(n)}$ | **`PublishGrant`** commitment + Forestrie-Grant wire **v0** (keys **1–6**; **`GrantAssembly` = `Grant`**) ([Plan 0007](plans/plan-0007-grant-type-and-commitment-alignment.md)). **Issuance** of $G$ is the signed transparent statement; **membership** of the leaf is §5. For **register-statement**, **`isStatementRegistrationGrant`** (**`GF_*`**) and **`grantData`** vs **`kid`** apply (**§6**). |
| $\operatorname{range}$, $\operatorname{granularity}$ | On-chain **`maxHeight`**, **`minGrowth`**; contract-enforced at checkpoint publish. |
| Receipt $C_j$ | Unprotected header **396**; §5. |
| $G \vdash \operatorname{publish}(C, S)$ | Canopy does not call the contract; **issuance** of $G$ is still gated by §4 + §5 as below. |

**Bootstrap** (Subplan 08): log not yet initialised — **K(L)** is not yet on-chain; the configured **delegation-signer** acts as an **operational delegate** to sign the **root** transparent statement (current `verifyBootstrapCoseSign1`). After sequencing, **grantData** establishes **K(L)** for future §4 checks on grants whose **`ownerLogId`** is **L**.

---

## 1. When verification applies

### 1.1 register-grant

**Normative (target behaviour):** Every **`POST /logs/{logId}/grants`** request that enqueues a grant MUST:

1. **§4 — Grant statement signature:** Verify the **`Authorization: Forestrie-Grant`** COSE Sign1 (transparent statement) using **§4** (signer is **K(L)** or delegate, **L** = authority log the grant appends under = inner **`ownerLogId`**).
2. **§5 — Receipt / bootstrap branch:** Either  
   - **Bootstrap:** log not initialised; satisfy Subplan 08 bootstrap checks (including existing bootstrap signature verification), **or**  
   - **Non-bootstrap:** completed grant with **idtimestamp** + receipt; **§5** inclusion holds.

**Ordering:** §4 should run on every path that accepts the artifact (before or after §5 per efficiency); both must pass where applicable.

**Current Canopy:** §4 is **missing** on the non-bootstrap receipt branch; bootstrap satisfies a **special case** of §4 (platform delegation-signer as delegate). See **§7**.

### 1.2 register-signed-statement

When inclusion is required: **§5** then **§6** (statement **`kid`** vs **`statementSignerBindingBytes(grant)`**).

---

## 2. Why §4 does not create irreconcilable circularity

**Worry:** To verify a new grant, we need **K(L)**; to know **K(L)** we might need grants already in **L**; that sounds circular.

**Resolution:** **K(L)** is always resolved from **already-committed** facts **strictly prior** to accepting the **new** issuance:

- **Root log L, first grant:** **K(L)** is not derived from a prior leaf in **L**; the **bootstrap** path uses a **configured** delegation key (operational **delegate**). After the bootstrap leaf is committed, **K(L)** for Univocity is read from that leaf’s **`grantData`** (and/or contract) for **subsequent** grants whose **`ownerLogId`** is **L**.

- **Subsequent grants in L:** **K(L)** comes from the **bootstrap grant** (or latest checkpoint-signer policy on-chain / indexer), **not** from the inner payload of the grant currently being registered.

- **Child AUTH_LOG L′:** Grants that **create** L′ are leaves in **parent** **P**’s MMR; their **statement** is signed by **K(P)**. Once L′ is bootstrapped, **K(L′)** comes from **L′**’s own bootstrap **`grantData`**. **No** definition of **K** refers to the **new** grant’s signature input.

Thus: **verify signature** uses **K** fixed from **past** state; **receipt** (when required) ties the **inner** grant to **past** MMR position. There is **no** self-referential dependence of **K** on the request under verification.

---

## 3. Checkpoint signer, delegation, and subtree control (normative summary)

Let **L** be the authority log identified by **`ownerLogId`** of the **inner** grant (the log whose MMR will contain this grant leaf).

- **K(L)** — **checkpoint signer** for **L**: the signing identity Univocity associates with checkpoints for **L** (typically **ES256** public key bytes committed in the **bootstrap** **`grantData`** for **L**, or successor policy).

- **Delegate** — any signing identity **explicitly** authorised to act for **K(L)** on grant issuance (SCITT delegation wire format **TBD**: e.g. COSE **x5c**, short-lived CWT, operator-configured allow-list of keys certified by **K(L)**).

- **Control story:** Only **K(L)** (or delegate) can produce valid **transparent statements** for **register-grant** on grants under **L**. Therefore only that party can **issue** grants that extend **L**’s subtree—**data logs** (targets under **L**), **child AUTH_LOG** grants (leaves in **L** that mint new authority), and recursively the same pattern for children once **K(child)** is fixed.

---

## 4. Grant statement signature (register-grant) — specification

### 4.1 Inputs

- Raw bytes of the **transparent statement** (base64-decoded from `Authorization: Forestrie-Grant`).
- Decoded **`Grant`** from the payload (for **`ownerLogId`**, and for downstream §5).

### 4.2 Steps

1. **Parse** COSE Sign1: `protected`, `unprotected`, `payload` (grant CBOR), `signature`.
2. **Resolve L** = authority log id from **`ownerLogId`** (UUID string from wire bytes).
3. **Resolve verifying key set** $\mathcal{K}(L) = \{ K(L) \} \cup \mathrm{Delegates}(L)$:  
   - Prefer **on-chain / indexer / univocity REST** when available; else **bootstrap grant** for **L** stored in operator pipeline; else **configured** keys for **L** (see §7).
4. **Verify** COSE Sign1 per RFC 9053: `Sig_structure` over `protected || payload` (and algorithm from protected header), **signature** against some key in $\mathcal{K}(L)$.
5. If verification fails → **403** (or **401**) — do not enqueue.

### 4.3 Bootstrap branch

When **L** is **uninitialised**, **$\mathcal{K}(L)$** is the **delegation-signer** / platform bootstrap key (current behaviour: `verifyBootstrapCoseSign1`). This is a **delegate** of the **root governance** model, not **K(L)** from **grantData** (which does not exist yet).

### 4.4 Relationship to §5

- **§5** proves the **inner** grant already sits in the MMR (non-bootstrap) or skips for bootstrap.
- **§4** proves **who** issued the **envelope**. Both are required for the full security story; neither replaces the other.

---

## 5. Receipt-based inclusion verification

This section realises the **receipt** side of §0: we treat the supplied artifact as carrying a checkpoint-style **$C_j$** (root + proof) and verify that the grant’s leaf is consistent with that MMR view.

### 5.1 Prerequisites

- The grant must be **completed** for the non-bootstrap path: **idtimestamp** (8 bytes) in header **-65537**. **Callers supply** **`Authorization: Forestrie-Grant <base64>`** with payload = grant CBOR, receipt in **396**.
- **Leaf commitment** uses header **idtimestamp** + **grant commitment hash** (`PublishGrant` preimage; Plan 0007).

### 5.2 Receipt format ($C_j$ wire shape)

- **Envelope:** COSE Sign1 (CBOR tag 18 optional).
- **Payload:** 32-byte **peak hash**.
- **Unprotected 396:** MMRIVER inclusion proof (`-1` → `[ { 1: mmrIndex, 2: path } ]`).

Optional: verify receipt COSE signature (policy).

### 5.3 Leaf commitment (grant leaf in $A_n$)

- `leafHash = SHA-256(idTimestampBE || inner)`  
- `inner` = **grant commitment hash** (no **request**, no idtimestamp in preimage).

### 5.4 Verification pseudocode

```text
FUNCTION verify_grant_receipt(grant_assembly, idtimestamp, receipt_bytes [, options]):
    IF idtimestamp is missing OR length(idtimestamp) < 8 THEN RETURN false
    (root, proof, coseSign1) := parse_receipt(receipt_bytes)
    inner := grant_commitment_hash(grant_assembly)
    leaf_hash := univocity_leaf_hash(idtimestamp, inner)
    computed_root := calculate_root_async(leaf_hash, proof, SHA256)
    IF computed_root != root THEN RETURN false
    IF options.verify_signature AND NOT verify_cose_sign1_signature(coseSign1) THEN RETURN false
    RETURN true
```

### 5.5 Obtaining the receipt

Per [Plan 0005](plans/plan-0005-grant-receipt-unified-resolve.md), receipt is embedded in the grant artifact; no `X-Grant-Receipt-Location` in this phase.

---

## 6. Signer binding (register-signed-statement only)

### 6.0 Forestrie-Grant wire **v0** and **`PublishGrant.request` (`GC_*`)** vs **`grant` (`GF_*`)**

**Transparent-statement payload (current):** CBOR map keys **1–6** only — `logId`, `ownerLogId`, `grant` (8-byte bitmap), `maxHeight`, `minGrowth`, `grantData`. **No** keys **7** or **8** (obsolete **`signer`** / **`kind`**); **no** `version`, `exp`, or `nbf` on the map (implicit schema **v0**). **Issuer attestation** for who may sign registered statements is only **`grantData`**, which **is** in the commitment preimage. Parsers **reject** keys **7** and **8**. Storage path: **`grant/{sha256}.cbor`** (content-addressed).

**Solidity `PublishGrant`** also has optional **`request`** (**`GC_*`**) — not in the commitment preimage; may appear in TypeScript **`Grant.request`** when hydrated from chain, not required on the Forestrie v0 wire map.

| Axis | Where | Role |
|------|--------|------|
| **`GC_AUTH_LOG` / `GC_DATA_LOG`** | **`PublishGrant.request`** | **Checkpoint publish** intent for **log creation** (auth vs data) at **`publishCheckpoint`** time; **not** in the leaf commitment preimage. |
| **`GF_*`** | **`PublishGrant.grant`** bitmap | **Create vs extend**, **auth log vs data log** target, etc.—**in** the commitment preimage. **`isStatementRegistrationGrant`** uses **`GF_DATA_LOG` + extend** for data-log `/entries`, and **`GF_AUTH_LOG` + `GF_CREATE\|GF_EXTEND`** for root bootstrap grants. |

After **§5** (when required):

1. **Bitmap:** **`isStatementRegistrationGrant(grant)`** MUST be true (`statement-signer-binding.ts`).
2. **`grantData`:** MUST be **non-empty**. The COSE **`kid`** (or, for **64-byte** ES256 **x||y**, the **first 32 bytes / x**) must match **`statementSignerBindingBytes(grant)`**.

**Skim — data log + univocity flags:** For **POST `/logs/{logId}/entries`** on a **data** log, **`PublishGrant.grant`** SHOULD carry **`GF_DATA_LOG`** and **`GF_EXTEND`**; **the first grant for that log SHOULD also set `GF_CREATE`**. Root **AUTH** bootstrap grants use **`GF_AUTH_LOG`** + **`GF_CREATE|GF_EXTEND`** with checkpoint key material in **`grantData`**. Full rationale: **§6.1**.

### 6.1 Intent, univocity flags, and “who signed the grant”

**Plain language (data log, POST `/logs/{logId}/entries`):** The owning **AUTH** log (via **§4** + **§5**) has placed a grant leaf that says, in effect: **checkpoints we publish for this data log may carry transparency statements signed by the key named in `grantData`.** The API enforces **`isStatementRegistrationGrant`** plus **`kid` ↔ `grantData`** (**§6.0**, §6 items 1–2).

**`GF_*` vs `GC_*` (univocity `constants.sol`, summarized in [brainstorm-0001 §3.4](brainstorm-0001-x402-checkpoint-grants.md)):** **`PublishGrant.grant`** is an 8-byte wire bitmap of **`GF_*`** flags (create/extend, auth vs data log, …). **`PublishGrant.request`** holds high-level **`GC_*`** codes used at **`publishCheckpoint`** time (e.g. log kind at **creation**); it is **not** in the leaf commitment preimage. For **register-signed-statement** alignment with the contract, the relevant discriminator is **`GF_DATA_LOG`** in **`grant`**, not **`GC_DATA_LOG`** in **`request`**.

**Suggested flag rule for this endpoint (normative target once bit tests exist in Canopy):** For grants authorizing **statement registration on a data log**, **`grant`** SHOULD include **`GF_EXTEND`** and **`GF_DATA_LOG`**. **In practice, `GF_CREATE` is also set** on the **first** grant for that log (first checkpoint): expect **`GF_CREATE \| GF_EXTEND`** together with **`GF_DATA_LOG`**. **Later** grants for the same log may omit **`GF_CREATE`** and carry **`GF_EXTEND`** (and **`GF_DATA_LOG`**) only, if policy allows extend-only follow-up grants. Grants meant for **AUTH** log checkpoint keys (bootstrap, new auth log) use **`GF_AUTH_LOG`** (and typically **GF_CREATE \| GF_EXTEND** for root bootstrap)—those are **register-grant** / checkpoint flows, not a substitute shape for arbitrary **data-log** `/entries` grants.

**Authorizing log signer:** The party that **issues** the grant (proves the leaf is legitimate) MUST be the **checkpoint signer** for **`ownerLogId`** per **§4** (verify the **transparent statement** COSE signature). **§4** is the sole issuance check; inner CBOR convenience fields that are **not** in the **`PublishGrant`** commitment do not replace it.

**Model consistency:** Wire **v0** drops **`kind`** / **`signer`**; **`GF_*`** / **`GC_*`** remain **on-chain `PublishGrant`** fields. **`grantData` vs `kid`** is the **statement-signer** binding. Tighter **`request`/`GF_*`** matrix checks remain **P3** (**§9.8**) when univocity constants are in-repo.

See [arc-grant-statement-signer-binding](arc-grant-statement-signer-binding.md).

### 6.2 Should Canopy treat **`Grant`** as contract-shaped and check consistency with the preimage inputs?

**Committed fields (in the preimage):** After decode, **`logId`**, **`grant`** (bitmap), **`maxHeight`**, **`minGrowth`**, **`ownerLogId`**, and **`grantData`** are **one** value set. The commitment preimage is **derived** from that set (`grant-commitment.ts`); there is no second on-wire copy of those fields to reconcile. Inconsistency would mean a broken codec or corrupted bytes, not “payload vs preimage drift.”

**`request` (`GC_*`):** Optional on TypeScript **`Grant`** when hydrated from chain; **not** required on Forestrie wire **v0**. The chain can still enforce relationships between **`request`**, **`grant`** (**`GF_*`**), and checkpoint calls. Therefore:

- **Yes (recommended):** Once univocity documents **compatibility rules** (e.g. which **`GC_*`** values may accompany which **`GF_*`** patterns, auth vs data log, create vs extend), Canopy **should** validate **`grant.request`** (when present) against **`grant.grant`** the same way a careful **`publishCheckpoint`** caller would—so off-chain auth does not accept artifacts the contract would treat as ill-formed or misleading.
- **Wire v0:** Maps that include obsolete keys **7**/**8** or unknown extensions **must** be **rejected** at decode. There is **no** parallel **`signer`** field on the wire; **`grantData`** is the only issuer attestation for statement-signer binding (**§6**).

**Summary:** The preimage discussion **does not** mean “re-validate `logId` twice.” It **does** imply that **`Grant.request`** (when hydrated) **should** be checked for **contract-consistent** combinations with the **`grant`** bitmap (and with HTTP context such as path **`logId`**) when those rules are codified—**§9.8** (bitmap) plus a future **`request`/`GF_*` matrix** sourced from univocity.

---

## 7. Summary flow (target)

**register-grant (non-bootstrap, normative):**

```text
bytes := base64_decode(Authorization: Forestrie-Grant)
assembly := decode_grant_payload_from_transparent_statement(bytes)
IF NOT verify_grant_statement_signature(bytes, assembly.ownerLogId) THEN RETURN 403   // §4
IF NOT grant_completed(idtimestamp) THEN RETURN 403
IF NOT verify_grant_receipt(assembly, idtimestamp, receipt) THEN RETURN 403         // §5
enqueue(…)
RETURN 303
```

**register-grant (bootstrap):**

```text
bytes := …
assembly := …
IF NOT verify_bootstrap_delegate_signature(bytes) THEN RETURN 403   // §4.3 — current verifyBootstrapCoseSign1
… bootstrap shape checks …
enqueue(…)
```

**register-signed-statement:**

```text
… grant_result …
IF inclusion required AND NOT verify_grant_receipt(…) THEN RETURN 403
IF NOT isStatementRegistrationGrant(grant) THEN RETURN 403   // bitmap + data-log or bootstrap auth shape
IF statement.kid != statementSignerBindingBytes(grant) THEN RETURN 403   // grantData only (v0 wire)
enqueue_statement(…)
```

---

## 8. Current implementation locations

| Concern | Location |
|--------|----------|
| Grant types | `packages/apps/canopy-api/src/grant/grant.ts`, `grant-assembly.ts`, `grant-commitment.ts` |
| Leaf commitment | `packages/apps/canopy-api/src/grant/leaf-commitment.ts` |
| Receipt parse / verify | `packages/apps/canopy-api/src/grant/receipt-verify.ts` |
| Transparent statement decode | `packages/apps/canopy-api/src/grant/transparent-statement.ts` — **decode only; no signature verify** |
| Register-grant | `packages/apps/canopy-api/src/scrapi/register-grant.ts` |
| Bootstrap signature | `packages/apps/canopy-api/src/scrapi/bootstrap-public-key.ts` — `verifyBootstrapCoseSign1` (**§4.3 only**) |
| Grant auth / get grant | `packages/apps/canopy-api/src/scrapi/auth-grant.ts` — `getGrantFromRequest` **does not verify COSE signature** |
| Statement signer binding | `packages/apps/canopy-api/src/grant/statement-signer-binding.ts` — `isStatementRegistrationGrant`, `statementSignerBindingBytes` (**grantData** only) |
| Grant bitmap | `packages/apps/canopy-api/src/grant/grant-flags.ts` — **`hasCreateAndExtend`**, **`isDataLogStatementGrantFlags`**, **`hasExtendCapability`**, **`hasDataLogClass`** (assumed low-byte layout; verify vs univocity) |
| Register-signed-statement | `packages/apps/canopy-api/src/scrapi/register-signed-statement.ts` — **`isStatementRegistrationGrant`** + **`statementSignerBindingBytes`** vs **kid** |

---

## 9. Required implementation changes in Canopy (gap list)

This section is **normative for engineering planning**. **Priority:**

| Tier | §§ | Meaning |
|------|-----|--------|
| **P0 — security / issuance** | **§9.1–9.4** | **§4** envelope signature on Forestrie-Grant, **K(L)** resolution, register-grant order of checks. Without these, grants are not cryptographically tied to the authority log signer. |
| **P1 — tests & contracts** | **§9.5–9.6** | Coverage and API docs for **§4**; clarify envelope vs **§6** **kid** in arc-grant-statement-signer-binding. |
| **P2 — later** | **§9.7** | Receipt signature, on-chain witness tie-in. |
| **P3 — contract alignment** | **§9.8** | **`GF_*`** checks on **register-signed-statement** once univocity bit layout lives in-repo (**§6.1**). Parity with **`PublishGrant.grant`**; **not** a substitute for **P0** (bitmap checks do not replace envelope verify). |

**§5** (receipt / inclusion) is **already implemented** when **`inclusionEnv`** is set (**§9** does not re-list it as a gap). The tables above emphasize **P0** (**§4** envelope + **K(L)**) and **P3** (recommended **§6.1** bitmap checks).

### 9.1 Grant transparent statement — cryptographic verification

| Gap | Action |
|-----|--------|
| **No COSE Sign1 verify on Forestrie-Grant envelope** | After obtaining raw transparent statement bytes, **verify** the outer COSE Sign1 signature per RFC 9053 (`Sig_structure`, algorithm from protected header) before treating the grant as authentic. Reuse or extend helpers (cf. `@canopy/encoding` `verifyCoseSign1` used in tests; `decodeCoseSign1` in `bootstrap-public-key.ts`). |
| **Decode vs verify conflated** | Split **`getGrantFromRequest`**: (a) parse + verify signature → (b) decode payload. Fail closed if signature invalid. |

**Scope:** **`getGrantFromRequest`** is used for **register-grant** and **register-signed-statement**; missing envelope verify (**§4**) affects **both** paths until this gap is closed (bootstrap **§4.3** remains separate).

### 9.2 Resolving **K(L)** and delegates **$\mathcal{K}(L)$**

| Gap | Action |
|-----|--------|
| **No resolver for checkpoint signer by `ownerLogId`** | Implement **`resolveCheckpointVerifyingKeys(ownerLogId): Promise<CryptoKey[] | JsonWebKey[] | Uint8Array[]>`** (exact type TBD) that returns **K(L)** plus configured delegates. **Sources (in priority order to define):** (1) Univocity / on-chain reader for committed checkpoint key; (2) REST or indexer **bootstrap grant** for **L** → **`grantData`** → ES256 public key; (3) operator **env** allow-list per log UUID (dev / air-gap). |
| **Child vs parent logs** | Ensure **`ownerLogId`** on the inner grant is the **MMR parent** for the leaf; resolver must key off **that** id, not only URL **`logId`** (target). |
| **Caching** | Cache **K(L)** per **L** with invalidation on new bootstrap or checkpoint policy (TTL or event-driven). |

### 9.3 Delegation model (wire + config)

| Gap | Action |
|-----|--------|
| **Delegates not defined** | Specify how a delegate proves authority: e.g. **x5c** chain in COSE protected header, **CWT** `delegation` claim, or **config-only** extra keys certified offline. Document in a short ADR or extend this ARC. |
| **Bootstrap / platform delegate** | Formalise current **delegation-signer** as **$\mathcal{K}(L)$** when **L** uninitialised (**§4.3**); ensure env documents trust assumptions. |

### 9.4 register-grant control flow

| Gap | Action |
|-----|--------|
| **Non-bootstrap path skips §4** | After `grantAuthorize` / receipt success, **still insufficient** — add **`verifyGrantTransparentStatement(bytes, assembly)`** that runs **§4** using **`assembly.ownerLogId`**. |
| **Queue-only mode** (`bootstrapEnv` unset) | Today enqueues with **no** inclusion and **no** envelope verify — **unsafe** for production. **Options:** require **`bootstrapEnv`** (or successor) whenever queue is on; or require **§4** even without receipt; document **dev-only** if kept. |
| **Order of checks** | Recommended: **parse → §4 signature → §5 receipt** (fail fast on bad crypto). |

### 9.5 Testing and observability

| Gap | Action |
|-----|--------|
| **No tests for envelope signature on register-grant** | Add integration tests: valid signature with **K(L)** → 303; wrong key → 403; bootstrap path unchanged. |
| **Logging** | On §4 failure, log **L**, key id / thumbprint (no raw secrets), and reason (no key resolved vs bad sig). |

### 9.6 Documentation and API contracts

| Gap | Action |
|-----|--------|
| **register-grant.md / Plan 0005** | State that **Forestrie-Grant** MUST be a **valid COSE Sign1** under **K(ownerLogId)** or delegate. |
| **arc-grant-statement-signer-binding** | Distinguish **envelope** signer (**§4**, register-grant) vs **statement kid** (**§6**, register-entry). |

### 9.7 Optional hardening (later)

- Verify **receipt** COSE signature (**§5**) where the receipt is signed by **log builder** / ranger.
- Tie **K(L)** to **contract** `publishCheckpoint` witness instead of only off-chain store.

### 9.8 register-signed-statement — univocity **`grant`** bitmap (P3 — recommended)

| Gap | Action |
|-----|--------|
| **Bitmap vs univocity** | Confirm **`GF_*`** bit positions in **`grant-flags.ts`** match **`constants.sol`**; **`isStatementRegistrationGrant`** already combines data-log and bootstrap auth paths. |
| **`request` / `GC_*` vs bitmap** | When univocity defines **`GC_*` ↔ `GF_*`** invariants, add **`assertRequestMatchesGrantFlags`** for hydrated **`Grant.request`** (**§6.2**). |
| **logId vs flags** | Optionally cross-check URL **`logId`** / **`grant.logId`** against policy (out of scope until log-kind API is stable). |

---

MMR verification uses `@canopy/merklelog` with an async digest (e.g. `crypto.subtle.digest("SHA-256", …)`) on Workers.
