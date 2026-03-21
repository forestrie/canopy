# Grant–statement signer binding: code paths

**Status:** DRAFT  
**Date:** 2026-03-19  
**Related:** [ARC-0001 grant verification](arc-0001-grant-verification.md) (**§4** grant transparent-statement signature on register-grant; **§6** register-entry `kid` binding), [arc-statement-cose-encoding.md](arc-statement-cose-encoding.md), [adr-0001-encoding-one-per-artifact.md](adr-0001-encoding-one-per-artifact.md)

## Purpose

Trace the code paths that ensure the **data statement** COSE **`kid`** matches **`statementSignerBindingBytes(grant)`**, and debug **signer_mismatch**.

**Rule ([ARC-0001 §6](arc-0001-grant-verification.md)):** Register-statement auth requires **`isStatementRegistrationGrant(grant)`** (data-log checkpoint path **or** root auth bootstrap shape). The statement-signer binding is **only** **`grantData`** (CBOR key **6**), i.e. what **`PublishGrant`** commits. For **64-byte** ES256 **x||y**, the API compares **`kid`** to the **first 32 bytes**. Wire **v0** has **no** CBOR key **7** (`signer`) or key **8** (`kind`); decoders **reject** them.

**Not in scope here:** cryptographic verification of the **grant transparent statement** on **`POST …/grants`** (**[ARC-0001 §4](arc-0001-grant-verification.md)**).

---

## 1. Where the binding bytes come from (bootstrap + pool)

### 1.1 Generate grant pool (`perf/scripts/generate-grant-pool.ts`)

- Mints via **`POST /api/grants/bootstrap`**; each transparent statement’s **payload** is a Forestrie-Grant **v0** map (keys **1–6**) with **checkpoint public key in `grantData`** (64-byte **x||y** for ES256) and flags matching the auth-bootstrap shape (**`isStatementRegistrationGrant`**).
- **`signerHexFromGrantPayload`** (`perf/lib/grant-completion.ts`) reads CBOR key **6** (`grantData`), derives the binding bytes (**first 32** when length is **64**), and hex-encodes for **`grant-pool.json`** → **`pool.signer`**. That hex is what k6 uses as **`kid`**. (**`pool.signer`** is **pool metadata**, not a wire field.)

### 1.2 `encodeGrantRequest` (@canopy/encoding)

- Emits **only** keys **1–6** (`encode-grant-request.ts`). There is **no** separate **`signer`** bstr on the grant map; **`grantData`** carries the issuer attestation for who may sign statements.

---

## 2. k6 (statement `kid`)

- **`signerToBytes(pool.signer)`** → 32 bytes → **`encodeCoseSign1WithKid`** → protected header **kid** must equal **`statementSignerBindingBytes(decoded_grant)`** (i.e. align with **grantData**).

---

## 3. API: `register-signed-statement.ts`

### 3.1 Grant resolution (Plan 0005)

- **`Authorization: Forestrie-Grant`** → decode transparent statement → **`Grant`**.

### 3.2 Shape and binding

- Reject if **`!isStatementRegistrationGrant(grant)`** (403). (Deprecated alias: **`isPublishCheckpointStatementAuthGrant`**.)
- Reject if **`grantData`** empty (403).
- **`binding = statementSignerBindingBytes(grant)`**; **`statementSigner = getSignerFromCoseSign1(statement)`**; **`signerMatchesGrant(statementSigner, binding)`**.

### 3.3 Mismatch meaning

**signer_mismatch:** **`kid`** ≠ bytes from **`statementSignerBindingBytes(grant)`** (derived from **`grantData`** only).

---

## 4. Summary: byte flow (target)

| Step | Where | Binding bytes |
|------|--------|----------------|
| 1 | Bootstrap mint / grant issuer | **`grantData`** in grant CBOR (key 6) |
| 2 | `grant-pool.json` | `signerHexFromGrantPayload` → hex of **`grantData`** (or **x**) |
| 3 | k6 | `signerToBytes` → COSE **kid** |
| 4 | API | `statementSignerBindingBytes(grant)` == same bytes |

---

## 5. Recommended checks

1. **Trim log IDs in k6** so they match the script:  
   `const LOG_IDS = LOG_IDS_RAW ? LOG_IDS_RAW.split(",").map(s => s.trim()).filter(Boolean) : [];`  
   This avoids subtle mismatches when the env string has spaces.
2. **Add a test or one-off assert** that the full chain preserves bytes: decode grant, `binding = statementSignerBindingBytes(grant)`, build COSE with `kid === binding` (for **64-byte** `grantData`, use **`binding = grantData.subarray(0,32)`** when that is your convention).
3. **Logging on mismatch (implemented):** When comparison fails, the API logs `[grant-auth] signer_mismatch` with **`statementKidHex`** and **`grantSignerHex`** (labels refer to kid vs **effective binding** bytes). See `register-signed-statement.ts` → `logSignerMismatch`.

---

## 6. Detailed review: key material handling

Review of every touchpoint for inconsistent or incorrect handling of the 32-byte signer/kid.

### 6.1 Bootstrap / pool → binding hex

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| Bootstrap API | Transparent-statement **payload** is v0 grant CBOR (**keys 1–6**); **`grantData`** holds the checkpoint key material the issuer attests. | Keys **7**/**8** rejected by **`decodeGrantPayload`**. |
| `signerHexFromGrantPayload` | Reads map key **6**; binding = first 32 bytes when **`grantData`** length is 64. | Must match **`statementSignerBindingBytes`** in API. |

**Verdict:** k6 **`kid`** must equal this binding; no separate wire **`signer`** field.

### 6.2 API (register-grant, no R2 grant store)

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `register-grant.ts` | Decodes **Authorization: Forestrie-Grant** → **`Grant`**; enqueues commitment for sequencing (**Plan 0008**: no server-side grant object storage). | Caller completes the transparent statement with **`idtimestamp`** + receipt via status / resolve-receipt. |
| `grant/codec.ts` | **`decodeGrantPayload`** rejects keys **7** and **8**. | Same v0 map **1–6** as commitment preimage inputs. |

**Verdict:** Statement-signer binding is **`grantData`** in the grant payload the client carries (Forestrie-Grant), not a second wire **`signer`** field.

### 6.3 Script → grant-pool.json → k6

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `generate-grant-pool.ts` | `Buffer.from(signer).toString("hex")`. | Node: copies 32 bytes, outputs 64 lowercase hex chars. Correct. |
| k6 `signerToBytes` | Requires `s.length === 64 && /^[0-9a-fA-F]+$/.test(s)`. Parses 2 chars per byte. | Same byte order as script. Accepts both cases; correct. |
| k6 fallback | If not 64 hex, tries base64. | Script never writes base64. No impact for current flow. |

**Verdict:** Hex round-trip script → JSON → k6 is consistent.

### 6.4 k6 → COSE

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `write-constant-arrival.js` | `data.signerBytes` from setup; passed to `encodeCoseSign1WithKid(payloadBytes, data.signerBytes)`. | Same 32 bytes for all VUs. |
| `cose.js` `encodeCoseSign1WithKid` | `encodeCborMapWithBstrValue(COSE_KID, kid)` → map { 4: bstr(kid) }; protectedBstr = encodeBstr(protectedMap). | kid encoded as bstr; full 32 bytes. |
| `cbor.js` `encodeBstr` | `encodeBstrHeader(bytes.length)` + bytes. | For length 32 uses 0x40+32 = 0x60. Correct. |

**Verdict:** COSE protected header contains the same 32 bytes as signerBytes.

### 6.5 API: COSE → kid extraction

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `grant-auth.ts` `getSignerFromCoseSign1` | Decode COSE array; decode arr[0] (protected bstr) to map; kid = map[4]. | If decoded protected is wrong type, we return null. |
| kid type | **Only Uint8Array is returned.** String kid is not accepted (avoids UTF-8 ambiguity vs raw binding bytes). | Binding is raw bytes from **`grantData`** (or first 32 of **x||y**). |
| cbor-x decode | In Workers, decodeCbor(protectedBstr) for a bstr value in the map returns Uint8Array. | Correct. |

**Verdict:** kid extraction is consistent with grant binding (bstr only).

### 6.6 Comparison

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `signerMatchesGrant` | Length must match; then byte-for-byte. | Correct. No view/slice issues: indexing is by element. |
| `register-signed-statement.ts` | On mismatch, calls `logSignerMismatch(statementSigner, binding)` then returns 403. | Logging adds hex prefix (first 16 bytes) and length for both sides (`binding` = **grantData** rule). |

**Verdict:** Comparison and logging are correct.

### 6.7 Summary of findings

- **No bug found** that would swap or corrupt the 32-byte value along the intended path.
- **Hardening applied:** `getSignerFromCoseSign1` returns only Uint8Array (bstr) for kid.
- **Defensive:** k6 log IDs trimmed to match script; signer mismatch logging added for debugging.
- If signer_mismatch still occurs in production, the new logs (statementKidHex, grantSignerHex, len) will show whether lengths differ or bytes differ and in which position.

---

## 7. Triage procedure (when signer_mismatch occurs)

Use this to narrow down why **kid** ≠ **`statementSignerBindingBytes(grant)`** at runtime.

### 7.1 Capture the mismatch log

1. **Deploy** the API with the current code (includes `logSignerMismatch` and bstr-only kid).
2. **Run a minimal repro** so at least one POST hits the API and triggers signer_mismatch:
   - **Option A (CI/perf):** Run the "Generate grant pool" job, then the k6 job (e.g. 1 VU, short duration), so the same pool and grants are used.
   - **Option B (local):** From repo root: generate grant pool (script against dev API), then one k6 iteration or a small run against the same API; use `wrangler tail` for the worker to see logs.
3. **Inspect worker logs** for:
   ```
   [grant-auth] signer_mismatch: statement kid vs grant binding (grantData rule) { statementKidHex, grantSignerHex, statementLen, grantSignerLen }
   ```
4. **Interpret:**
   - **Lengths differ** (e.g. statementLen 32, grantSignerLen 0 or 64): wrong type or encoding (e.g. signer stored/decoded as string hex, or truncated). Check decode path and toBytes.
   - **Lengths match, hex prefixes differ:** Bytes differ. Compare first 16 bytes (in the log); if they match the first 16 of grant-pool.json’s **grantData** hex (committed signer binding), then kid is correct and **grantData** in the wire grant is wrong (storage/retrieval). If kid hex doesn’t match grant-pool.json, then k6 or COSE encoding is wrong.
   - **Lengths match, hex prefixes identical:** First 16 bytes match; if full 32 matched we wouldn’t log mismatch. So bytes 17–32 differ—inspect next 16 (e.g. add more to log) or compare grant-pool.json full signer to what’s in R2.

### 7.2 Cross-check the four values

To pin the fault to one leg, compare these in the same run:

| # | Value | Where to get it |
|---|--------|------------------|
| 1 | Signer at creation | grant-pool.json `signer` (64 hex chars) after "Generate grant pool". |
| 2 | Signer in k6 | In k6, log `bytesToHex(data.signerBytes)` once in setup (or first request); should equal #1. |
| 3 | Signer in persisted grant bytes | Decode the same Forestrie-Grant payload the client used (or pool **`grantBase64`**). Should equal #1. |
| 4 | Kid from COSE | In the API log: `statementKidHex` + length. Should equal #1 (first 16 bytes in log). |

- If #1 = #2 but #4 ≠ #1 → COSE encoding or decoding (k6 → wire → API).
- If #1 = #4 but #3 ≠ #1 → Wrong or stale grant bytes in the client/pool vs what the API decoded.
- If #2 ≠ #1 → grant-pool.json not from same run, or signerToBytes/parsing issue.

### 7.3 Where to find triage data after a run

- **Grant-pool signer (#1 and #2):** In the Performance Tests workflow run, open the job and find the "Run k6 performance test" step. In the log, search for `[triage] grant-pool signer (64 hex):` — that is the signer used at creation and by k6. You can also download the **grant-pool-&lt;env&gt;** artifact (e.g. `grant-pool-dev`) and read the `signer` field from the JSON.
- **Worker mismatch log (#4):** In Cloudflare Dashboard → Workers & Pages → select the canopy-api worker → Logs (Real-time or Logpush). Filter or search for `[grant-auth] signer_mismatch` to see `statementKidHex`, `grantSignerHex`, `statementLen`, `grantSignerLen` for each 403. Compare the first 32 hex chars of `statementKidHex` to the first 32 chars of the grant-pool signer; compare `grantSignerHex` to the grant-pool signer to see if the stored grant matches.

### 7.4 Optional: single-request local repro

1. Run `perf/scripts/generate-grant-pool.ts` against local/dev API; keep grant-pool.json and one completed **`grantBase64`**.
2. In k6 (or a small Node script), load that pool, build one COSE with `encodeCoseSign1WithKid(payload, signerBytes)`, POST to the same API with **Authorization: Forestrie-Grant** carrying that base64.
3. Run the worker locally (`wrangler dev`), send the request, watch console for `[grant-auth] signer_mismatch` and the hex/length. Ensures same machine, same pool, same grant—rules out CI/env-specific issues.
