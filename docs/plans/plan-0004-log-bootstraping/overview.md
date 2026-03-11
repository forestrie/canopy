# Plan 0004: Log bootstrapping — overview

**Status**: DRAFT  
**Date**: 2026-03-09  
**Related**: [Plan 0001](../plan-0001-register-grant-and-grant-auth-phase.md), [Brainstorm-0001](../../brainstorm-0001-x402-checkpoint-grants.md); univocity contracts and docs (see References below)

## 1. Key outcomes and deliverables

| Outcome | Deliverable |
|--------|-------------|
| **Authority logs bootstrapped from chain** | Root and derived (child auth, data) logs created via univocity contract; first checkpoint and grants follow contract semantics. |
| **Grants issued as authority log leaves** | Grant payload (PublishGrant + idtimestamp) produced, leaf appended to owner MMR by ranger, grant published to storage; sealer finds grant and signs checkpoints. |
| **Grant creation triggered by x402 settlement** | After payment settle, “issue grant” is enqueued; queue consumer creates grant, sends leaf to ranger, publishes grant; client gets grant location via poll/callback. |
| **Auth log status and log type queryable** | REST service exposes root existence and log type (authority vs data) from chain; external implementations and sealer can gate or resolve keys. |
| **No private keys in queue consumer** | Queue consumer configured with bootstrap **public** key (or id) and contract address; uses signer **delegation** (local key for bootstrap, parent log for derived). |

**Out of scope for this plan**: Detailed API contracts, exact queue message schemas, or implementation inside univocity repo; those follow from the subplans and univocity docs.

---

## 2. Subplans (summary and order)

Subplans are in **dependency order**. Each is independently buildable once its dependencies are satisfied; verification steps are in the subplan documents.

| # | Subplan | Summary | Depends on |
|---|---------|---------|------------|
| **01** | [Shared encoding and univocity alignment](subplan-01-shared-encoding-univocity-alignment.md) | Authoritative Go repo **go-univocity** (forestrie/go-univocity) at `arbor/services/_deps/go-univocity`; `docs/` spec for hashing and grant formats (univocity + canopy); encoding/decoding examples in Go, TypeScript, Python; optional go-merklelog only if needed. | — |
| **02** | [REST auth log status and log type service](subplan-02-rest-auth-log-status.md) | Scout-like REST service: read root and log config from chain; endpoints “root exists?”, “log type for logId?”, “list known auth logs”. Supports sealer key resolution and external gating. | — |
| **03** | [Ranger: authority log leaf append](subplan-03-ranger-authority-leaf-append.md) | Ranger accepts “append leaf” messages (e.g. queue), appends to owner authority log MMR, persists to R2 in arbor format. Idempotency by leaf commitment. | 01 |
| **04** | [Signer: delegation for bootstrap and parent log](subplan-04-signer-delegation-bootstrap-and-parent.md) | Extend signer to support delegation for a **local key** (bootstrap) and delegation for **parent log** (derived logs). Queue consumer requests these to sign grants; no key material in queue consumer. | — |
| **05** | [Queue consumer: grant-issuance service](subplan-05-queue-consumer-grant-issuance.md) | Arbor queue consumer: config (bootstrap public key/id, contract address); consume “issue grant” and bootstrap/derived flows; request delegation, create/sign grant, send leaf to ranger queue, publish grant to storage. | 01, 02, 03, 04 |
| **06** | [Canopy: settlement to issue-grant queue](subplan-06-canopy-settlement-to-issue-grant-queue.md) | After x402 settlement, canopy-api or x402-settlement worker enqueues “issue grant” to arbor queue (message: grant request + settlement/idempotency key). Client gets grant location via poll or callback. | 05 |
| **07** | [Sealer: key resolution per log](subplan-07-sealer-key-resolution-per-log.md) | Sealer uses REST auth log status service to resolve “which signing key for this logId?”. Find-grant process unchanged (picks up grants from storage). | 02 |

**Suggested build order**: 01 first (go-univocity, spec, test vectors). Then **update canopy** to the shared format (subplan 01 step 7: canopy-api grant codec and tests aligned with go-univocity and fixtures). Then 02, 03, 04 in parallel (no cross-deps). Then 05. Then 06 and 07 in parallel (06 needs queue from 05; 07 needs REST from 02).

**Why subplan 02 is not next after 01**: Subplan 02 (REST auth log status) has no dependency on the grant wire format; it reads root and log config from chain and exposes endpoints. So by dependency alone, 02 could follow 01. The reason to do **canopy format alignment** (01 step 7) before 02 is that until canopy uses the same grant encoding as go-univocity, two formats are in play: arbor/queue consumer will produce grants in go-univocity format, while canopy’s register-grant API may still use a different codec (e.g. different CBOR keys or lengths). Aligning canopy first gives a single source of truth for the format everywhere (canopy, arbor, storage, content-addressable paths) before building 02, 03, 04, 05.

**Later (optional)**: Deployment/ops runbooks; client-facing gating (external implementations gate register-statement on “root exists”; canopy/APIs reject sequencing to authority logs using log type from REST service).

---

## 3. Context (minimal)

- **Canopy** (Plan 0001): Placeholder register-grant stores grant in R2, returns path; no authority log, no chain, no leaf append.
- **Univocity**: Root = first checkpoint signed by bootstrap key; other logs need a grant (inclusion in owner). Authority log operator (off-chain) must append the leaf before use; contract only verifies inclusion at `publishCheckpoint`.
- **Arbor**: Ranger (queue consumer), Scout (REST), signer (GCP HSM delegation). Queue consumer uses same delegation pattern as sealer; ranger performs MMR append; grant published to storage for sealer find-grant.

---

## 4. Refinement questions and further details for agentic implementation

The following should be clarified or specified before or during implementation so that subplans are **optimised for agentic execution**. Add answers or references into the relevant subplan as they become available.

### 4.1 Shared encoding (subplan 01)

- **Authoritative reference**: Go repo **go-univocity** at `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity` and `github.com/forestrie/go-univocity`. Docs in `docs/` (e.g. `docs/grant-and-leaf-format.md`) specify hashing and grant formats; encoding/decoding examples in Go, TypeScript, and Python. May depend on go-merklelog only if needed.
- Exact **leaf commitment** formula and byte layout (univocity `LibLogState.sol` / `_leafCommitment`): which fields, which order, big-endian rules? Capture in go-univocity spec and test vectors.
- **PublishGrant** encoding: field names and types, key ordering; link to univocity types and canopy grant shape in the doc.
- **Idtimestamp** encoding (size, endianness) and how it is combined with PublishGrant in the commitment.

### 4.2 REST auth log status (subplan 02)

- **Exact endpoint list** and request/response shapes (e.g. `GET /root`, `GET /logs/{logId}/type`, `GET /logs`).
- **Contract ABI** and RPC calls used (e.g. `rootLogId()`, `getLogState(logId)`); univocity interface and storage layout.
- **Polling vs events**: refresh interval or event subscription; how “aware of logs as they are created” is implemented.
- **Sealer key-resolution API**: exact query (e.g. “return key id or endpoint for signing logId L”) and response shape.

### 4.3 Ranger authority leaf append (subplan 03)

- **Message format** for “append leaf”: queue payload schema (ownerLogId, leaf bytes, idempotency key?, grant location?).
- **Queue name/binding** and who produces messages (queue consumer only, or also others).
- **R2 path layout** for authority log MMR (bucket, prefix, naming) and how it aligns with existing arbor massif/checkpoint layout.
- **Idempotency rule**: same leaf hash → no-op and return existing index, or reject duplicate?

### 4.4 Signer delegation (subplan 04)

- **Existing signer API** (request delegation, payload to sign): current contract and how “delegation for log L” is expressed.
- **“Delegation for local key”** semantics: who creates the local key, how it is tied to bootstrap public key/id, and how the signer service exposes it.
- **“Delegation for parent log”**: how parent log is identified (logId?), and how signer resolves parent’s key (REST log-type service call, or internal mapping).

### 4.5 Queue consumer (subplan 05)

- **“Issue grant” message schema**: grant request fields, settlement id / idempotency key, target logId, ownerLogId, kind (bootstrap vs derived).
- **Config**: bootstrap public key format (bytes, hex, or id string) and where it is stored (env, Doppler, file).
- **Detection of “contract not bootstrapped”**: use REST auth log service vs direct chain read; and detection of “derived log” (parent exists, logId not yet registered).
- **Grant storage path**: same as canopy R2_GRANTS path schema (content-addressable) or separate; who writes (queue consumer only vs canopy).

### 4.6 Canopy settlement to queue (subplan 06)

- **Producer**: which component enqueues (canopy-api vs x402-settlement worker) and from where in the settlement flow.
- **Queue identity**: queue name, region, and how arbor queue consumer is bound (e.g. Cloudflare Queue, SQS, or in-repo queue).
- **Client grant location**: how grant location is returned (settlement callback payload, status endpoint URL, or existing receipt field).

### 4.7 Sealer key resolution (subplan 07)

- **When** sealer calls the REST service (per checkpoint, per log, or cached with invalidation).
- **Response → key selection**: how “log type + owner” maps to “which key to request from signer” (bootstrap vs parent log key id).
- **Failure behaviour**: if REST service is down or logId unknown, retry vs fail checkpoint.

### 4.8 Cross-cutting

- **Univocity contract address** and **network** (testnet vs mainnet) per environment; where configured (env, Doppler).
- **Observability**: logging, metrics, and tracing for queue consumer, ranger append path, and REST service; and for chain tx success/failure.
- **Testing**: use of testnet, mocks, or in-process fakes for chain and signer in unit/integration tests.

---

## 5. Consistency and redundancy (review)

- **Overview** confines itself to outcomes, deliverables, subplan summary table, build order, context, and refinement questions. It does not repeat the full narrative previously in the single-doc plan; that detail is distributed into the subplans and refinement answers.
- **Subplans** are scoped to single components; dependencies are explicit so agents can schedule work. Overlap is limited to: (1) subplans 02 and 05 both “know” about chain state (02 exposes it, 05 consumes it); (2) subplans 04 and 07 both interact with the signer (04 extends delegation API, 07 uses key resolution that may call 02). No duplicate task lists; verification in each subplan is local to that component.
- **Refinement questions** (§4) are the single place for “to be decided” details; answers should be written into the relevant subplan as they are fixed so agents have one source of truth per topic.

---

## 6. References

- **Canopy**: [Plan 0001](../plan-0001-register-grant-and-grant-auth-phase.md), [Brainstorm-0001](../../brainstorm-0001-x402-checkpoint-grants.md), [register-grant API](../../api/register-grant.md).
- **Univocity** (paths relative to univocity repo): `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`, `docs/arc/arc-0017-auth-overview.md`, `docs/arc/arc-0017-log-hierarchy-and-authority.md`, `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md`, `docs/plans/plan-0027-abstract-base-bootstrap-pattern.md`, `docs/adr/adr-0003-bootstrap-keys-opaque-constructor.md`, `docs/adr/adr-0004-root-log-self-grant-extension.md`, `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md`, `docs/adr/adr-0001-payer-attribution-permissionless-submission.md`, `AGENT_CONTEXT.md`.
- **Arbor**: Ranger (queue consumer), Scout (REST API), signer service (GCP HSM delegation).
