/**
 * Register Signed Statement operation for SCRAPI
 * Requires grant-based auth (Plan 0001 Step 5): locate grant → retrieve → authorize (inclusion) → verify signer.
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
    signerMatchesGrant,
    GrantAuthErrors,
} from "./grant-auth";
import type { Grant } from "../grant/types.js";
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
 * Process a statement registration request.
 *
 * Architecture: Plan 0001 Step 5 (grant-based auth); Subplan 08 (receipt-based inclusion when
 * inclusionEnv set); ARC-0001 (grant verification and signer binding). Flow: resolve grant →
 * authorize (inclusion/receipt) → validate request and statement → enforce signer binding → enqueue.
 */
export async function registerSignedStatement(
    request: Request,
    logId: string,
    sequencingQueue: DurableObjectNamespace,
    shardCountStr: string,
    enqueueExtras: Parameters<SequencingQueueStub["enqueue"]>[2] | undefined,
    r2Grants: R2Bucket,
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

        // --- Statement structure and signer binding (ARC-0001 §3) ---
        // COSE Sign1 must have valid shape. Statement signer (e.g. kid in protected header) must
        // match the grant's signer binding; this ties the registered statement to the same key
        // that the grant authorizes. See arc-grant-statement-signer-binding.
        if (!validateCoseSign1Structure(statementData)) {
            return ClientErrors.invalidStatement("Invalid COSE Sign1 structure");
        }

        const statementSigner = getSignerFromCoseSign1(statementData);
        if (!signerMatchesGrant(statementSigner, grant.signer)) {
            logSignerMismatch(statementSigner, grant.signer);
            return GrantAuthErrors.signerMismatch();
        }

        // --- Grant validity window (exp/nbf) ---
        // Optional: reject if grant is expired or not yet valid.
        const now = Math.floor(Date.now() / 1000);
        if (grant.exp !== undefined && now > grant.exp) {
            return GrantAuthErrors.grantInvalid();
        }
        if (grant.nbf !== undefined && now < grant.nbf) {
            return GrantAuthErrors.grantInvalid();
        }

        // --- Enqueue for sequencing (Subplan 03; SCRAPI 2.1.3.2) ---
        // Content hash identifies the statement until sequencing completes. Same DO shard as
        // grant-sequencing (getQueueForLog by logId). Response is 303 See Other to the entry
        // status URL; client polls until sequenced.
        const contentHash = await calculateSHA256(
            statementData.buffer as ArrayBuffer,
        );
        const logIdBytes = uuidToBytes(logId);
        const queue = getQueueForLog(
            { sequencingQueue, shardCountStr },
            logId,
        );
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
