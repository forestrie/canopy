# Subplan 01: Shared encoding and univocity alignment

**Status**: ACCEPTED  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)  
**Implementation**: Complete (go-univocity and canopy aligned; inner = ContentHash for grant-sequencing implemented per §7.9–7.10).

## 1. Scope

- Establish an **authoritative reference implementation** for **leaf commitment** and **PublishGrant** (grant) encoding, aligned with the univocity contract and with canopy’s grant format (Plan 0001).
- **New repository**: Go-based implementation in a dedicated repo, **go-univocity**, which is the single source of truth for hashing and grant formats. It may depend on **go-merklelog** only if required (e.g. for MMR leaf hashing); otherwise keep dependencies minimal.
- **Documentation**: A `docs/` path in that repo with markdown that specifies the hashing and grant formats (cognisant of univocity Solidity and canopy), and that includes **encoding/decoding examples in Go, TypeScript, and Python** so canopy, arbor, and other consumers can implement or verify against the spec.
- **Test vector generation**: A Python script **`tests/scripts/gen_testvectors.py`** that generates test vectors (e.g. grant payloads, leaf commitments, encoded bytes) usable by each language (Go, TypeScript, Python) so implementations can assert against the same fixtures.

**Out of scope**: Changes inside univocity repo; COSE/CBOR for statements (handled elsewhere). TypeScript or Python reference libraries are not required in this repo; only the Go implementation, the doc with examples in all three languages, and the test-vector generator script.

## 2. Repository identity and location

- **Name**: `go-univocity` (GitHub: `forestrie/go-univocity`).
- **On disk**: `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity`.
- **GitHub**: Create the repository under the **forestrie** organisation.
- **Dependency**: Use **go-merklelog** only if the implementation needs it (e.g. for MMR structure or leaf hashing); otherwise no external grant/leaf dependencies.

## 3. Dependencies

- None for this subplan. This subplan is a prerequisite for subplans 03 (grant-sequencing: inner for ranger entry) and 05 (queue consumer).

## 4. Inputs

- Univocity source: `_leafCommitment`, PublishGrant / grant types (univocity `src/interfaces/types.sol`, `src/algorithms/lib/LibLogState.sol`).
- Canopy grant format (Plan 0001): [register-grant API](../../api/register-grant.md), grant codec in canopy-api (logId, kind, grant flags, maxHeight, minGrowth, ownerLogId, grantData, signer, idtimestamp).

## 5. Deliverables

| Deliverable | Description |
|-------------|-------------|
| **Repository go-univocity** | New Go module at `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity`, pushed to `github.com/forestrie/go-univocity`. |
| **docs/ spec** | Markdown in `docs/` (e.g. `docs/grant-and-leaf-format.md`) specifying: hashing (leaf commitment formula, field order, encoding, endianness); grant format (PublishGrant field list and types, idtimestamp); alignment with univocity Solidity and canopy. |
| **Encoding/decoding examples** | In that doc: working examples in **Go**, **TypeScript**, and **Python** for encoding and decoding the grant and for computing the leaf commitment (so each language can implement or verify). |
| **Go implementation** | Go package(s): at least `leafCommitment(grantIDTimestampBe, logId, grant, maxHeight, minGrowth, ownerLogId, grantData) -> []byte`; and grant encode/decode consistent with the spec. Use go-merklelog only if needed. |
| **Test vectors** | At least one known-answer leaf hash (from univocity contract or tests) and grant round-trip tests; doc or test file so other repos can verify. |
| **gen_testvectors.py** | Python script at **`tests/scripts/gen_testvectors.py`** that generates test vectors (grant inputs, encoded bytes, leaf commitments) for each language (Go, TypeScript, Python); output format (e.g. JSON or language-specific fixture files) so all three can consume the same vectors. |
| **Alignment note** | In the doc or a separate `docs/alignment.md`: mapping between canopy grant fields and univocity PublishGrant + idtimestamp; any gaps (e.g. kind vs request code). |

## 6. Steps to accomplish

1. **Create directory and initialise Go module**
   - `mkdir -p ~/Dev/personal/forestrie/arbor/services/_deps/go-univocity`
   - `cd ~/Dev/personal/forestrie/arbor/services/_deps/go-univocity`
   - `go mod init github.com/forestrie/go-univocity`
   - Add `.gitignore` (e.g. from a typical Go repo), and a minimal `README.md` stating purpose and link to `docs/`.

2. **Add docs/ and format spec**
   - Create `docs/` directory.
   - Add markdown doc (e.g. `docs/grant-and-leaf-format.md`) that:
     - Specifies the **leaf commitment** formula (matching univocity `_leafCommitment`): field order, types, endianness (e.g. grantIDTimestampBe, then inner hash of logId, grant, maxHeight, minGrowth, ownerLogId, grantData).
     - Specifies the **grant (PublishGrant)** format: field list, types, and idtimestamp encoding; notes alignment with univocity types and canopy Plan 0001 grant shape.
     - Is cognisant of both univocity Solidity and canopy (reference univocity sources and canopy register-grant API / grant codec).
   - Include **encoding/decoding examples** in **Go**, **TypeScript**, and **Python** (inline or in code blocks): e.g. build a grant struct, encode to bytes, decode from bytes, compute leaf commitment. Examples should be runnable or copy-pasteable where practical.

3. **Implement Go package**
   - Implement leaf commitment and grant encode/decode in Go following the spec.
   - Add dependency on **go-merklelog** only if the implementation actually needs it; otherwise keep the module dependency-free for grant/leaf logic.
   - Add unit tests: leaf commitment matches test vector; grant round-trip encode/decode.

4. **Add test vector generator script**
   - Create **`tests/scripts/gen_testvectors.py`**: a Python script that generates test vectors (e.g. grant structs, encoded grant bytes, leaf commitment inputs and output) in a format consumable by Go, TypeScript, and Python tests (e.g. JSON under `tests/fixtures/` or per-language fixture files). Script should follow the spec so generated vectors match the Go implementation and the doc examples.
   - Optionally derive or copy at least one known-answer leaf hash from univocity (contract test or script) and feed it into or document it alongside the generated vectors.

5. **Create GitHub repository and push**
   - Create repository **go-univocity** under the **forestrie** organisation on GitHub (empty or with README; prefer empty if initialising locally).
   - Add remote: `git remote add origin https://github.com/forestrie/go-univocity.git` (or SSH equivalent).
   - Push initial branch (e.g. `main`): commit all files, push.

6. **Run gen_testvectors.py and commit fixtures**
   - Run `tests/scripts/gen_testvectors.py` and commit the generated test vectors (e.g. under `tests/fixtures/`) so Go, TypeScript, and Python tests can load them.

7. **Update canopy to respect format changes**
   - In the **canopy** repo (canopy-api and any other consumers of the grant wire format): update the grant codec to match go-univocity (CBOR map keys 0–8, fixed-length LogId/OwnerLogId 32 bytes, GrantFlags 8 bytes, same encoding rules and padding).
   - Point canopy-api grant encode/decode at the go-univocity spec and `tests/fixtures/grant_vectors.json` (and leaf vectors where relevant); add or update tests so canopy’s TypeScript implementation passes the same known-answer vectors.
   - Ensure register-grant API accepts and stores grants in the shared wire format so that grants produced by arbor (queue consumer, grant-sequencing path) and grants produced by canopy are interchangeable and content-addressable under one schema.

8. **Optional: alignment note**
   - Add `docs/alignment.md` (or a section in the main doc) mapping canopy grant fields to univocity PublishGrant + idtimestamp and noting any gaps (e.g. kind vs request code).

## 7. Implementation plan (agent-optimised)

Ordered steps with input, output, location, and verification. No external dependencies; univocity and canopy sources are inputs only.

| Step | Action | Input | Output | Location / hint | Verification |
|------|--------|-------|--------|------------------|--------------|
| **7.1** | Create go-univocity repo and module | — | Go module at repo path | `mkdir -p ~/Dev/personal/forestrie/arbor/services/_deps/go-univocity`; `cd` there; `go mod init github.com/forestrie/go-univocity`. Add `.gitignore`, minimal `README.md` (purpose + link to `docs/`). | `go mod init` succeeds; directory exists. |
| **7.2** | Add docs/ and format spec | Univocity sources (LibLogState.sol, types.sol); canopy grant shape (register-grant API, Plan 0001) | `docs/grant-and-leaf-format.md` (or equivalent) | Create `docs/`. Single spec doc: **leaf commitment** formula (field order, types, endianness; match `_leafCommitment`); **PublishGrant** field list, types, idtimestamp; alignment with univocity and canopy. Include encoding/decoding **examples** in Go, TypeScript, Python (code blocks or runnable snippets). | Spec exists; examples are present in all three languages. |
| **7.3** | Implement Go package | Spec from 7.2 | Go package: leaf commitment + grant encode/decode | Implement in go-univocity per spec. Use go-merklelog only if needed. Export at least leaf commitment (e.g. pre-idtimestamp “inner” for subplan 03) and grant encode/decode. | Unit tests: leaf commitment and grant round-trip pass. |
| **7.4** | Add test vector generator | Spec from 7.2; Go impl from 7.3 | `tests/scripts/gen_testvectors.py`, fixture output | Create `tests/scripts/gen_testvectors.py`. Output: grant inputs, expected CBOR bytes, leaf commitment(s). Format: e.g. JSON under `tests/fixtures/` consumable by Go, TypeScript, Python. Optionally include known-answer leaf hash from univocity. | Script runs; fixtures exist; Go tests load at least one vector. |
| **7.5** | Create GitHub repo and push | Local go-univocity from 7.1–7.4 | Remote at `github.com/forestrie/go-univocity` | Create repo under forestrie (empty or with README). `git remote add origin <url>`; push (e.g. `main`). | Repo exists; push succeeds. |
| **7.6** | Run generator and commit fixtures | gen_testvectors.py from 7.4 | Committed fixtures under `tests/fixtures/` | Run `tests/scripts/gen_testvectors.py`; commit output (e.g. `grant_vectors.json`, leaf vectors). | Fixtures in repo; Go (and optionally TS/Py) tests use them. |
| **7.7** | Align canopy grant codec with spec | go-univocity spec + fixtures; canopy-api grant codec | Canopy grant encode/decode and tests updated | **Canopy repo**: Update grant codec (CBOR keys 0–8, LogId/OwnerLogId 32 bytes, GrantFlags 8 bytes, same padding/encoding as spec). Point tests at `tests/fixtures/grant_vectors.json` (or path where fixtures are mirrored). Register-grant stores shared wire format. | Canopy tests pass against shared vectors; encode/decode byte-for-byte match spec. |
| **7.8** | Optional: alignment note | Canopy grant fields; univocity PublishGrant | `docs/alignment.md` or section in main doc | Map canopy fields ↔ univocity PublishGrant + idtimestamp; document gaps (e.g. kind vs request code). | Doc exists and is linked from main spec. |

**Data flow (concise).** Repo + module (7.1) → spec + examples (7.2) → Go impl (7.3) → test vector script + fixtures (7.4, 7.6) → GitHub (7.5) → canopy codec alignment (7.7). Optional alignment note (7.8) anytime after 7.2.

**Files and repos to create or touch.**

| Where | Path / item |
|-------|-------------|
| **go-univocity** (new repo) | `README.md`, `.gitignore`, `go.mod`, `docs/grant-and-leaf-format.md`, `docs/alignment.md` (optional), Go package(s) (e.g. `leaf.go`, `grant.go`), `tests/scripts/gen_testvectors.py`, `tests/fixtures/*.json` (or equivalent). |
| **Canopy** (existing) | Grant codec: `packages/apps/canopy-api/src/grant/` (or equivalent); tests that load go-univocity fixtures (e.g. from submodule or copied fixtures). Register-grant handler/store use shared wire format. |

**Wire-format test vector content** (what 7.4 / 7.6 must produce): see §8 below. Step 7.4’s output must satisfy the golden grant, minimal grant, fixed-length behaviour, and variable-length field vectors described there.

### 7.9 Implementation status (go-univocity and canopy) — complete

Assessment against the implementation plan (§7). Repo: `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity` (and canopy grant codec). **Subplan 01 is complete and aligned with the latest Plan 0004 design** (inner = ContentHash for grant-sequencing).

| Step | Status | Notes |
|------|--------|--------|
| **7.1** Create go-univocity repo and module | **Done** | Repo at path; go.mod, README, .gitignore present. |
| **7.2** Add docs/ and format spec | **Done** | docs/grant-and-leaf-format.md: leaf formula, PublishGrant, CBOR; Go/TS/Python examples; alignment §5; **ContentHash = inner hash** for grant-sequencing (Plan 0004 subplan 03) stated in §1. |
| **7.3** Implement Go package | **Done** | LeafCommitment, LeafCommitmentFromGrant, **InnerHash**, **InnerHashFromGrant**, Grant, MarshalGrant/UnmarshalGrant. No go-merklelog. |
| **7.4** Add test vector generator | **Done** | gen_testvectors.py → leaf_vectors.json (with **expected_inner_hex**), grant_vectors.json. |
| **7.5** GitHub repo and push | **Done** | Remote forestrie/go-univocity. |
| **7.6** Run generator, commit fixtures | **Done** | Fixtures committed; Go tests load leaf and inner vectors. |
| **7.7** Align canopy grant codec | **Done** | canopy-api grant/codec.ts: keys 0–8, 32/32/8; tests use grant_vectors.json. |
| **7.8** Optional alignment note | **Done** | Inline in spec §5. |

### 7.10 Revisions for revised Plan 0004 design — implemented

Grant-sequencing (subplan 03) enqueues **inner** = 32-byte SHA-256(inner preimage) as ContentHash; ranger computes leafHash = H(idTimestampBE || ContentHash). The following changes are **implemented**:

1. **Spec (docs/grant-and-leaf-format.md)** — §1 now states: for grant-sequencing (Plan 0004 subplan 03), the value enqueued as ContentHash is the **inner hash** = sha256(inner preimage); idtimestamp is assigned by ranger.
2. **go-univocity** — Exported **InnerHash**(logId, grantFlags, maxHeight, minGrowth, ownerLogId, grantData) and **InnerHashFromGrant**(g *Grant) in `grant/leafcommitment.go`. LeafCommitment uses InnerHash internally.
3. **Fixtures** — **expected_inner_hex** added to each entry in leaf_vectors.json; gen_testvectors.py computes and writes it via `inner_hash()`.
4. **Go tests** — TestLeafCommitmentFromFixture asserts InnerHash matches expected_inner_hex when present; **TestInnerHashFromFixture** loads fixtures and asserts InnerHash for each vector.
5. **Canopy** — No change to existing grant codec. When implementing grant-sequencing (subplan 03), canopy computes inner from the spec (formula and TypeScript/Python examples in the doc) or from fixtures.

**Subplan 01 is complete.** Grant-sequencing (subplan 03 step 8.1) can use go-univocity InnerHash/InnerHashFromGrant or the spec and fixtures to obtain and verify the ContentHash for a grant.

## 8. Wire-format test vectors (known-answer tests)

The **fixed-length encoding discipline** for the grant CBOR wire format (LogId and OwnerLogId as fixed-length bstrs of the same size, GrantFlags as fixed-length 8-byte bstr) makes it unambiguous what test vectors **gen_testvectors.py** should generate for known-answer tests. The script should emit at least the following.

- **Golden grant**
  - One grant with all fields set to concrete, reproducible values: version, idtimestamp (8 bytes), logId (wire length per spec, e.g. 32 bytes), ownerLogId (same), grantFlags (8 bytes), maxHeight, minGrowth, grantData, signer, kind.
  - **Expected CBOR bytes** (hex or base64) for that grant, so each implementation can assert decode output and re-encode byte-for-byte against the golden bytes.

- **Minimal grant**
  - A grant with only required fields (no optional maxHeight, minGrowth, exp, nbf).
  - Expected CBOR bytes for that payload.

- **Fixed-length field behaviour**
  - Vectors that exercise the padding rule: e.g. when the semantic value is shorter than the wire length (e.g. 16-byte UUID padded to 32 bytes on wire), one vector with the **padded wire bytes** and the **semantic value** after decode (e.g. left-pad with zeros so wire format is deterministic).
  - Optionally: all-zero fixed-length fields; one non-zero byte in grantFlags at a specific offset.

- **Variable-length fields (grantData, signer)**
  - At least one vector with empty grantData (or minimal, e.g. one byte) and one with a short signer.
  - Optionally: maximum or large grantData/signer sizes if the spec defines limits.

Output format from **gen_testvectors.py** should include, for each vector, the **grant input** (field-by-field), the **expected encoded CBOR bytes**, and optionally the **leaf commitment** so that tests can assert both wire format and leaf hash. Consuming tests (Go, TypeScript, Python) then load these fixtures and verify: decode(golden_cbor) equals expected grant; encode(expected grant) equals golden_cbor.

## 9. Verification

Per-step verification is in the implementation plan table (§7) and status (§7.9–7.10). High-level:

- Spec in `docs/` matches univocity implementation (review against `_leafCommitment` and grant encoding) and references canopy grant shape. **ContentHash = inner hash** for grant-sequencing stated in §1.
- Doc contains encoding/decoding examples in Go, TypeScript, and Python (§7.2).
- **`tests/scripts/gen_testvectors.py`** runs and produces leaf_vectors.json (with expected_leaf_hex and **expected_inner_hex**) and grant_vectors.json; Go tests load and assert both (§7.4, 7.6).
- Go implementation: unit tests pass; LeafCommitment and **InnerHash** match test vectors; grant round-trip passes (§7.3). TestInnerHashFromFixture and TestLeafCommitmentFromFixture verify fixtures.
- Repo exists at `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity` and at `github.com/forestrie/go-univocity` (§7.1, 7.5).
- **Canopy** (§7.7): canopy-api grant codec matches go-univocity wire format; canopy tests pass against shared fixtures.
- Subplans 03 and 05 can consume the spec, **InnerHash**/InnerHashFromGrant (or doc examples), and fixtures for grant-sequencing ContentHash without re-deriving encoding.

## 10. References

- Univocity: `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`, `src/algorithms/lib/LibLogState.sol`, `src/interfaces/types.sol`, `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md`.
- Canopy: [Plan 0001](../plan-0001-register-grant-and-grant-auth-phase.md), [register-grant API](../../api/register-grant.md), [Brainstorm-0001 §3.4](../../brainstorm-0001-x402-checkpoint-grants.md).
