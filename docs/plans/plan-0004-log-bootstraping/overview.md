# Plan 0004: Log bootstrapping — overview

**Status**: DRAFT  
**Date**: 2026-03-09  
**Related**: [ARC-0001 grant verification](../arc-0001-grant-verification.md) (receipt-based inclusion), [Plan 0001](../archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md), [Brainstorm-0001](../../brainstorm-0001-x402-checkpoint-grants.md); univocity contracts and docs (see References below)

## 1. Key outcomes and deliverables

| Outcome | Deliverable |
|--------|-------------|
| **Authority logs bootstrapped from chain** | Root and derived (child auth, data) logs created via univocity contract; first checkpoint and grants follow contract semantics. |
| **Grants issued as authority log leaves** | Grant payload (PublishGrant + idtimestamp) produced; grant-sequencing component (subplan 03) feeds ranger’s existing pipeline so leaf is appended to owner MMR (ranger: optional idtimestamps in ack when configured, see subplan 03 §7.1); grant published to storage; sealer finds grant and signs checkpoints. |
| **Root bootstrap (grant-first)** | Bootstrap grant is created and signed **once** (one-time API or ops), published at a well-known URL. register-grant and register-signed-statement **always** require **auth** (a signed grant). First call: caller supplies the bootstrap grant as auth; API allows when logId not initialized and auth is bootstrap-signed (no inclusion check). All other calls require **receipt-based inclusion** ([ARC-0001](../arc-0001-grant-verification.md)). See [Subplan 08](archived/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md). |
| **Grant creation triggered by x402 settlement (paid grants)** | After payment settle, **canopy** creates the grant (delegation + sign), runs grant-sequencing (push to same DO as register-signed-statement), publishes grant; client gets grant location via poll/callback. **Bootstrap is not via settlement** — see subplan 08. Primary path: no arbor queue consumer. Canopy must not assume idtimestamp is in the DO — fallback to R2 when resolveContent does not return it. |
| **Auth log status and log type queryable** | REST service exposes root existence and log type (authority vs data) from chain; external implementations and sealer can gate or resolve keys. |
| **No private keys in grant path** | Canopy (and any optional queue consumer) uses signer **delegation** only; bootstrap **public** key (or id) and contract address in config; no key material in queue consumer if that path is used. |

**Out of scope for this plan**: Detailed API contracts, exact queue message schemas, or implementation inside univocity repo; those follow from the subplans and univocity docs.

---

## 2. Subplans (summary and order)

**Active subplans** (06, 07) are in §2.2. **Archived subplans** (01–05, 08) are summarized in §2.1 by outcome and any implementation choices that differed from the original intent; full docs are in [../archived/plan-0004-log-bootstraping/](../archived/plan-0004-log-bootstraping/).

### 2.1 Archived subplans (outcomes and implementation notes)

| # | Subplan | Outcome | Implementation choices that differed |
|---|---------|---------|--------------------------------------|
| **01** | [Shared encoding and univocity alignment](archived/plan-0004-log-bootstraping/subplan-01-shared-encoding-univocity-alignment.md) | go-univocity repo at `arbor/services/_deps/go-univocity` with spec (leaf commitment, PublishGrant), Go impl (InnerHash, grant encode/decode), test vectors; canopy grant codec aligned; **inner = ContentHash** for grant-sequencing. | None; implemented as scoped. go-merklelog not used. |
| **02** | [REST auth log status](archived/plan-0004-log-bootstraping/subplan-02-rest-auth-log-status.md) | REST service in arbor `services/univocity`: GET /api/root, /api/logs, /api/logs/{logId}/config, /api/logs/{logId}/signing-key. Chain read via RPC; sealer key-resolution shape as specified. | **New logs**: Implementation does not index created logs; GET /api/logs returns only the root when bootstrapped. Full list (event subscription or polling) deferred. |
| **03** | [Grant-sequencing component](archived/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md) | Grant-sequencing in **canopy-api**: async register-grant (303 + status URL), enqueue to same DO as register-signed-statement, dedupe by inner, serve-grant, R2 fallback when idtimestamp not in DO. | **Location**: Implemented in **canopy only** (same DO). **Ranger**: Earlier "append leaf" messages to ranger **withdrawn** — ranger unchanged except optional idtimestamps in ack when configured. |
| **04** | [Signer delegation](archived/plan-0004-log-bootstraping/subplan-04-signer-delegation-bootstrap-and-parent.md) + [delegation-signer in Canopy](archived/plan-0004-log-bootstraping/subplan-04-delegation-signer-in-canopy.md) | Delegation for bootstrap and parent in **Canopy** delegation-signer: POST /api/delegate/bootstrap, POST /api/delegate/parent; GET /api/public-key/:bootstrap. KMS in Canopy only. | **Location**: Original "extend signer service" (arbor). **Implemented in Canopy** (KMS not allowed from arbor). **Key-creation** (KMS on GC_AUTH_LOG grant) not implemented; now in Custodian (plan-0011). |
| **05** | [Queue consumer (optional)](archived/plan-0004-log-bootstraping/subplan-05-queue-consumer-grant-issuance.md) | Not implemented. | Primary path is canopy (subplan 06); no arbor queue consumer in current design. Subplan 05 remains optional/legacy. |
| **08** | [Grant-first root bootstrap](archived/plan-0004-log-bootstraping/subplan-08-grant-first-bootstrap.md) | POST /api/grants/bootstrap; register-grant and register-signed-statement require auth; bootstrap branch when logId not initialized and auth is bootstrap-signed. | Option B (canopy one-time API) for mint. Well-known GET for bootstrap grant deferred (Plan 0005). Token source to move to Custodian (plan-0011). |

### 2.2 Active subplans

| # | Subplan | Summary | Depends on |
|---|---------|---------|------------|
| **06** | [Canopy: settlement → grant creation and sequencing](subplan-06-canopy-settlement-to-issue-grant-queue.md) | After x402 settlement (**paid grants only**), **canopy** creates the grant (delegation + sign), runs grant-sequencing, publishes grant; client gets grant location. Bootstrap is **not** via settlement (archived subplan 08). | 01, 02, 03, 04 (archived; Canopy has delegation-signer and grant-sequencing). |
| **07** | [Sealer: key resolution per log](subplan-07-sealer-key-resolution-per-log.md) | Sealer uses REST auth log status (archived 02) to resolve "which signing key for this logId?". Find-grant unchanged. | 02 (archived). |

### 2.3 Implementation order (remaining work only)

1. **Custodian integration** ([plan-0011](../plan-0011-custodian-integration-and-current-state.md)) — Canopy obtains bootstrap token from Custodian `POST /api/token/bootstrap`; retire long-lived/cron token.
2. **Subplan 06** — Canopy: on x402 settlement success (paid grants only), create grant (delegation-signer 04, encoding 01), run grant-sequencing (03), publish, return grant location.
3. **Subplan 07** (optional / parallel) — Sealer key resolution using REST from archived subplan 02.
4. **Optional** — DO/ranger: idtimestamps in batch ack (archived subplan 03 §7.1); canopy already has R2 fallback.

**Ranger note.** Ranger accepts opaque ContentHash and extends the requested logId; the only planned change is optional idtimestamps in the batch ack when configured. Grant-sequencing (archived 03) produces entries (ownerLogId, inner) and pushes to the same DO. See [subplan 03 §6 and §7](archived/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md#6-what-breaks-vs-previous-plan-subplan-03).

**Later (optional)**: Deployment/ops runbooks; client-facing gating (external implementations gate register-statement on "root exists"; canopy/APIs reject sequencing to authority logs using log type from REST service).

---

## 3. Context (minimal)

- **Canopy** (Plan 0001): Placeholder register-grant stores grant in R2, returns path; no authority log, no chain, no leaf append.
- **Univocity**: Root = first checkpoint signed by bootstrap key; other logs need a grant (inclusion in owner). Authority log operator (off-chain) must append the leaf before use; contract only verifies inclusion at `publishCheckpoint`.
- **Arbor**: Ranger (accepts opaque entries, extends requested log; one optional change: idtimestamps in ack when configured, see subplan 03 §7.1), signer (GCP HSM delegation), univocity service (subplan 02: auth log status). Optional queue consumer (subplan 05) would use same delegation pattern; **primary path**: canopy pushes to the same DO as register-signed-statement for both statements and grant-sequencing; grant published to storage for sealer find-grant. Canopy must use R2 fallback for idtimestamp when the DO does not return it.

---

## 4. Refinement and implementation details (remaining work)

This section is scoped to **remaining work** (§2.3) and reflects **design choices already present in the code**. It is the single place for open questions and agent-oriented details; answers should be written into the relevant subplan or plan-0011 as they are fixed.

### 4.1 Custodian integration (plan-0011)

**Current code.** Canopy-api uses `DELEGATION_SIGNER_BEARER_TOKEN` in two places: (1) POST /api/grants/bootstrap — `index.ts` passes `env.DELEGATION_SIGNER_BEARER_TOKEN` into `handlePostBootstrapGrant`; (2) register-grant / register-signed-statement bootstrap branch — `bootstrapEnv.delegationSignerBearerToken` is built from the same env when `ROOT_LOG_ID`, `DELEGATION_SIGNER_URL`, `DELEGATION_SIGNER_BEARER_TOKEN`, and `UNIVOCITY_SERVICE_URL` are set (`index.ts`). `bootstrap-public-key.ts` uses optional `delegationSignerPublicKeyToken` for GET /api/public-key/:bootstrap (can be same token or a read-only token).

**Delegation-signer API (evident in code).** `bootstrap-grant.ts` calls POST `/api/delegate/bootstrap` with JSON body `{ cose_tbs_hash, alg }` (64-char hex digest, ES256 | KS256). Delegation-signer (`delegate-grant.ts`) expects `payload_hash` (64 hex) and signs with KMS; both names refer to the same SHA-256 digest of the COSE Sig structure. Bearer token is required; delegation-signer forwards it to GCP KMS.

**Refinement for Custodian.** Plan-0011 checklist applies. Add `CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`; implement `fetchDelegationSignerTokenFromCustodian()` (POST /api/token/bootstrap); use in-memory or short-lived cache; in bootstrap route and in `bootstrapEnv` construction, obtain token from Custodian (or cache) instead of `DELEGATION_SIGNER_BEARER_TOKEN`. Config guard: when Custodian is set, prefer Custodian and ignore or deprecate the static token. No change to delegation-signer or to request/response shapes between canopy-api and delegation-signer.

### 4.2 Subplan 06: Settlement → grant creation and sequencing

**Current code.** Grant-sequencing is implemented: `enqueueGrantForSequencing(ownerLogIdBytes, inner, env)` in `scrapi/grant-sequencing.ts` — dedupe by `resolveContent(inner)`, then `queue.enqueue(logId16, contentHashBytes, undefined)` on the same DO namespace as register-signed-statement. Grant encoding and inner hash: `grant/grant-commitment.ts`, `grant/codec.ts`. Delegation-signer client for signing: used in `bootstrap-grant.ts` (POST /api/delegate/bootstrap); for subplan 06 the same pattern applies for POST /api/delegate/parent with `parent_log_id` and digest. Register-grant returns 303 to status URL `/logs/{ownerLogId}/entries/{innerHex}`; client polls until sequenced; serve-grant (GET /grants/authority/:innerHex) completes the grant document when sequencing result is available.

**Gap: settlement → grant flow.** Current x402 settlement pipeline is **statement-centric**: `SettlementJob` carries `logId`, `contentHash` (statement hash), `authId`, `payload`, etc. There is no **grant-specific** job type or "pay for a grant" endpoint that carries grant parameters (logId, ownerLogId, kind, grant flags, etc.) and settlement id for idempotency. So:

- **Settlement completion hook**: Decide where grant creation is triggered — (a) **x402-settlement worker** after successful `processJob`: call back to canopy-api (e.g. HTTP POST with settlement id + grant context), or (b) **canopy-api** when it enqueues a "grant settlement" job: job shape includes grant params, and a **separate consumer** (canopy-api queue consumer or x402-settlement extension) runs grant creation when settlement succeeds, or (c) **canopy-api** exposes "complete grant after payment" (client or facilitator calls with settlement proof + grant params). Choice affects job schema, worker boundaries, and how the client receives the grant location.
- **Grant params at settlement time**: For "pay for a grant", the client (or facilitator) must supply grant parameters when initiating payment. Those params must be stored with the job or the auth/session so that on settlement success the correct grant can be built (ownerLogId, kind, flags, etc.) and signed via delegation-signer (parent).
- **Idempotency**: Use settlement id (or job idempotency key) so duplicate settlement does not create a second grant; grant-sequencing already dedupes by inner.
- **Client grant location**: Same as register-grant path — 303 to status URL, client polls; or settlement callback payload includes status URL or final grant path. Serve-grant and R2_GRANTS publish path already exist.

**Code touchpoints (when decided).** Settlement handler or new "grant settlement" path; signer client for POST /api/delegate/parent (reuse pattern from bootstrap-grant); grant build (codec, inner) and `enqueueGrantForSequencing`; resolveContent + R2 fallback for idtimestamp; write grant doc to R2_GRANTS; return location. All in canopy-api or split between canopy-api and x402-settlement worker per chosen design.

### 4.3 Subplan 07: Sealer key resolution per log

**Current code.** Arbor univocity service (archived subplan 02) exposes GET /api/logs/{logId}/signing-key with response `{ logId, kind, ownerLogId, rootKeyX, rootKeyY }`. Canopy has **no** sealer; it has a univocity **REST client** (`scrapi/univocity-rest.ts`) for `getRoot`, `getLogConfig`, `isLogInitialized` — used by register-grant for the bootstrap branch. The **sealer** lives in **arbor** and is the consumer of the signing-key endpoint.

**Refinement (arbor sealer).** Implement in arbor sealer: (1) For each log the sealer must sign, call GET /api/logs/{logId}/signing-key. (2) Map response (kind, ownerLogId, rootKeyX/Y) to "which key to request from the signer" — bootstrap key for root, parent key for derived; the signer is the **Canopy delegation-signer** (sealer already calls it for delegations). (3) Failure behaviour: if REST returns 404 or error, do not use a fallback key; retry with backoff or mark checkpoint failed; document in subplan 07. (4) Optional: cache key resolution per logId with TTL to avoid repeated REST calls per checkpoint.

**Canopy.** No change required for subplan 07; REST API is already implemented in arbor. Canopy's univocity-rest client is only for log-initialized checks.

### 4.4 Optional: DO and ranger idtimestamps in batch ack

**Current code.** Canopy grant-sequencing and query-registration-status **do not assume** idtimestamp is in the DO; they use R2 fallback (`readIdtimestampFromMassif`) when `resolveContent` does not return idtimestamp. So correctness is already satisfied.

**Optional optimisation.** Archived subplan 03 §7.1: ranger can be configured to include idtimestamps in the batch ack; the DO stores them and `resolveContent` can return idtimestamp, reducing latency and R2 reads. Implementation is in the DO (forestrie-ingress) and ranger (arbor); canopy remains compatible by keeping the R2 fallback.

### 4.5 Cross-cutting

- **Environment and config.** Env vars in use (canopy-api): `ROOT_LOG_ID`, `DELEGATION_SIGNER_URL`, `DELEGATION_SIGNER_BEARER_TOKEN`, `DELEGATION_SIGNER_PUBLIC_KEY_TOKEN`, `UNIVOCITY_SERVICE_URL`, `SEQUENCING_QUEUE`, `QUEUE_SHARD_COUNT`, `R2_GRANTS`, `MASSIF_HEIGHT`, etc. Custodian adds `CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`. Subplan 06 may add settlement-related config (queue, DO, or callback URL). Univocity contract address and network: `UNIVOCITY_CONTRACT_RPC_URL`, `UNIVOCITY_CONTRACT_ADDRESS` where used (e.g. inclusion verification).
- **Observability.** Logging and metrics: bootstrap mint, register-grant (bootstrap vs receipt branch), grant-sequencing (enqueue, dedupe), delegation-signer calls; settlement path when implemented. No new cross-cutting observability beyond existing patterns.
- **Testing.** Unit tests: grant codec, inner hash, grant-sequencing dedupe and enqueue. Integration: bootstrap mint (mock or real delegation-signer), register-grant with bootstrap env and queue, register-signed-statement with inclusion. Custodian: mock POST /api/token/bootstrap or use test app token. Subplan 06: mock settlement completion and assert grant creation and R2 publish.


---

## 5. Current status and next steps

- **Completed subplans** (01–05, 08) are **archived**. See [../archived/plan-0004-log-bootstraping/README.md](../archived/plan-0004-log-bootstraping/README.md) for the list and reasons. Implemented: shared encoding (01), REST auth log status (02), grant-sequencing in canopy (03), delegation-signer in Canopy (04), grant-first bootstrap (08).
- **Token source**: Bootstrap and register-signed-statement currently use a Bearer token (e.g. `DELEGATION_SIGNER_BEARER_TOKEN`). The intended path is to obtain it from **Custodian** (`POST /api/token/bootstrap`). See [plan-0011](../plan-0011-custodian-integration-and-current-state.md).
- **Pending**: **Subplan 06** (canopy settlement → grant creation and sequencing); **Subplan 07** (sealer key resolution). Optional: DO/ranger idtimestamps in batch ack (see archived subplan 03 §7.1).
- **Recommended order**: (1) Custodian integration (plan-0011); (2) implement subplan 06; (3) optional subplan 07, optional idtimestamps in ack.

---

## 6. Key decisions (resolved)

- **Grant model**: All grants require x402 payment except the bootstrap grant; only the bootstrap grant is free and signed by the bootstrap key (or delegate). Paid grants: register-grant/x402 → settlement → canopy creates grant and sequences.
- **Grant-sequencing**: Lives in **canopy**; canopy pushes to the **same DO** as register-signed-statement (forestrie-ingress). No arbor queue consumer in the primary path.
- **Return path**: `resolveContent(inner)` returns leafIndex, massifIndex, and optionally idTimestamp. Canopy **must not assume** idtimestamp is in the DO; when missing, use R2 fallback (e.g. `readIdtimestampFromMassif`). Optional: idtimestamps in batch ack (DO + ranger config); see archived subplan 03 §7.1.
- **Idempotency**: Grant-sequencing dedupes by inner before enqueue; check `resolveContent(inner)` before push; if already sequenced, use existing result (archived subplan 03 §7.2, §8).

---

## 7. Consistency and redundancy (review)

- **Overview** confines itself to outcomes, deliverables, subplan summary table, build order, context, and refinement questions. It does not repeat the full narrative previously in the single-doc plan; that detail is distributed into the subplans and refinement answers.
- **Subplans** are scoped to single components; dependencies are explicit so agents can schedule work. Overlap is limited to: (1) subplans 02 and 05 both “know” about chain state (02 exposes it, 05 consumes it); (2) subplans 04 and 07 both interact with the signer (04 extends delegation API, 07 uses key resolution that may call 02). No duplicate task lists; verification in each subplan is local to that component.
- **Refinement questions** (§4) are the single place for “to be decided” details; answers should be written into the relevant subplan as they are fixed so agents have one source of truth per topic.

---

## 8. References

- **Canopy**: [Plan 0001](../archived/plan-0001/plan-0001-register-grant-and-grant-auth-phase.md), [Brainstorm-0001](../../brainstorm-0001-x402-checkpoint-grants.md), [register-grant API](../../api/register-grant.md).
- **Univocity** (paths relative to univocity repo): `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`, `docs/arc/arc-0017-auth-overview.md`, `docs/arc/arc-0017-log-hierarchy-and-authority.md`, `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md`, `docs/plans/plan-0027-abstract-base-bootstrap-pattern.md`, `docs/adr/adr-0003-bootstrap-keys-opaque-constructor.md`, `docs/adr/adr-0004-root-log-self-grant-extension.md`, `docs/adr/adr-0005-grant-constrains-checkpoint-signer.md`, `docs/adr/adr-0001-payer-attribution-permissionless-submission.md`, `AGENT_CONTEXT.md`.
- **Arbor**: Ranger (DO ingress consumer; unchanged for grants), Scout (REST API), univocity service (auth log status, subplan 02), signer service (GCP HSM delegation).
