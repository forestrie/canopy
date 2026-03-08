# Grant–statement signer binding: code paths

**Status:** DRAFT  
**Date:** 2026-03-08  
**Related:** [arc-statement-cose-encoding.md](arc-statement-cose-encoding.md), [adr-0001-encoding-one-per-artifact.md](adr-0001-encoding-one-per-artifact.md)

## Purpose

Trace the exact code paths that ensure the **statement signer** (kid in COSE) matches the **grant's signer binding**, so we can verify they use the same 32-byte value and debug "Statement signer does not match the grant's signer binding" (signer_mismatch).

Neither the grant nor the statement is "signed by" an ECDSA key in the perf flow: the grant stores a **32-byte signer binding**, and the API requires that the COSE Sign1 **kid** (key id in the protected header) equals that binding. k6 uses a **placeholder signature**; the API compares kid to grant.signer only.

---

## 1. Grant creation (where the signer is chosen and stored)

### 1.1 Generate grant pool script (`perf/scripts/generate-grant-pool.ts`)

- **Signer source:** One 32-byte value for the whole run:
  ```ts
  const signer = new Uint8Array(randomBytes(32));  // line 57
  ```
- **Grant request body:** For each log ID, the script calls:
  ```ts
  encodeGrantRequest({ logId, ownerLogId, grantFlags, grantData, signer, kind: kindByte })
  ```
  (`@canopy/encoding`: map with int keys 3,4,5,8,**9**,10; key **9 = signer** = 32 bytes as CBOR bstr.)
- **API call:** `POST ${BASE_URL}/logs/${logId}/grants` with body = that CBOR, `Content-Type: application/cbor`, `Authorization: Bearer ${API_TOKEN}`.
- **Grant pool file:** After all grants are created, the script writes:
  ```ts
  const payload = {
    signer: Buffer.from(signer).toString("hex"),  // 64 hex chars, same 32 bytes
    grants: [{ logId, grantLocation }, ...],
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  ```
  So the **same** `signer` Uint8Array is (1) sent in every grant request body as key 9, and (2) written to `grant-pool.json` as a hex string.

### 1.2 API: register-grant (`packages/apps/canopy-api/src/scrapi/register-grant.ts`)

- **Parse body:** `raw = await parseCborBody(request)` → `decodeCbor(new Uint8Array(arrayBuffer))` (cbor-x).
- **Extract signer:** `parseGrantRequest(raw, logId)` (same file) does:
  ```ts
  const signer = toBytes(m.signer ?? m[9]);
  if (!signer || signer.length === 0) return "Missing signer";
  ```
- **toBytes** (`packages/apps/canopy-api/src/unknown-coercion.ts`): returns `Uint8Array` for `Uint8Array` or `ArrayBuffer`; for `number[]` returns `new Uint8Array(v)`. Does **not** handle Node `Buffer`; in Workers the decoded value is typically `Uint8Array` for a CBOR bstr.
- **Stored grant:** The request is turned into a `Grant` (with idtimestamp, etc.) and `encodeGrant(grant)` is written to R2. So the **grant document** in R2 contains the same signer bytes (key 9) that were in the request body.

So at this point the **32-byte signer** is: (A) in the script’s variable, (B) in every grant request body (key 9), (C) in the stored grant in R2 (key 9).

---

## 2. k6 load test (where the statement kid is set)

### 2.1 Load grant pool (`perf/k6/canopy-api/scenarios/write-constant-arrival.js`)

- **Read file:** `grantPool = new SharedArray("grant-pool", function () { ... open("../data/grant-pool.json"); return [JSON.parse(data)]; });`
  - In CI the file was just written by "Generate grant pool" to `perf/k6/canopy-api/data/grant-pool.json`; k6 runs from repo root so the path relative to the bundle resolves to that file.
- **Setup:** `setup()` runs once:
  ```js
  const pool = grantPool[0];
  const signerBytes = signerToBytes(pool.signer);   // pool.signer = 64-char hex string
  ...
  return { ..., signerBytes, logIdToGrant, ... };
  ```
- **signerToBytes** (same file): If `signerStr` is 64 hex chars (`/^[0-9a-fA-F]+$/`):
  ```js
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
  ```
  So the **same** 32 bytes as in the script (first 2 chars → byte 0, next 2 → byte 1, …).

### 2.2 Build COSE and send request

- **Per iteration:** `encodeCoseSign1WithKid(payloadBytes, data.signerBytes)` is called (`perf/k6/canopy-api/lib/cose.js`).
- **encodeCoseSign1WithKid:** Builds COSE Sign1 as 4-element array: protected = bstr containing CBOR map **{ 4: kid }**, unprotected = {}, payload bstr, signature bstr (64 placeholder bytes). So the **kid** in the protected header is exactly `data.signerBytes` (32 bytes).
- **POST:** `postEntryWithGrant(baseUrl, logId, apiToken, coseSign1, grantLocation)` sends `X-Grant-Location: grantLocation` and body = the COSE bytes.

So the **32-byte value** used as kid in the COSE is the one from `grant-pool.json` → `signerToBytes` → `data.signerBytes`, which is intended to be the same as the script’s `signer` (same hex round-trip).

---

## 3. API: register-statement (where the mismatch is reported)

### 3.1 Fetch grant (`packages/apps/canopy-api/src/scrapi/grant-auth.ts` + `register-signed-statement.ts`)

- **Grant location:** From `X-Grant-Location` or `Authorization: Bearer <path>`.
- **Fetch:** `fetchGrant(r2Grants, path)` → R2.get(key) → `decodeGrant(bytes)`.
- **decodeGrant** (`packages/apps/canopy-api/src/grant/codec.ts`): Decodes the stored grant CBOR; signer is:
  ```ts
  const signer = toBytes(m[K.signer]);
  if (!signer || signer.length === 0) throw new Error("Grant missing required field: signer");
  ```
  So **grant.signer** is the 32-byte value stored in the grant (key 9) when it was created.

### 3.2 Extract kid from COSE (`grant-auth.ts`)

- **getSignerFromCoseSign1(coseSign1Bytes):**
  - Decode the COSE array: `arr = decodeCbor(coseSign1Bytes)` → [protectedBstr, unprotected, payloadBstr, signature].
  - Decode the protected header: `protectedMap = decodeCbor(protectedBstr)` → map with e.g. key 4 = kid.
  - `kid = protectedMap.get(4) ?? protectedMap[4]`.
  - If `kid instanceof Uint8Array` return kid; else return null (string kid is not accepted for grant binding).

So **statementSigner** = the value from the COSE protected header under key 4 (the kid).

### 3.3 Compare (`grant-auth.ts` + `register-signed-statement.ts`)

- **register-signed-statement.ts:**  
  `statementSigner = getSignerFromCoseSign1(statementData)`  
  then  
  `if (!signerMatchesGrant(statementSigner, grant.signer)) return GrantAuthErrors.signerMismatch();`
- **signerMatchesGrant(statementSigner, grantSigner):**
  ```ts
  if (!statementSigner || statementSigner.length !== grantSigner.length) return false;
  for (let i = 0; i < grantSigner.length; i++) {
    if (statementSigner[i] !== grantSigner[i]) return false;
  }
  return true;
  ```

So the 403 "Statement signer does not match the grant's signer binding" means this byte-wise comparison failed: **statementSigner** (kid from COSE) ≠ **grant.signer** (signer from stored grant).

---

## 4. Summary: same key?

| Step | Where | 32-byte value |
|------|--------|----------------|
| 1 | Script | `signer = new Uint8Array(randomBytes(32))` |
| 2 | Grant request body | Key 9 = `signer` (via encodeGrantRequest) |
| 3 | API store | Grant in R2 has key 9 = that decoded value |
| 4 | grant-pool.json | `Buffer.from(signer).toString("hex")` (same bytes) |
| 5 | k6 setup | `signerToBytes(pool.signer)` → same 32 bytes |
| 6 | COSE | Protected map { 4: kid } = those 32 bytes |
| 7 | API compare | grant.signer (from R2) vs kid (from COSE) |

In theory the same 32-byte value flows from step 1 through to both sides of the comparison. If signer_mismatch still occurs, possible causes include:

- **Hex/bytes mismatch:** Script writes hex; k6 reads hex. If the script ever wrote a different format (e.g. with spaces or different casing) or k6 parsed it differently, bytes could differ. (Current script uses `Buffer.from(signer).toString("hex")`; k6 uses 64-char hex, 2 chars per byte.)
- **Wrong grant or wrong file:** k6 must use the grant locations and signer from the **same** run that created the grants (same job). If k6 used an old grant-pool.json or a different environment, kid and grant.signer could come from different runs.
- **Decoding differences:** If at any point the signer or kid is decoded as something other than a 32-byte bstr (e.g. string, or truncated), or `toBytes` returns undefined and a fallback path is used, the values could differ. `toBytes` does not handle Node `Buffer`; in Workers, cbor-x typically returns `Uint8Array` for bstr.
- **Log ID / grant mapping:** If k6 used a logId that doesn’t match any grant’s logId (e.g. trimming mismatch: script trims `LOG_IDS`, k6 does not), then `logIdToGrant[logId]` could be undefined and the scenario would skip the request; that would not explain signer_mismatch. If instead the wrong grant were used (e.g. different logId → wrong grantLocation), then grant.signer could be from a different grant that had a different signer—but in the current script **all** grants share the same signer, so that would only matter if there were multiple pools or runs mixed.

---

## 5. Recommended checks

1. **Trim log IDs in k6** so they match the script:  
   `const LOG_IDS = LOG_IDS_RAW ? LOG_IDS_RAW.split(",").map(s => s.trim()).filter(Boolean) : [];`  
   This avoids subtle mismatches when the env string has spaces.
2. **Add a test or one-off assert** that the full chain preserves signer bytes: e.g. create a grant request with a fixed signer, decode it (as the API would), encode and decode a grant, build COSE with the same signer as kid, then assert `signerMatchesGrant(getSignerFromCoseSign1(cose), grant.signer)`.
3. **Logging on mismatch (implemented):** When `!signerMatchesGrant(statementSigner, grant.signer)`, the API logs `[grant-auth] signer_mismatch` with `statementKidHex` and `grantSignerHex` (first 16 bytes of each, plus length). See `register-signed-statement.ts` → `logSignerMismatch`.

---

## 6. Detailed review: key material handling

Review of every touchpoint for inconsistent or incorrect handling of the 32-byte signer/kid.

### 6.1 Script → API (grant request body)

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `generate-grant-pool.ts` | `signer = new Uint8Array(randomBytes(32))`; passed to `encodeGrantRequest` as `signer`. | Single source; correct. |
| `@canopy/encoding` `encodeGrantRequest` | Pushes key 9 and `encodeCborBstr(input.signer)` into map. | No copy; uses input as-is. Correct. |
| `encodeCborBstr` | Encodes length + bytes; supports up to 2^32-1. | 32 bytes always use short form (0x40+len). Correct. |
| `register-grant.ts` `parseGrantRequest` | `signer = toBytes(m.signer ?? m[9])`. | Depends on decoder and toBytes. |
| `cbor-request.ts` | `decodeCbor(new Uint8Array(arrayBuffer))`. | In Workers, cbor-x decodes bstr as Uint8Array. |
| `unknown-coercion.ts` `toBytes` | Returns `v` for `Uint8Array`, `new Uint8Array(v)` for `ArrayBuffer`, `new Uint8Array(v)` for `number[]`. Returns `undefined` otherwise. | **Does not handle Node `Buffer`.** In Workers there is no Buffer; cbor-x returns Uint8Array for bstr. In Node (e.g. tests), Buffer extends Uint8Array so `v instanceof Uint8Array` is true and we return the Buffer. So no bug in current environments. |
| `parseGrantRequest` | `if (!signer \|\| signer.length === 0) return "Missing signer"`. | No explicit length check (e.g. 32). We accept any length; mismatch would then fail at signerMatchesGrant (length check). Acceptable. |

**Verdict:** Grant request path is consistent. Signer is sent as bstr and decoded as Uint8Array in Workers.

### 6.2 API store (grant document in R2)

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `register-grant.ts` | Builds `Grant` with `signer` from parseGrantRequest; `encodeGrant(grant)` → R2.put. | Same reference as request body. |
| `grant/codec.ts` `encodeGrant` | `map[K.signer] = grant.signer`. encodeCbor(map). | cbor-x encodes Uint8Array as bstr. Correct. |
| `fetchGrant` → `decodeGrant` | R2.get → `bytes = new Uint8Array(await obj.arrayBuffer())`; `decodeCbor(bytes)`; `signer = toBytes(m[K.signer])`. | Same decoder and toBytes as request path. Stored value round-trips. |

**Verdict:** Stored grant signer is the same bytes as in the request.

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
| kid type | **Only Uint8Array is returned.** String kid is no longer accepted (removed to avoid UTF-8 encoding mismatch with grant.signer). | Grant binding is defined as 32 raw bytes; accepting string kid could produce different bytes. Now consistent: kid must be bstr. |
| cbor-x decode | In Workers, decodeCbor(protectedBstr) for a bstr value in the map returns Uint8Array. | Correct. |

**Verdict:** kid extraction is consistent with grant binding (bstr only).

### 6.6 Comparison

| Location | What happens | Risk / note |
|----------|----------------|--------------|
| `signerMatchesGrant` | Length must match; then byte-for-byte. | Correct. No view/slice issues: indexing is by element. |
| `register-signed-statement.ts` | On mismatch, calls `logSignerMismatch(statementSigner, grant.signer)` then returns 403. | Logging adds hex prefix (first 16 bytes) and length for both sides. |

**Verdict:** Comparison and logging are correct.

### 6.7 Summary of findings

- **No bug found** that would swap or corrupt the 32-byte value along the intended path.
- **Hardening applied:** `getSignerFromCoseSign1` now returns only Uint8Array (bstr) for kid; string kid no longer UTF-8 encoded, avoiding any ambiguity with grant.signer.
- **Defensive:** k6 log IDs trimmed to match script; signer mismatch logging added for debugging.
- If signer_mismatch still occurs in production, the new logs (statementKidHex, grantSignerHex, len) will show whether lengths differ or bytes differ and in which position.

---

## 7. Triage procedure (when signer_mismatch occurs)

Use this to narrow down why kid ≠ grant.signer at runtime.

### 7.1 Capture the mismatch log

1. **Deploy** the API with the current code (includes `logSignerMismatch` and bstr-only kid).
2. **Run a minimal repro** so at least one POST hits the API and triggers signer_mismatch:
   - **Option A (CI/perf):** Run the "Generate grant pool" job, then the k6 job (e.g. 1 VU, short duration), so the same pool and grants are used.
   - **Option B (local):** From repo root: generate grant pool (script against dev API), then one k6 iteration or a small run against the same API; use `wrangler tail` for the worker to see logs.
3. **Inspect worker logs** for:
   ```
   [grant-auth] signer_mismatch: statement kid vs grant.signer { statementKidHex, grantSignerHex, statementLen, grantSignerLen }
   ```
4. **Interpret:**
   - **Lengths differ** (e.g. statementLen 32, grantSignerLen 0 or 64): wrong type or encoding (e.g. signer stored/decoded as string hex, or truncated). Check decode path and toBytes.
   - **Lengths match, hex prefixes differ:** Bytes differ. Compare first 16 bytes (in the log); if they match the first 16 of grant-pool.json’s signer hex, then kid is correct and grant.signer is wrong (storage/retrieval). If kid hex doesn’t match grant-pool.json, then k6 or COSE encoding is wrong.
   - **Lengths match, hex prefixes identical:** First 16 bytes match; if full 32 matched we wouldn’t log mismatch. So bytes 17–32 differ—inspect next 16 (e.g. add more to log) or compare grant-pool.json full signer to what’s in R2.

### 7.2 Cross-check the four values

To pin the fault to one leg, compare these in the same run:

| # | Value | Where to get it |
|---|--------|------------------|
| 1 | Signer at creation | grant-pool.json `signer` (64 hex chars) after "Generate grant pool". |
| 2 | Signer in k6 | In k6, log `bytesToHex(data.signerBytes)` once in setup (or first request); should equal #1. |
| 3 | Signer in stored grant | Harder: need to read the grant from R2 (e.g. debug endpoint, or R2 dashboard + decode CBOR). Should equal #1. |
| 4 | Kid from COSE | In the API log: `statementKidHex` + length. Should equal #1 (first 16 bytes in log). |

- If #1 = #2 but #4 ≠ #1 → COSE encoding or decoding (k6 → wire → API).
- If #1 = #4 but #3 ≠ #1 → Grant storage or fetch (register-grant or decodeGrant).
- If #2 ≠ #1 → grant-pool.json not from same run, or signerToBytes/parsing issue.

### 7.3 Optional: single-request local repro

1. Run `perf/scripts/generate-grant-pool.ts` against local/dev API; keep grant-pool.json and note one `grantLocation`.
2. In k6 (or a small Node script), load that pool, build one COSE with `encodeCoseSign1WithKid(payload, signerBytes)`, POST to the same API with that grant location.
3. Run the worker locally (`wrangler dev`), send the request, watch console for `[grant-auth] signer_mismatch` and the hex/length. Ensures same machine, same pool, same grant—rules out CI/env-specific issues.
