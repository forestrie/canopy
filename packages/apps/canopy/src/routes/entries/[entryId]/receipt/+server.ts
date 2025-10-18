/**
 * SCITT Receipt Generation Endpoint
 * GET /entries/{entryId}/receipt
 */

import type { RequestHandler } from './$types';
import type { R2Object } from '@cloudflare/workers-types';
import { cborResponse } from '$lib/scrapi/cborresponse';
import { ClientErrors, ServerErrors } from '$lib/scrapi/problem-details';
import { validateEntryId } from '$lib/scrapi/validation';
import { CBOR_CONTENT_TYPES } from '$lib/scrapi/cbor-content-types';
import type { SCITTReceipt } from '$lib/scrapi/resolve-receipt';
import { encode } from 'cbor-x';

/**
 * GET /entries/{entryId}/receipt
 * Generate a receipt for a specific entry
 */
export const GET: RequestHandler = async ({ params, platform }) => {
  if (!platform?.env?.R2) {
    return ServerErrors.serviceUnavailable('Platform services not available');
  }

  const { entryId } = params;

  // Validate entry ID
  const entryIdError = validateEntryId(entryId);
  if (entryIdError) return entryIdError;

  // Use configured log ID
  const logId = platform.env.CANOPY_ID || 'default-log';

  try {
    // Find the entry in R2
    const prefix = `logs/${logId}/leaves/`;
    const list = await platform.env.R2.list({
      prefix,
      limit: 1000
    });

    // Find the entry
    let foundObject: R2Object | undefined;
    let fenceIndex = 0;

    for (const obj of list.objects) {
      const pathParts = obj.key.split('/');
      const hash = pathParts[pathParts.length - 1];

      if (hash === entryId || obj.etag?.replace(/"/g, '') === entryId) {
        foundObject = obj;
        fenceIndex = parseInt(pathParts[pathParts.length - 2], 10);
        break;
      }
    }

    if (!foundObject) {
      return ClientErrors.notFound('entry', `Entry ${entryId} not found`);
    }

    // Get metadata from the object
    const object = await platform.env.R2.get(foundObject.key);
    if (!object) {
      return ClientErrors.notFound('entry', `Entry ${entryId} not found`);
    }

    // Check if entry is sequenced
    const isSequenced = object.customMetadata?.sequenced === 'true';
    const mmrIndex = object.customMetadata?.mmrIndex ?
      parseInt(object.customMetadata.mmrIndex, 10) : 0;

    if (!isSequenced) {
      // Entry not yet sequenced - return pending status
      return ClientErrors.conflict('Entry not yet sequenced. Receipt not available');
    }

    // Generate mock receipt (in production, this would involve actual cryptographic proofs)
    const receipt = generateMockReceipt(
      logId,
      entryId,
      fenceIndex,
      mmrIndex,
      foundObject.uploaded?.getTime() || Date.now()
    );

    // Return CBOR-encoded receipt
    return cborResponse(
      receipt,
      200,
      CBOR_CONTENT_TYPES.SCITT_RECEIPT
    );

  } catch (error) {
    console.error('Error generating receipt:', error);
    return ServerErrors.internal(
      error instanceof Error ? error.message : 'Failed to generate receipt'
    );
  }
};

/**
 * Generate a mock receipt for testing
 * In production, this would generate actual Merkle proofs
 */
function generateMockReceipt(
  logId: string,
  entryId: string,
  fenceIndex: number,
  mmrIndex: number,
  timestamp: number
): SCITTReceipt {
  // Generate mock Merkle proof
  const mockProof = {
    version: 1,
    leafIndex: mmrIndex,
    treeSize: mmrIndex + 100, // Mock tree size
    hashes: [
      // Mock sibling hashes for Merkle path
      crypto.getRandomValues(new Uint8Array(32)),
      crypto.getRandomValues(new Uint8Array(32)),
      crypto.getRandomValues(new Uint8Array(32))
    ]
  };

  // Encode proof as CBOR
  const proofData = encode(mockProof);

  // Generate mock signature
  const mockSignature = crypto.getRandomValues(new Uint8Array(64));

  const receipt: SCITTReceipt = {
    version: 1,
    logId,
    entryId,
    fenceIndex,
    mmrIndex,
    timestamp,
    proof: {
      type: 'merkle-inclusion',
      data: new Uint8Array(proofData)
    },
    signature: mockSignature
  };

  return receipt;
}
