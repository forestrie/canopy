# Subplan 01: Shared encoding and univocity alignment

**Status**: DRAFT  
**Date**: 2026-03-09  
**Parent**: [Plan 0004 overview](overview.md)

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

- None for this subplan. This subplan is a prerequisite for subplans 03 (ranger leaf append) and 05 (queue consumer).

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
   - Ensure register-grant API accepts and stores grants in the shared wire format so that grants produced by arbor (queue consumer, ranger path) and grants produced by canopy are interchangeable and content-addressable under one schema.

8. **Optional: alignment note**
   - Add `docs/alignment.md` (or a section in the main doc) mapping canopy grant fields to univocity PublishGrant + idtimestamp and noting any gaps (e.g. kind vs request code).

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

- Spec in `docs/` matches univocity implementation (review against `_leafCommitment` and grant encoding) and references canopy grant shape.
- Doc contains encoding/decoding examples in Go, TypeScript, and Python.
- **`tests/scripts/gen_testvectors.py`** runs and produces test vectors that Go, TypeScript, and Python tests can consume; at least one vector is used by the Go unit tests.
- Go implementation: unit tests pass; leaf commitment matches test vector; grant round-trip passes.
- Repo exists at `~/Dev/personal/forestrie/arbor/services/_deps/go-univocity` and at `github.com/forestrie/go-univocity`.
- **Canopy** (step 7): canopy-api grant codec matches go-univocity wire format; canopy tests pass against `grant_vectors.json` (and leaf vectors where used).
- Subplans 03 and 05 can consume the spec and, where applicable, the Go module or the doc examples without re-deriving encoding.

## 10. References

- Univocity: `docs/arc/arc-0016-checkpoint-incentivisation-implementation.md`, `src/algorithms/lib/LibLogState.sol`, `src/interfaces/types.sol`, `docs/plans/plan-0021-phase-zero-log-hierarchy-data-structures.md`.
- Canopy: [Plan 0001](../plan-0001-register-grant-and-grant-auth-phase.md), [register-grant API](../../api/register-grant.md), [Brainstorm-0001 §3.4](../../brainstorm-0001-x402-checkpoint-grants.md).
