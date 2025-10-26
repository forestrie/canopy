/**
 * Register Signed Statement operation for SCRAPI
 */

import type { R2Bucket } from '@cloudflare/workers-types';
import { getLowerBoundMMRIndex } from './mmr-mock';
import { storeLeaf } from '../cf/r2';
import { CBOR_CONTENT_TYPES } from './cbor-content-types';
import { seeOtherResponse } from './cbor-response';
import { parseCborBody, getContentSize } from './cbor-request';

import { ClientErrors, ServerErrors } from './problem-details';
import { getMaxStatementSize } from './transparency-configuration';

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
  status: 'accepted' | 'pending';
}

/**
 * Process a statement registration request
 */
export async function registerSignedStatement(
  request: Request,
  logId: string,
  r2Bucket: R2Bucket
): Promise<Response> {
  try {

    const maxSize = getMaxStatementSize();
    const size = getContentSize(request);
    if (typeof size === 'number' && size > maxSize) {
      return ClientErrors.payloadTooLarge(size, maxSize);
    }

    // Parse the body dealing with either COSE or CBOR
    let statementData: Uint8Array;
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('cose')) {
      // Direct COSE Sign1 data
      const buffer = await request.arrayBuffer();
      statementData = new Uint8Array(buffer);
    } else if (contentType.includes('cbor')) {
      // CBOR-encoded request
      try {
        const body = await parseCborBody<RegisterStatementRequest>(request);
        statementData = body.signedStatement;
      } catch (error) {
        return ClientErrors.invalidStatement(
          `Failed to parse CBOR body: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    } else {
      return ClientErrors.unsupportedMediaType(contentType);
    }

    // Validate COSE Sign1 structure (basic validation)
    if (!validateCoseSign1Structure(statementData)) {
      return ClientErrors.invalidStatement('Invalid COSE Sign1 structure');
    }

    // Get the fence MMR index
    const fenceIndex = await getLowerBoundMMRIndex(logId);

    // Store leaf in R2
    const { etag } = await storeLeaf(
      r2Bucket,
      logId,
      fenceIndex,
      statementData.buffer as ArrayBuffer,
      CBOR_CONTENT_TYPES.COSE_SIGN1
    );

    // Generate operation ID
    const fenceIndexPadded = fenceIndex.toString().padStart(8, '0');

    // Derive Location header from request URL
    const requestUrl = new URL(request.url);
    const location = `${requestUrl.origin}${requestUrl.pathname}/${fenceIndexPadded}/${etag}`;

    // Return 303 See Other - registration is running (per SCRAPI 2.1.3.2)
    // This is always async for this implementation
    return seeOtherResponse(location, 5); // Suggest retry after 5 seconds

  } catch (error) {
    console.error('Error registering statement:', error);

    if (error instanceof Error) {
      if (error.message.includes('R2')) {
        return ServerErrors.storageError(error.message, 'store');
      }
    }

    return ServerErrors.internal(
      error instanceof Error ? error.message : 'Failed to register statement'
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
