/**
 * SCITT SCRAPI Entry Registration Endpoint
 * POST /entries - Register a new signed statement
 */

import { ServerErrors } from '$lib/scrapi/problem-details';
import { registerSignedStatement } from '$lib/scrapi/register-signed-statement';
import { CBOR_CONTENT_TYPES } from '$lib/scrapi/cbor-content-types';
import { validateScrapiRequest } from '$lib/scrapi/validation';
import type { RequestHandler } from './$types';

/**
 * POST /entries
 * Submit a new signed statement to the transparency log
 */
export const POST: RequestHandler = async ({ request, platform, locals }) => {
  if (!platform?.env?.R2) {
    return ServerErrors.serviceUnavailable('Platform services not available');
  }

  console.log('Raw request debugging:');
  const debugBuffer = await request.clone().arrayBuffer();
  const debugUint8 = new Uint8Array(debugBuffer);
  console.log('First 10 bytes:', Array.from(debugUint8.slice(0, 10)).map(b => `0x${b.toString(16).padStart(2, '0')} (${b})`));

  // Validate request
  const validationError = validateScrapiRequest(request, {
    methods: ['POST'],
    contentTypes: [CBOR_CONTENT_TYPES.CBOR, CBOR_CONTENT_TYPES.COSE_SIGN1],
    maxBodySize: 10 * 1024 * 1024, // 10MB
    requireAuth: true // Auth is mocked for now
  });

  if (validationError) {
    return validationError;
  }

  // Use configured log ID from environment or default
  const logId = platform.env.CANOPY_ID || 'default-log';

  // Register the signed statement
  const response = await registerSignedStatement(
    request,
    logId,
    platform.env.R2
  );

  // Set proper status code for creation
  if (response.status === 202) {
    // Change from 202 Accepted to 201 Created as per SCRAPI spec
    return new Response(response.body, {
      status: 201,
      headers: response.headers
    });
  }

  return response;
};
