/**
 * Register Signed Statement operation for SCRAPI
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { getContentSize, parseCborBody } from "./cbor-request";
import { seeOtherResponse } from "./cbor-response";

import { ClientErrors, ServerErrors } from "./problem-details";
import { getMaxStatementSize } from "./transparency-configuration";

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
 * Process a statement registration request
 */
export async function registerSignedStatement(
  request: Request,
  logId: string,
  sequencingQueue: DurableObjectNamespace,
): Promise<Response> {
  try {
    const maxSize = getMaxStatementSize();
    const size = getContentSize(request);
    if (typeof size === "number" && size > maxSize) {
      return ClientErrors.payloadTooLarge(size, maxSize);
    }

    // Parse the body dealing with either COSE or CBOR
    let statementData: Uint8Array;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("cose")) {
      // Direct COSE Sign1 data
      const buffer = await request.arrayBuffer();
      statementData = new Uint8Array(buffer);
    } else if (contentType.includes("cbor")) {
      // CBOR-encoded request
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

    // Validate COSE Sign1 structure (basic validation)
    if (!validateCoseSign1Structure(statementData)) {
      return ClientErrors.invalidStatement("Invalid COSE Sign1 structure");
    }

    // Calculate content hash for the operation ID
    const contentHash = await calculateSHA256(
      statementData.buffer as ArrayBuffer,
    );

    // Convert logId (UUID string) to 16-byte ArrayBuffer
    const logIdBytes = uuidToBytes(logId);

    // Enqueue to SequencingQueue DO
    const queueId = sequencingQueue.idFromName("global");
    const queue = sequencingQueue.get(
      queueId,
    ) as unknown as SequencingQueueStub;
    await queue.enqueue(logIdBytes, hexToBytes(contentHash));

    // The SCRAPI pre-sequence identifier is the content hash.
    // This is used as the operation ID until sequencing completes.

    // Derive Location header from request URL
    const requestUrl = new URL(request.url);
    const location = `${requestUrl.origin}${requestUrl.pathname}/${contentHash}`;

    // Return 303 See Other - registration is running (per SCRAPI 2.1.3.2)
    // This is always async for this implementation
    return seeOtherResponse(location, 5); // Suggest retry after 5 seconds
  } catch (error) {
    console.error("Error registering statement:", error);
    return ServerErrors.internal(
      error instanceof Error ? error.message : "Failed to register statement",
    );
  }
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
