# Brainstorm-0001: x402 Checkpoint Grants

**Status**: DRAFT  
**Date**: 2026-03-07  
**Related**: ARC-0015 x402 Settlement Architecture, ARC-0016 Checkpoint Incentivisation Model, ARC-0017 Hierarchical Authority Logs (devdocs); univocity smart contracts (authoritative)

## 1. Goal

Evolve canopy so that:

- **Log builders** use x402 to pay for **grants** that authorize publishing checkpoints.
- Grants can be **created via the canopy API** (e.g. pay → receive a grant/receipt).
- Grants are **public data** and **published to object storage** so anyone can discover and verify them.

This document captures current context and options; implementation is contingent on the checkpoint pipeline and authority model described in devdocs (ARC-0016, ARC-0017).

---

## 7. Register-grant and relation to register-statement

Canopy API should support a new **register-grant** endpoint that creates grants (payment-bounded authority) and publishes them as public data. This section refines the design using univocity contracts, canopy’s existing support, and maximum practical alignment with SCITT signed statements and COSE receipt/envelope standards.

### 7.1 Two kinds of grants

**Both kinds are authority log leaves.** Each grant is appended to an authority log and committed as an MMR leaf (Section 3.4). Authorization always requires verifying a proof of inclusion of that leaf against the authority log (e.g. at a trusted checkpoint).

1. **Publish-checkpoint grants** — Allow log builders to publish checkpoints to the univocity contract. The builder pays to be included in the trust model; the grant becomes a leaf in the authority log; at `publishCheckpoint` the contract verifies inclusion of that leaf.
2. **Attestor-registration grants** — Authorize users (attestors) to register statements on a log via register-statement. The **role of register-grant** (for this kind) is to ensure that the **attestor has paid for inclusion** in the **subject data log**. The grant is an authority log leaf. The **role of register-statement** is to ensure that the grant is **signed by the statement signer** (the attestor who signed the statement being registered) and that the grant is **current** (e.g. not expired, within validity window); it also verifies proof of inclusion of the grant in the authority log.

Both can share a single register-grant endpoint with a parameter or COSE claim that distinguishes the kind.

### 7.2 Kind 1: Publish-checkpoint grants (univocity-aligned)

**Contract alignment**: The grant must produce a **leaf** whose commitment is `sha256(grantIDTimestampBe || sha256(logId, grant, maxHeight, minGrowth, ownerLogId, grantData))` (Section 3.4). The **request** (GC_AUTH_LOG / GC_DATA_LOG) is supplied at `publishCheckpoint` time, not in the leaf.

**Grant request parameters** (must be conveyed to register-grant):

- **Target log** — The log being funded: a data log (then owner = its auth log) or an auth log (then owner = parent auth log; bootstrap has no parent).
- **Owner log** — The authority log that will contain this grant (always an auth log): for a data log, the data log’s auth log id; for an auth log, its parent auth log id (bootstrap uses self).
- **Grant flags** — GF_CREATE, GF_EXTEND, GF_AUTH_LOG, GF_DATA_LOG as required (univocity `constants.sol`). For first checkpoint to a new log, GF_CREATE and either GF_AUTH_LOG or GF_DATA_LOG; for extend, GF_EXTEND.
- **grantData** — For first checkpoint: signer key (bootstrap key for root; root key for child). Opaque bytes (e.g. 20 for KS256, 64 for ES256). ADR-0005.
- **Bounds** — maxHeight, minGrowth (size-only in current contract).

**SCITT/COSE alignment for the grant request**: Represent the **grant request** as a **SCITT Signed Statement** (COSE Sign1 per draft-ietf-scitt-scrapi):

- **Protected headers**: Use COSE header parameters to bind grant parameters and auth. Private/experimental labels (e.g. in the 256–65535 or negative space per COSE) can carry: target log id, owner log id, grant flags (e.g. as a uint or bitmap), maxHeight, minGrowth. Standard `alg` (1) and `kid` (4) identify the signer; the signer can be taken as the root key when GF_CREATE is set (grantData then matches signer).
- **Payload**: **grantData** (opaque bytes: signer key for first checkpoint). This keeps the same semantics as univocity’s PublishGrant.grantData and fits COSE’s bstr payload.
- **Unprotected**: Optional; e.g. request code (GC\_\*) as a hint for the service, though request is not in the leaf commitment.

The authority log operator signs the grant only after payment is verified/settled; the “signed statement” in this flow is the **issued grant** (or the request that leads to it). Issued grants are stored and published so submitters can build inclusion proofs. Canonical storage path aligned with univocity and public discovery could be:

`grants/<owner-log-id>/<target-log-id>/publish-checkpoint/<signer-key-id>/<idtimestamp>`

(or equivalent with log ids and idtimestamp in a stable encoding). The stored document must contain at least the leaf commitment inputs (grantIDTimestampBe, logId, grant, maxHeight, minGrowth, ownerLogId, grantData) so that submitters and the contract can use it.

**Canopy support today**: x402 verify/settle (Section 2), CDP facilitator, settlement queue. New: register-grant handler that accepts the grant request (body or headers), returns 402 with X-PAYMENT-REQUIRED for the grant resource, on payment builds PublishGrant + idtimestamp, appends leaf (or hands off to Arbor), and publishes grant document to object storage.

### 7.3 Kind 2: Attestor-registration grants (derived / builder-defined)

These grants authorize **statement registration** on a log (register-statement), not checkpoint publishing. They are **authority log leaves** like Kind 1.

- **Role of register-grant**: To ensure that the **attestor has paid for inclusion** in the **subject data log**. The attestor (or their delegate) pays via x402 at register-grant; the issued grant is appended as a leaf to the authority log and attests that this party is authorized to have statements included in that data log.
- **Role of register-statement**: When handling POST /logs/{logId}/entries with an attestor grant, the implementation must ensure (1) that the **grant is signed by the statement signer** — i.e. the grant is bound to the same key or identity that signed the statement being registered, so the attestor cannot use someone else’s grant — and (2) that the grant is **current** (e.g. within its validity window, not exhausted). In addition, the implementation verifies a **proof of inclusion** of the grant in the authority log (e.g. against a trusted checkpoint). The univocity contract does not itself enforce attestor-registration grants at publishCheckpoint; enforcement is in the canopy API at register-statement.

**Contract alignment**: Univocity reserves **GF_DERIVED** (1<<34) and **GC_DERIVED** (4<<224) for “external protocols reusing the grant system” (constants.sol). Attestor-registration grants **are** leaves in the authority log; they use the same leaf commitment shape (e.g. with a grant flag or request code in the derived space). A convention (e.g. **GF_ATTESTOR_REGISTRATION** as a private/experimental label or a value under the derived code space) identifies “attestor registration” so the register-statement implementation can distinguish them from publish-checkpoint grants. The leaf is still committed and inclusion is verified the same way (inclusion proof against the authority log MMR).

**Semantics (builder-defined)**:

- **Time-based validity** — Expiry (and optionally not-before) so the grant is valid for a time window. The “clock” can align with the log’s idtimestamp generator where practical.
- **Rate or tier** — The grant can encode a rate or tier (e.g. max registrations per period, or a tier id) so that register-statement implementations can rate-limit or apply policy based on the grant.

**SCITT/COSE alignment**:

- **Signed statement**: Use COSE Sign1 for the attestor-registration grant. Protected headers: alg, kid, and **private/experimental labels** for grant kind (e.g. GF_ATTESTOR_REGISTRATION), log id, validity (exp, nbf), rate/tier. CWT claims (label 15) can carry exp/nbf per RFC 8392; SCRAPI uses claim 15 in examples.
- **Hash envelope** (draft-ietf-scitt-scrapi): SCRAPI allows the Signed Statement **payload** to be a digest with **payload-location** (260) and **payload-hash-alg** (258), **preimage-content-type** (259). For attestor grants, the payload can be a **hash** of attestor-specific information, and **payload-location** can point at arbitrary attestor information (e.g. a URL or URN). Verifiers that need the full attestor info can fetch from the location; the grant itself remains compact and the signer binds the hash.

**Register-statement flow (when attestor grants are used)**:

1. **Authorization**: Client sends the signed statement (COSE Sign1) and either (a) **Authorization: Bearer &lt;token&gt;** where the token is a base64-encoded or referenced **grant proof** (e.g. a COSE Receipt of Inclusion proving the grant leaf is in the authority log), or (b) **inline** grant material plus inclusion proof, or (c) a **location URL** that resolves to the grant (aggressively cached).
2. **Verify grant is signed by the statement signer**: The register-statement implementation must bind the grant to the **statement signer** — the key or identity that signed the statement being registered must be the one the grant was issued to or that signed the grant. This prevents one attestor from using another’s paid grant.
3. **Verify grant is current**: Check that the grant is within its validity window (e.g. exp/nbf), not exhausted (if rate/tier applies), and otherwise current.
4. **Verify proof of inclusion**: Verify a **proof of inclusion** of the grant in the authority log (e.g. against a trusted checkpoint). Decode/fetch the grant and inclusion proof, recompute the leaf commitment (Section 3.4), verify the inclusion proof against the authority log’s MMR at the checkpoint size. draft-bryce-cose-receipts-mmr-profile and draft-ietf-cose-merkle-tree-proofs define COSE Receipt of Inclusion (vdp 396, inclusion -1) and Consistency; use the same proof shapes.
5. **If any verification fails** → Respond **402 Payment Required** with X-PAYMENT-REQUIRED (x402) so the client can pay for a new grant or top up.
6. **Otherwise** → Accept registration (enqueue statement as today). Optionally consume rate from the grant (e.g. decrement a counter or check tier).

**Canopy support today**: registerSignedStatement accepts COSE Sign1 or CBOR body (Section 2); no Bearer or grant check yet. New: path that checks Authorization (Bearer or grant location), resolves grant and inclusion proof; **verifies the grant is signed by the statement signer** and **current**; verifies **inclusion of the grant leaf against the authority log** (using R2_MMRS checkpoint data and/or univocity contract state); only then enqueues; else 402.

### 7.4 IETF / SCITT references (maximum practical alignment)

| Standard / draft                          | Use for register-grant and register-statement                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **draft-ietf-scitt-scrapi**               | Register Signed Statement: COSE Sign1 body; protected headers (alg, kid, 258/259/260 for hash envelope, 15 for CWT claims); 402 and payment are out of scope of SCRAPI but compatible.                                     |
| **draft-ietf-cose-merkle-tree-proofs**    | COSE Receipts: protected (alg, vds 395), unprotected (vdp 396 with inclusion -1, consistency -2); detached payload; Receipt = COSE_Sign1. Use for **grant proof** when the grant is evidenced by an MMR inclusion receipt. |
| **draft-bryce-cose-receipts-mmr-profile** | MMR-specific inclusion and consistency proof CBOR (index, path; tree_size_1, tree_size_2, paths, right_peaks); add_leaf_hash, hash_pospair64. Aligns with univocity’s MMR and leaf commitment.                             |
| **RFC 9052**                              | COSE Sign1 structure; Sig_structure; protected/unprotected headers.                                                                                                                                                        |
| **RFC 8392**                              | CWT (Claims 6 iat, 7 nbf, 8 exp) for time-based validity in headers or claim set.                                                                                                                                          |

Grant **requests** and **issued grants** conveyed as COSE Sign1 with private labels for grant parameters give maximum alignment with SCITT “Signed Statement” and COSE without requiring changes to the univocity contract. Grant **proof** at register-statement can be a COSE Receipt of Inclusion (and optionally consistency) when the grant is stored in an MMR and checkpointed.

---

## 2. Existing x402 Implementation in Canopy (Summary)

Canopy already has **experimental x402 support** for **statement registration**, not for checkpoints or grants. The following can be reused or adapted.

### 2.1 Where x402 Is Used Today

- **Resource**: `POST /logs/{logId}/entries` (SCRAPI statement registration).
- **Flow**: If the client omits `X-PAYMENT`, the API returns **402 Payment Required** with `X-PAYMENT-REQUIRED` (base64-encoded payment requirements). The client signs an EIP-3009 `transferWithAuthorization` and resends with `X-PAYMENT`. The API verifies via CDP, enqueues the statement, and emits a **settlement job** to a queue; the **x402-settlement** worker settles asynchronously.
- **Pricing**: Fixed price per registration (e.g. $0.001 in atomic USDC units), Base Sepolia / Base Mainnet, configurable `payTo` and network.

### 2.2 Reusable Building Blocks

| Component                        | Location                                                            | Use for checkpoint grants                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Header parsing / validation**  | `packages/apps/canopy-api/src/scrapi/x402.ts`                       | Same x402 v2 payload format; can add a separate _resource URL_ for “checkpoint grant” so requirements and payloads are bound to the grant resource.                                                                                                                |
| **Payment requirements builder** | `buildPaymentRequiredHeader()`, `getPaymentRequirementsForVerify()` | Can call with a grant-specific resource URL and (optionally) different price/amount for “N checkpoints” or “coverage”.                                                                                                                                             |
| **CDP verify**                   | `packages/apps/canopy-api/src/scrapi/x402-facilitator.ts`           | Verify payment for grant creation the same way as for entries; JWT auth and verify/settle semantics unchanged.                                                                                                                                                     |
| **Settlement pipeline**          | `x402-settlement` worker + `X402SettlementDO` + queue               | Today jobs are keyed by `logId` + `contentHash` + `authId` for _statement_ registration. For grants we’d need a **different job type** (or separate queue) that results in **writing a grant/receipt** and publishing it, not just settling a charge for an entry. |
| **Auth state (blocked payers)**  | `X402SettlementDO.getAuthInfo()`                                    | Reuse to reject blocked payers on any x402-protected endpoint (including a future “create grant” endpoint).                                                                                                                                                        |

### 2.3 What Would Need to Change

- **New resource and endpoint**: x402 is currently tied to “statement registration” (entries). We need at least one **grant resource** and a **canopy API endpoint** that:
  - Returns 402 + `X-PAYMENT-REQUIRED` for that resource (e.g. “pay for a checkpoint grant for log L”).
  - Accepts `X-PAYMENT`, verifies and settles, then **creates a grant** (e.g. receipt) and **publishes it to object storage**.
- **Settlement job semantics**: Current `SettlementJob` is “settle this payment and record idempotency”; it does not produce a **grant document** or write to object storage. We need either:
  - A new job type that: settle → build grant/receipt → write to R2 (or equivalent), or
  - Grant creation and publish done **synchronously** in the API after verify (and settlement still async), with a clear contract on when the grant is visible.
- **Object storage for public grants**: Canopy’s **R2_MMRS** is used for merklelog data (massifs + checkpoints), written by Arbor services; the API reads it for resolve-receipt and query-registration-status. **Grants as public data** implies a **separate namespace or bucket** for grant/receipt objects (e.g. `grants/{authorityLogId}/{grantId}.json` or similar) so that:
  - Anyone can list/fetch grants without going through a private API.
  - Grant format and URL scheme are stable and documented.
- **No checkpoint or authority log in canopy yet**: Current code has no notion of “authority log”, “receipt”, “checkpoint_start/checkpoint_end”, or “grant type”. Those concepts are defined in univocity (PublishGrant, leaf commitment) and devdocs (ARC-0016, ARC-0017). The **authoritative** grant shape is the contract's PublishGrant + idtimestamp (Section 3.4). Implementing “grants” in canopy will require either:
  - A **minimal grant representation** that matches the PublishGrant + idtimestamp so the same document can be used when building the authority log leaf and when submitters call `publishCheckpoint`, or
  - Explicitly scoping the first iteration to “pay and get a grant document published” without yet appending to an authority log (enforcement would be on-chain when the leaf is eventually appended and used).

---

## 3. Relevant devdocs (Summary and Links)

All of the following live in **devdocs** (sibling repo to canopy). Paths below are relative to devdocs root.

### 3.1 ARC-0015: x402 Settlement Architecture

- **Path**: `devdocs/arc/arc-0015-x402-settlement-architecture.md`
- **Status**: IMPLEMENTED (in canopy).
- **Summary**: Describes the current flow: client → canopy-api (parse, auth check, CDP verify) → enqueue statement + send settlement job → x402-settlement worker → CDP settle. Includes DO idempotency, auth blocking, and queue semantics. No grants or checkpoints.

### 3.2 ARC-0016: Checkpoint Incentivisation Model

- **Path**: `devdocs/arc/arc-0016-checkpoint-incentivisation-model.md`
- **Status**: PROPOSED.
- **Summary**: The **priced resource** is **checkpoint creation/publication**, not per-statement registration. **Payment grants authority** (R5): each payment produces a **receipt** with `(subject, target_logId, checkpoint_start, checkpoint_end, max_height)`. Receipts are entries in an **authority log**; the contract verifies inclusion and bounds at `publishCheckpoint`. x402 is used for **top-ups** (pay for more checkpoints / more coverage). Registration can stay cheap and need not require x402 on every request.

**Relevance to this brainstorm**: Grants we create via the canopy API should align with this receipt shape and authority-log semantics so that when the chain and checkpoint pipeline exist, the same grants can be used at publish time. **Note**: The current univocity contract uses **size-only** bounds (maxHeight, minGrowth), not checkpoint_start/checkpoint_end; see Section 3.4.

### 3.3 ARC-0017: Hierarchical Authority Logs and Fee Distribution

- **Path**: `devdocs/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md`
- **Status**: PROPOSED.
- **Summary**: Extends the model with **multiple authority logs** in a tree (bootstrap root, children created by parent grant). **Grant types**: `grant:extend-data-log`, `grant:extend-auth-log`, `grant:create-auth-log`. Fees flow up the tree; receipt identifies **which authority log** issued it. On-chain fee collection (e.g. vault per authority log) is adopted in conjunction.

**Relevance to this brainstorm**: If we introduce “grants” in canopy now, we may want a **grant type** (or equivalent) in the public grant document so that future hierarchy and contract logic can interpret them without changing the storage format unnecessarily.

### 3.4 Univocity smart contracts and related docs (authoritative design)

The **Solidity code in univocity** is the latest and authoritative design for grants, checkpoint publishing, and authority logs. Summary below; see univocity repo at `~/Dev/personal/forestrie/univocity`.

**Key contract types** (`src/interfaces/types.sol`, `constants.sol`):

- **PublishGrant**: `logId`, `grant` (flags), `request` (high 32 bits; not in leaf), `maxHeight`, `minGrowth`, `ownerLogId`, `grantData`. Grant flags: `GF_CREATE` (1<<32), `GF_EXTEND` (1<<33), `GF_AUTH_LOG` (1), `GF_DATA_LOG` (2). Request codes `GC_AUTH_LOG` / `GC_DATA_LOG` set log kind at creation only.
- **Leaf commitment** (`src/algorithms/lib/LibLogState.sol`): `leafCommitment = sha256(grantIDTimestampBe || sha256(logId, grant, maxHeight, minGrowth, ownerLogId, grantData))`. The authority log entry is this leaf; **request** is not in the commitment.
- **grantData**: On first checkpoint to a log, supplies the **signer key** (bootstrap for root; root key for child). Contract verifies signer matches (verify-only). ADR-0005.

**Bounds**: Contract uses **size-only** bounds (univocity `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`): **minGrowth** (min increase in MMR size per checkpoint) and **maxHeight** (max size for this checkpoint). No checkpoint_start/checkpoint_end or on-chain counter in current code.

**Who adds the leaf**: The authority log operator (off-chain) must **append** the leaf to the owner log's MMR before any submitter can use the grant. The contract only verifies inclusion at `publishCheckpoint`. So canopy grant-creation must (1) verify/settle payment, (2) produce a grant payload matching PublishGrant + idtimestamp, (3) append that leaf (or hand off to the service that does), (4) optionally publish a public grant document to object storage.

**Relevant univocity docs**: `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md` (payment as inclusion, leaf commitment, size-only bounds); `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md` (LogKind, ownerLogId); `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md` (grantData = signer); `docs/adr/adr-0001-payer-attribution-permissionless-submission.md` (any sender may submit).

---

## 4. Options to Evolve

### 4.1 Grant creation endpoint

- **Option A – Dedicated endpoint**: e.g. `POST /logs/{logId}/grants` or `POST /grant` (body specifies target log, amount/type). Returns 402 with payment requirements for “checkpoint grant for log L”; on payment, verify + settle, then create grant and publish to object storage.
- **Option B – Checkpoint endpoint with 402**: e.g. `POST /logs/{logId}/checkpoint` that returns 402 when the caller has no valid grant; payment creates a grant and then (same request or follow-up) the checkpoint can be built. Closer to ARC-0016’s “checkpoint path (priced work)” but requires a checkpoint builder in scope.
- **Option C – Hybrid**: Separate “create grant” endpoint for top-ups; checkpoint endpoint later consumes grants from object storage (or authority log). Clear separation: API only “sells” grants; something else (Arbor, contract) enforces them at publish.

### 4.2 Grant document format and storage

- **Shape (align with univocity)**: The contract expects a **leaf** derived from `grantIDTimestampBe` + PublishGrant (logId, grant, maxHeight, minGrowth, ownerLogId, grantData). A public grant document should contain at least these so submitters can build the inclusion proof and pass the same PublishGrant + grantIDTimestampBe to `publishCheckpoint`. Optionally: payer/subject and payment reference (e.g. settlement tx) for attribution. **request** is not in the leaf; it is supplied at publish time (GC_AUTH_LOG / GC_DATA_LOG for new logs). So the stored grant shape should match the **commitment inputs** (idtimestamp, logId, grant flags, maxHeight, minGrowth, ownerLogId, grantData).
- **Storage path**: Predictable public URLs, e.g. `grants/{authorityLogId}/{grantId}.json` or `v2/grants/{logId}/{grantId}.cbor` in a dedicated bucket or prefix. Considerations: listing for a log, cacheability, and future-proofing for authority log id.
- **Publish moment**: (1) Synchronous: create grant and write to object storage before responding 2xx. (2) Async: respond 2xx after verify (and maybe settle), then publish grant via queue so “visible in object storage” is eventually consistent. Trade-off: simplicity vs consistency and UX.

### 4.3 Settlement and idempotency

- **Reuse existing queue/DO**: Treat “grant creation” as a new **job type** on the same queue (or a separate queue) so that after settlement we run “build grant + publish” in the worker. Idempotency key could be `authId:targetLogId:paymentNonce` or similar to avoid duplicate grants for the same payment.
- **New DO or tables**: If we need to track “grant id → settlement status” or “per-log grant ledger”, we might extend X402SettlementDO or add a small store; alternatively, “grant document in object storage” is the source of truth and we avoid extra state.

### 4.4 Log builders and UX

- **Who is “log builder”**: The entity that runs the pipeline that builds checkpoints and (in the future) calls `publishCheckpoint`. They need a **grant** (receipt) that authorizes that publish. Today they might be the same as “payer” or a different party (ARC-0016’s signer / payer / submitter split).
- **Flow**: Log builder calls canopy API to “buy” a grant (x402 flow); receives grant id or URL; later, the checkpoint pipeline (or submitter) fetches the grant from object storage and uses it at publish. So “log builders use x402 to pay for grants” is realized by “canopy API exposes grant creation with x402; log builders call it; grants are public in object storage.”

### 4.5 What to implement first (in canopy)

- **Minimal slice**: One new endpoint that returns 402 for a grant resource, accepts X-PAYMENT, verifies (and optionally settles), then creates a **minimal grant document** whose shape matches univocity’s PublishGrant + idtimestamp (Section 3.4) so it can later be used as the authority log leaf and at `publishCheckpoint`. Publish the document to object storage. No checkpoint building in canopy yet; no contract. This validates the flow and storage shape.
- **Next**: Ensure grant document fields align with leaf commitment (logId, grant, maxHeight, minGrowth, ownerLogId, grantData, idtimestamp); add listing/GET by log or authority log if needed; integrate with authority log append (canopy or Arbor) and actual checkpoint publish path when it exists.

---

## 5. Open Questions

- Exact URL scheme and bucket/prefix for public grant objects (and whether same R2 bucket with a prefix vs separate bucket).
- Whether grant creation should be synchronous (write to storage then respond) or async (queue “publish grant” after settle).
- How to express “N checkpoints” or “coverage” in `X-PAYMENT-REQUIRED` (e.g. fixed tiers vs single price). Contract uses size-only (maxHeight, minGrowth), not checkpoint count.
- Whether the first version of “grant” is a standalone public document only, or also an **authority log leaf** (canopy or Arbor must append the leaf so the contract can verify inclusion at `publishCheckpoint`).
- How to version the grant document format so that future receipt/grant schema changes (e.g. from ARC-0017) remain compatible.

---

## 6. References

(devdocs is a sibling repo to canopy; paths below are relative to the repo root that contains both.)

- [ARC-0015 x402 Settlement Architecture](../../devdocs/arc/arc-0015-x402-settlement-architecture.md) (devdocs)
- [ARC-0016 Checkpoint Incentivisation Model](../../devdocs/arc/arc-0016-checkpoint-incentivisation-model.md) (devdocs)
- [ARC-0017 Hierarchical Authority Logs and Fee Distribution](../../devdocs/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md) (devdocs)
- Canopy x402: `packages/apps/canopy-api/src/scrapi/x402.ts`, `x402-facilitator.ts`; `packages/apps/x402-settlement/`; `packages/shared/x402-settlement-types/`
- **Univocity (authoritative)** — `~/Dev/personal/forestrie/univocity`: `src/contracts/_Univocity.sol`, `src/interfaces/IUnivocity.sol`, `src/interfaces/types.sol`, `src/interfaces/constants.sol`, `src/checkpoints/lib/consistencyReceipt.sol`, `src/algorithms/lib/LibLogState.sol`; docs: `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`, `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md`, `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md`, `docs/adr/adr-0001-payer-attribution-permissionless-submission.md`
- **SCITT / COSE (IETF)** — draft-ietf-scitt-scrapi (Register Signed Statement, COSE Sign1, protected 258/259/260, CWT 15); draft-ietf-cose-merkle-tree-proofs (COSE Receipts, vds 395, vdp 396, inclusion -1, consistency -2); draft-bryce-cose-receipts-mmr-profile (MMR inclusion/consistency CBOR, add_leaf_hash); RFC 9052 (COSE), RFC 8392 (CWT).
