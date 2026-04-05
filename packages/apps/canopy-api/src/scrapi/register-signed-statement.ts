/**
 * Statement registration — **`POST /register/entries`**.
 *
 * **Flow:** The client sends the signed statement (COSE Sign1 body) and
 * **`Authorization: Forestrie-Grant`** holding a **transparent statement** (embedded grant,
 * idtimestamp, receipt). The target transparency log is **`T = grant.logId`**. The handler
 * resolves and authorizes the grant, checks that it **allows statement registration** on **`T`**,
 * checks **`kid`** against **`grantData`**, verifies **Forestrie-Grant** and **statement** COSE Sign1
 * (for **64-byte x‖y** `grantData`), enqueues on **`T`**’s shard, and returns **303** to the entry
 * status URL.
 *
 * **Versus {@link registerGrant}:** This path does **not** mint or bootstrap grants; it only
 * appends **statements** to **`T`** using an already-supplied grant artifact.
 *
 * **`O` and `T`:** `ownerLogId` is **`O`**, `logId` is **`T`**. Receipts witness inclusion of this
 * **grant leaf** in the transparency log that **sequenced** the grant — **`O`**. Statements are
 * sequenced on **`T`** (this handler) while {@link registerGrant} enqueues grant leaves on **`O`**.
 * **GF_DATA_LOG** statement grants require **`O ≠ T`** (see in-body check). The **first** statement
 * on an empty **`T`** is allowed once auth succeeds; **`T`** need not already contain entries.
 *
 * ## Caveats — trust model vs hierarchical fields
 *
 * **Hierarchical grant fields** (`ownerLogId` **`O`**, target **`T`**, flags) describe *who may govern whom*
 * in the intended model. **They are not, by themselves, a verified chain of signatures back to the
 * bootstrap signer.** This handler checks policy bits and `O ≠ T` for data-log statement grants; it does
 * **not** recurse parent grants or prove that **`grantData`** was issued under bootstrap-root authority.
 *
 * **What cryptographic binding is enforced (64-byte `grantData` path):** the **outer** Forestrie-Grant
 * COSE Sign1 and the **statement** COSE Sign1 must verify under the ES256 public key **x‖y** in
 * **`grantData`**,
 * and the statement **`kid`** must match the {@link statementSignerBindingBytes} / Custodian-16 profile.
 * That proves **internal consistency** of the artifacts the client supplied — not that the key is **authorised**
 * by your trust root.
 *
 * **Grant authorization (receipt MMR + owner-queue inclusion):** For **`POST /register/entries`**, the
 * production worker passes `inclusionEnv` whenever **`SEQUENCING_QUEUE`** is bound (see [`index.ts`](../index.ts));
 * deployed canopy-api configs include that binding, so **successful** statement registration **always**
 * runs {@link grantAuthorize} alongside enqueue — not something clients opt into or out of on the wire.
 * That path verifies **MMR inclusion** of the grant leaf against the receipt’s proof/peak
 * (`verifyReceiptInclusionFromParsed` — **no** receipt COSE Sign1 verification here) and that the grant
 * commitment appears on **`O`**’s sequencing shard (`resolveContent`). It is still **not** the aspirational
 * univocal-checkpoint / receipt-signer / **AUTH** semantics model.
 *
 * **Maintainers:** the optional `inclusionEnv` parameter exists so this module can be called directly from
 * **unit tests** without Durable Object bindings (e.g. [`wrangler.test.jsonc`](../../wrangler.test.jsonc)
 * omits **`SEQUENCING_QUEUE`**). That is **not** part of the public HTTP interface. Code does **not** gate
 * omission on `NODE_ENV === "test"` — only on the caller passing env; a deploy **without** the queue binding
 * would skip inclusion in `grantAuthorize` until the handler returns **503** (“sequencing not configured”)
 * after other checks — operations should treat **`SEQUENCING_QUEUE`** as mandatory for real service.
 *
 * **Summary:** production behaviour is *matching signers + grantAuthorize when the worker has a queue* — still
 * **not** *enforced chain to bootstrap* nor *univocally anchored inclusion under one checkpoint key*.
 */

import {
  QueueFullError,
  type SequencingQueueStub,
} from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { getContentSize, parseCborBody } from "./cbor-request";
import { seeOtherResponse } from "./cbor-response";

import { verifyCoseSign1 } from "@canopy/encoding";
import { grantDataToBytes } from "../grant/grant-data.js";
import {
  getSignerFromCoseSign1,
  GrantAuthErrors,
  signerMatchesStatementRegistrationGrant,
} from "./grant-auth";
import {
  importEs256PublicKeyFromGrantDataXy64,
  verifyCustodianEs256GrantSign1WithGrantDataXy,
} from "./custodian-grant.js";
import { isDataLogStatementGrantFlags } from "../grant/grant-flags.js";
import {
  isStatementRegistrationGrant,
  statementSignerBindingBytes,
} from "../grant/statement-signer-binding.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  getGrantFromRequest,
  grantAuthorize,
  type AuthGrantAuthorizeEnv,
} from "./auth-grant.js";
import { ClientErrors, ServerErrors } from "./problem-details";
import { getMaxStatementSize } from "./transparency-configuration";
import type { InclusionEnv } from "./verify-grant-inclusion.js";

export type InclusionVerificationEnv = InclusionEnv;

/**
 * Statement Registration Request
 */
export interface RegisterStatementRequest {
  /** The signed statement to register (COSE Sign1) */
  signedStatement: Uint8Array;
}

/**
 * Statement Registration Response
 */
export interface RegisterStatementResponse {
  /** Operation ID for tracking the registration */
  operationId: string;
  /** Status of the registration */
  status: "accepted" | "pending";
}

/**
 * Registers one signed statement; **`grant.logId`** is always the target log **`T`**.
 *
 * @see File-level comment for full flow, **`O` vs `T`**, and caveats.
 */
export async function registerSignedStatement(
  request: Request,
  sequencingQueue: DurableObjectNamespace,
  shardCountStr: string,
  enqueueExtras: Parameters<SequencingQueueStub["enqueue"]>[2] | undefined,
  inclusionEnv?: InclusionEnv,
): Promise<Response> {
  try {
    // --- Grant resolution (Plan 0005: Authorization: Forestrie-Grant only) ---
    const authEnv: AuthGrantAuthorizeEnv = { inclusionEnv };
    const grantResult = getGrantFromRequest(request);
    if (grantResult instanceof Response) return grantResult;
    const { grant } = grantResult;

    let statementTargetLogUuid: string;
    try {
      statementTargetLogUuid = bytesToUuid(grant.logId);
    } catch {
      return ClientErrors.badRequest("Invalid logId in grant");
    }

    const grantDataBytes = grantDataToBytes(grant.grantData);
    if (grantDataBytes.length !== 64) {
      return ClientErrors.forbidden(
        "Forestrie-Grant verification requires 64-byte ES256 grantData (public key x||y).",
      );
    }
    const forestrieOk = await verifyCustodianEs256GrantSign1WithGrantDataXy(
      grantResult.bytes,
      grantDataBytes,
      { logFailures: true, logPrefix: "register-statement-forestrie-grant" },
    );
    if (!forestrieOk) {
      return ClientErrors.forbidden(
        "Forestrie-Grant COSE signature verification failed.",
      );
    }

    // --- Grant authorization — receipt-based inclusion only (no bootstrap path) ---
    // Same primitive as register-grant’s “initialized log” branch: proves the Forestrie-Grant is
    // already sequenced into a transparency log so header 396 verifies. Receipt from artifact only
    // (Plan 0005); no X-Grant-Receipt-Location or server-built receipt.
    const authError = await grantAuthorize(grantResult, authEnv);
    if (authError) return authError;

    // --- Request and body validation ---
    // Enforce max statement size; accept application/cose (raw COSE Sign1) or application/cbor
    // (wrapper with signedStatement). Reject unsupported media type.
    const maxSize = getMaxStatementSize();
    const size = getContentSize(request);
    if (typeof size === "number" && size > maxSize) {
      return ClientErrors.payloadTooLarge(size, maxSize);
    }

    let statementData: Uint8Array;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("cose")) {
      const buffer = await request.arrayBuffer();
      statementData = new Uint8Array(buffer);
    } else if (contentType.includes("cbor")) {
      try {
        const body = await parseCborBody<RegisterStatementRequest>(request);
        statementData = body.signedStatement;
      } catch (error) {
        return ClientErrors.invalidStatement(
          `Failed to parse CBOR body: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    } else {
      return ClientErrors.unsupportedMediaType(contentType);
    }

    // --- Statement structure and signer binding (ARC-0001 §6) ---
    if (!isStatementRegistrationGrant(grant)) {
      return ClientErrors.forbidden(
        "Grant must authorize statement registration (data-log flags + extend, or auth-log bootstrap with create|extend).",
      );
    }

    if (
      isDataLogStatementGrantFlags(grant.grant) &&
      logIdBytesEqual(grant.ownerLogId as Uint8Array, grant.logId as Uint8Array)
    ) {
      return ClientErrors.forbidden(
        "Data-log statement-registration grant must use a distinct ownerLogId (governing AUTH log); ownerLogId must not equal logId.",
      );
    }

    if (!validateCoseSign1Structure(statementData)) {
      return ClientErrors.invalidStatement("Invalid COSE Sign1 structure");
    }

    const statementSigner = getSignerFromCoseSign1(statementData);
    const grantSignerBinding = statementSignerBindingBytes(grant);
    if (grantSignerBinding.length === 0) {
      return ClientErrors.forbidden(
        "Grant grantData must carry the statement signer binding (non-empty).",
      );
    }
    if (!signerMatchesStatementRegistrationGrant(statementSigner, grant)) {
      logSignerMismatch(statementSigner, grantSignerBinding);
      return GrantAuthErrors.signerMismatch();
    }

    let statementVerifyKey: CryptoKey;
    try {
      statementVerifyKey =
        await importEs256PublicKeyFromGrantDataXy64(grantDataBytes);
    } catch {
      return ClientErrors.forbidden(
        "Grant grantData is not valid ES256 x||y for statement signature verification.",
      );
    }
    const statementSigOk = await verifyCoseSign1(
      statementData,
      statementVerifyKey,
      { logFailures: true, logPrefix: "register-statement-payload" },
    );
    if (!statementSigOk) {
      return ClientErrors.invalidStatement(
        "Statement COSE signature verification failed.",
      );
    }

    if (!sequencingQueue) {
      return ServerErrors.serviceUnavailable(
        "Statement sequencing not configured (SEQUENCING_QUEUE required)",
      );
    }

    // --- Enqueue for sequencing (Subplan 03; SCRAPI 2.1.3.2) ---
    // Shard by target T = grant.logId (contrast: register-grant shards by owner O). Content hash
    // identifies the statement until sequencing completes. Response is 303 See Other to the entry
    // status URL; client polls until sequenced.
    const contentHash = await calculateSHA256(
      statementData.buffer as ArrayBuffer,
    );
    const logIdBytes = uuidToBytes(statementTargetLogUuid);
    const queue = getQueueForLog(
      { sequencingQueue, shardCountStr },
      statementTargetLogUuid,
    );
    await queue.enqueue(logIdBytes, hexToBytes(contentHash), enqueueExtras);

    const requestUrl = new URL(request.url);
    const location = `${requestUrl.origin}/logs/${statementTargetLogUuid}/entries/${contentHash}`;

    console.log("Statement registration accepted", {
      logId: statementTargetLogUuid,
      contentHash,
    });
    return seeOtherResponse(location, 5);
  } catch (error) {
    // Queue backpressure: return 503 with Retry-After so clients can back off (DO best practice).
    if (error instanceof QueueFullError) {
      console.warn("Queue full, returning 503:", {
        pendingCount: error.pendingCount,
        maxPending: error.maxPending,
        retryAfter: error.retryAfterSeconds,
      });
      return ServerErrors.serviceUnavailableWithRetry(
        `Queue capacity exceeded (${error.pendingCount}/${error.maxPending} pending)`,
        error.retryAfterSeconds,
      );
    }

    console.error("Error registering statement:", error);
    return ServerErrors.internal(
      error instanceof Error ? error.message : "Failed to register statement",
    );
  }
}

function logIdBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Log signer mismatch (grant auth). */
function logSignerMismatch(
  statementSigner: Uint8Array | null,
  grantSigner: Uint8Array,
): void {
  console.warn("[grant-auth] signer_mismatch", {
    statementKidLen: statementSigner?.length ?? 0,
    grantSignerLen: grantSigner.length,
  });
}

/**
 * Basic validation of COSE Sign1 structure
 */
function validateCoseSign1Structure(data: Uint8Array): boolean {
  // COSE Sign1 is a CBOR array with 4 elements
  // This is a basic check - full validation would decode and verify

  if (data.length < 10) return false; // Too small to be valid

  // Check for CBOR array marker (0x84 = array of 4 elements)
  // or 0x98 followed by 0x04 for indefinite-length array
  const firstByte = data[0];
  if (firstByte !== 0x84 && firstByte !== 0x98) {
    return false;
  }

  return true;
}

/**
 * Calculate SHA256 hash of content
 */
async function calculateSHA256(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert UUID string to 16-byte ArrayBuffer
 */
function uuidToBytes(uuid: string): ArrayBuffer {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

/**
 * Convert hex string to ArrayBuffer
 */
function hexToBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}
