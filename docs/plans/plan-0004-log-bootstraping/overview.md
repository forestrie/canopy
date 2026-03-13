# Plan 0004: Log bootstrapping — overview

**Status**: DRAFT  
**Date**: 2026-03-09  
**Related**: [Plan 0001](../plan-0001-register-grant-and-grant-auth-phase.md), [Brainstorm-0001](../../brainstorm-0001-x402-checkpoint-grants.md); univocity contracts and docs (see References below)

## 1. Key outcomes and deliverables

| Outcome | Deliverable |
|--------|-------------|
| **Authority logs bootstrapped from chain** | Root and derived (child auth, data) logs created via univocity contract; first checkpoint and grants follow contract semantics. |
| **Grants issued as authority log leaves** | Grant payload (PublishGrant + idtimestamp) produced; grant-sequencing component (subplan 03) feeds ranger’s existing pipeline so leaf is appended to owner MMR (ranger: optional idtimestamps in ack when configured, see subplan 03 §7.1); grant published to storage; sealer finds grant and signs checkpoints. |
| **Grant creation triggered by x402 settlement** | After payment settle, **canopy** creates the grant (delegation + sign), runs grant-sequencing (push to same DO as register-signed-statement), publishes grant; ranger extends log (unchanged except optional idtimestamps in ack per config); client gets grant location via poll/callback. Primary path: no arbor queue consumer. Canopy must not assume idtimestamp is in the DO — fallback to R2 when resolveContent does not return it. |
| **Auth log status and log type queryable** | REST service exposes root existence and log type (authority vs data) from chain; external implementations and sealer can gate or resolve keys. |
| **No private keys in grant path** | Canopy (and any optional queue consumer) uses signer **delegation** only; bootstrap **public** key (or id) and contract address in config; no key material in queue consumer if that path is used. |

**Out of scope for this plan**: Detailed API contracts, exact queue message schemas, or implementation inside univocity repo; those follow from the subplans and univocity docs.

---

## 2. Subplans (summary and order)

Subplans are in **dependency order**. Each is independently buildable once its dependencies are satisfied; verification steps are in the subplan documents.

| # | Subplan | Summary | Depends on |
|---|---------|---------|------------|
| **01** | [Shared encoding and univocity alignment](subplan-01-shared-encoding-univocity-alignment.md) | Authoritative Go repo **go-univocity** (forestrie/go-univocity) at `arbor/services/_deps/go-univocity`; `docs/` spec for hashing and grant formats (univocity + canopy); encoding/decoding examples in Go, TypeScript, Python; optional go-merklelog only if needed. | — |
| **02** | [REST auth log status and log type service](subplan-02-rest-auth-log-status.md) | Scout-like REST service: read root and log config from chain; endpoints “root exists?”, “log type for logId?”, “list known auth logs”. Supports sealer key resolution and external gating. | — |
| **03** | [Grant-sequencing component](subplan-03-grant-sequencing-component.md) | **Canopy** completes register-grant / post-settlement: produces entry (ownerLogId, ContentHash = inner) and pushes to the **same DO** as register-signed-statement (forestrie-ingress). Ranger: one optional, config-driven change (idtimestamps in ack). DO: optional idtimestamps in ack, two-path update; canopy must use R2 fallback when idtimestamp not in DO. | 01 |
| **04** | [Signer: delegation for bootstrap and parent log](subplan-04-signer-delegation-bootstrap-and-parent.md) | Extend signer to support delegation for a **local key** (bootstrap) and delegation for **parent log** (derived logs). Queue consumer requests these to sign grants; no key material in queue consumer. | — |
| **05** | [Queue consumer: grant-issuance (optional)](subplan-05-queue-consumer-grant-issuance.md) | **Optional/legacy**: Arbor queue consumer for “issue grant” if needed; primary path is canopy (subplan 06). Config, bootstrap/derived flows, hand off to grant-sequencing (subplan 03). | 01, 02, 03, 04 |
| **06** | [Canopy: settlement → grant creation and sequencing](subplan-06-canopy-settlement-to-issue-grant-queue.md) | After x402 settlement, **canopy** creates the grant (delegation + sign), runs grant-sequencing (push to same DO as register-signed-statement), publishes grant; client gets grant location via poll or callback. No arbor queue in primary path. | 01, 02, 03, 04 |
| **07** | [Sealer: key resolution per log](subplan-07-sealer-key-resolution-per-log.md) | Sealer uses REST auth log status service to resolve “which signing key for this logId?”. Find-grant process unchanged (picks up grants from storage). | 02 |

**Suggested build order**: 01 first (go-univocity, spec, test vectors). Then **update canopy** to the shared format (subplan 01 step 7: canopy-api grant codec and tests aligned with go-univocity and fixtures). Then 02, 03, 04 in parallel (no cross-deps). Then 06 (canopy settlement → grant creation and sequencing); 05 is optional. 07 in parallel with 06 (07 needs REST from 02).

**Why subplan 02 is not next after 01**: Subplan 02 (REST auth log status) has no dependency on the grant wire format; it reads root and log config from chain and exposes endpoints. So by dependency alone, 02 could follow 01. The reason to do **canopy format alignment** (01 step 7) before 02 is that until canopy uses the same grant encoding as go-univocity, two formats are in play: arbor/queue consumer will produce grants in go-univocity format, while canopy’s register-grant API may still use a different codec (e.g. different CBOR keys or lengths). Aligning canopy first gives a single source of truth for the format everywhere (canopy, arbor, storage, content-addressable paths) before building 02, 03, 04, 05.

**Ranger: one exception.** Ranger already accepts **opaque values** (ContentHash) and appends them to the log it is asked to extend (logId). It can do the same for grants: we only need to feed it entries with the right logId and ContentHash (inner per subplan 01). The **only** ranger change in this plan: when configured (service config), ranger may include idtimestamps in the batch ack so the DO can store them; when not configured, ack is unchanged and canopy uses R2 fallback for idtimestamp. A **grant-sequencing component** (subplan 03) produces those entries and injects them into the pipeline ranger already consumes. What breaks vs the earlier plan and remaining gaps: see [subplan 03 §6 and §7](subplan-03-grant-sequencing-component.md#6-what-breaks-vs-previous-plan-subplan-03).

**Later (optional)**: Deployment/ops runbooks; client-facing gating (external implementations gate register-statement on “root exists”; canopy/APIs reject sequencing to authority logs using log type from REST service).

---

## 3. Context (minimal)

- **Canopy** (Plan 0001): Placeholder register-grant stores grant in R2, returns path; no authority log, no chain, no leaf append.
- **Univocity**: Root = first checkpoint signed by bootstrap key; other logs need a grant (inclusion in owner). Authority log operator (off-chain) must append the leaf before use; contract only verifies inclusion at `publishCheckpoint`.
- **Arbor**: Ranger (accepts opaque entries, extends requested log; one optional change: idtimestamps in ack when configured, see subplan 03 §7.1), signer (GCP HSM delegation), univocity service (subplan 02: auth log status). Optional queue consumer (subplan 05) would use same delegation pattern; **primary path**: canopy pushes to the same DO as register-signed-statement for both statements and grant-sequencing; grant published to storage for sealer find-grant. Canopy must use R2 fallback for idtimestamp when the DO does not return it.

---

## 4. Refinement questions and further details for agentic implementation

The following should be clarified or specified before or during implementation so that subplans are **optimised for agentic execution**. Add answers or references into the relevant subplan as they become available.

### 4.1 Shared encoding (subplan 01)

- **Authoritative reference**: Go repo **go-univocity** at `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity` and `github.com/forestrie/go-univocity`. Docs in `docs/` (e.g. `docs/grant-and-leaf-format.md`) specify hashing and grant formats; encoding/decoding examples in Go, TypeScript, and Python. May depend on go-merklelog only if needed.
- Exact **leaf commitment** formula and byte layout (univocity `LibLogState.sol` / `_leafCommitment`): which fields, which order, big-endian rules? Capture in go-univocity spec and test vectors.
- **PublishGrant** encoding: field names and types, key ordering; link to univocity types and canopy grant shape in the doc.
- **Idtimestamp** encoding (size, endianness) and how it is combined with PublishGrant in the commitment.

### 4.2 REST auth log status (subplan 02)

- **Exact endpoint list** and request/response shapes: see [subplan 02 §7.1](subplan-02-rest-auth-log-status.md#71-endpoints-and-response-shapes): `GET /api/root`, `GET /api/logs`, `GET /api/logs/{logId}/config`, `GET /api/logs/{logId}/signing-key`; JSON responses as specified there.
- **Contract ABI** and RPC calls: `rootLogId()`, `isLogInitialized(bytes32)`, `logConfig(bytes32)`, `logRootKey(bytes32)`; univocity `IUnivocity.sol` and `types.sol` (LogConfig, LogKind). See subplan 02 §7.2.
- **Polling vs events**: not yet implemented; `GET /api/logs` currently returns only the root when bootstrapped. Full list may be added via event subscription or polling later (subplan 02 §7.3).
- **Sealer key-resolution API**: `GET /api/logs/{logId}/signing-key` returns `logId`, `kind`, `ownerLogId`, `rootKeyX`, `rootKeyY` so the sealer can resolve which signing key to use for that log.

### 4.3 Grant-sequencing component (subplan 03); ranger exception

- **Ranger: one exception.** Ranger is otherwise unchanged (no new message types, queues, or append logic). The only change: when configured, ranger may include idtimestamps in the batch ack (subplan 03 §7.1). It has no opinion on which logs to extend; it just extends the log it is asked to extend.
- **Decided: component lives in canopy.** Canopy already pushes to the DO in register-signed-statement; grant-sequencing uses the **same DO** (enqueue(ownerLogId, inner, extras)). No new arbor component for the primary path. Produces entry in the **existing** format ranger consumes (logId = ownerLogId, ContentHash = inner per subplan 01). **1:1 idtimestamp ↔ mmrIndex** (ranger design) is unchanged.
- **What breaks vs earlier plan**: Earlier subplan 03 assumed ranger would accept new “append leaf” messages; that is withdrawn. See [subplan 03 §6 and §7](subplan-03-grant-sequencing-component.md#6-what-breaks-vs-previous-plan-subplan-03) for what breaks and remaining gaps.
- **Return path**: resolveContent returns leafIndex, massifIndex, and optionally idTimestamp when the DO has it. Canopy **must not assume** idtimestamp is in the DO; when idTimestamp is missing or null, canopy **must** use the R2 fallback (e.g. readIdtimestampFromMassif). Idempotency: see subplan 03 §7.

### 4.4 Signer delegation (subplan 04)

- **Existing signer API** (request delegation, payload to sign): current contract and how “delegation for log L” is expressed.
- **“Delegation for local key”** semantics: who creates the local key, how it is tied to bootstrap public key/id, and how the signer service exposes it.
- **“Delegation for parent log”**: how parent log is identified (logId?), and how signer resolves parent’s key (REST log-type service call, or internal mapping).

### 4.5 Queue consumer (subplan 05) — optional

- **Primary path is canopy** (subplan 06): canopy creates grant and pushes to same DO. Subplan 05 is **optional/legacy** if an arbor queue consumer is ever needed.
- If used: “issue grant” message schema; config (bootstrap public key, contract address); detection of “contract not bootstrapped” and “derived log”; grant storage path; hand off to grant-sequencing (same DO push from arbor or callback to canopy).

### 4.6 Canopy settlement → grant creation and sequencing (subplan 06)

- **Primary path**: After x402 settlement, **canopy** (canopy-api or settlement worker) creates the grant (delegation + sign), runs grant-sequencing (push to same DO as register-signed-statement), publishes grant. No enqueue to arbor queue.
- **Settlement detection**: where settlement completes (canopy-api vs x402-settlement worker) and how it triggers grant creation.
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
- **Arbor**: Ranger (DO ingress consumer; unchanged for grants), Scout (REST API), univocity service (auth log status, subplan 02), signer service (GCP HSM delegation).
