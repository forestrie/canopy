/**
 * Statement registration (POST /logs/{logId}/entries). Registers a signed statement in the
 * transparency log for the given logId. Grant-based auth and optional receipt-based inclusion.
 */

import {
  QueueFullError,
  type SequencingQueueStub,
} from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { getContentSize, parseCborBody } from "./cbor-request";
import { seeOtherResponse } from "./cbor-response";

import {
  getSignerFromCoseSign1,
  GrantAuthErrors,
  signerMatchesStatementRegistrationGrant,
} from "./grant-auth";
import {
  isStatementRegistrationGrant,
  statementSignerBindingBytes,
} from "../grant/statement-signer-binding.js";
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
 * Handles POST /logs/{logId}/entries. Registers the submitted signed statement (COSE Sign1)
 * so it will be appended as a leaf to the log. The statement is identified by the hash of
 * its bytes until sequencing completes; the client polls the returned status URL then
 * obtains the permanent entry ID and receipt from query-registration-status and resolve-receipt.
 *
 * Auth: the grant is taken from the request only (Authorization: Forestrie-Grant <base64>
 * transparent statement). No fetch by URL. The grant’s receipt, when present in the
 * statement, is used for inclusion verification when inclusionEnv is set.
 *
 * Parameters:
 * - request: body is the statement (application/cose raw COSE Sign1 or application/cbor
 *   with { signedStatement }) and must include Authorization: Forestrie-Grant.
 * - logId: target log from the URL.
 * - sequencingQueue, shardCountStr: DO namespace and shard count for the sequencing queue
 *   (same sharding as grant-sequencing; getQueueForLog by logId).
 * - enqueueExtras: optional extra payload for the DO enqueue call.
 * - inclusionEnv: when set, grantAuthorize requires the grant to have a valid receipt
 *   proving inclusion in the authority log; otherwise registration is rejected (403).
 *
 * Validation: grant must be present and valid; if inclusionEnv set, inclusion is checked.
 * Statement must be valid COSE Sign1; the grant must be a **data-log** statement grant
 * (bitmap: GF_DATA_LOG + GF_EXTEND per `isStatementRegistrationGrant`) and **`kid`** must match
 * **`statementSignerBindingBytes(grant)`** or Custodian 16-byte kid for 64-byte **x||y**
 * `grantData` (bootstrap Sign1). Wire v0 has no
 * separate signer/kind CBOR keys.
 * On success, enqueues (logId, contentHash) and returns 303 to the status URL for polling.
 * On queue backpressure returns 503 with Retry-After.
 *
 * Agent References: Plan 0001 Step 5 (grant-based auth); Plan 0004 Subplan 08 (receipt-based
 * inclusion when inclusionEnv set); ARC-0001 (grant verification, signer binding);
 * Plan 0005 (grant from Forestrie-Grant only, receipt from artifact).
 */
export async function registerSignedStatement(
  request: Request,
  logId: string,
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

    // --- Grant authorization — receipt-based inclusion (Subplan 08, ARC-0001) ---
    // Receipt from artifact only (Plan 0005); no X-Grant-Receipt-Location or server-built receipt.
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

    if (!sequencingQueue) {
      return ServerErrors.serviceUnavailable(
        "Statement sequencing not configured (SEQUENCING_QUEUE required)",
      );
    }

    // --- Enqueue for sequencing (Subplan 03; SCRAPI 2.1.3.2) ---
    // Content hash identifies the statement until sequencing completes. Same DO shard as
    // grant-sequencing (getQueueForLog by logId). Response is 303 See Other to the entry
    // status URL; client polls until sequenced.
    const contentHash = await calculateSHA256(
      statementData.buffer as ArrayBuffer,
    );
    const logIdBytes = uuidToBytes(logId);
    const queue = getQueueForLog({ sequencingQueue, shardCountStr }, logId);
    await queue.enqueue(logIdBytes, hexToBytes(contentHash), enqueueExtras);

    const requestUrl = new URL(request.url);
    const location = `${requestUrl.origin}${requestUrl.pathname}/${contentHash}`;

    console.log("Statement registration accepted", {
      logId,
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
