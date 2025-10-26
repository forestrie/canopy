/**
 * Resolve Receipt operation for SCRAPI
 *
 * Handles GET requests for entry receipts, supporting both:
 * - In-progress registrations: /entries/00000000/{md5hash}
 * - Completed registrations: /entries/00000000
 */

import { ClientErrors } from './problem-details';
import { cborResponse, seeOtherResponse } from './cbor-response';
import { CBOR_CONTENT_TYPES } from './cbor-content-types';

/**
 * Placeholder receipt structure
 * TODO: Implement proper SCITT receipt format
 */
interface PlaceholderReceipt {
  index: string;
  status: 'completed';
  // TODO: Add proper receipt fields per SCITT spec
}

/**
 * Resolve a receipt for a registered statement
 *
 * @param request - The HTTP request
 * @param entrySegments - [logid, 'entries', index, etag?]
 * @param r2Bucket - R2 bucket for storage
 * @returns Response with receipt or redirect
 */
export async function resolveReceipt(
  request: Request,
  entrySegments: string[],
  r2Bucket: R2Bucket
): Promise<Response> {
  const [logID, _, index, etag] = entrySegments;
  try {
    // Parse the operation ID

    if (!etag) {
      // Completed registration - return receipt
      // For now, assume the entry is complete as per user requirement

      // TODO: read the receipt via native forestrie api using the logId and
      // index

      const receipt: PlaceholderReceipt = {
        index,
        status: 'completed'
      };

      return cborResponse(receipt, 200, CBOR_CONTENT_TYPES.SCITT_RECEIPT);
    }

    // the index is the fence index, the entry will be sequenced in a massif no
    // earlier than that implied by the fence. the etag will identify its
    // position in the index

    // TODO:If completed, construct permanent URL and return 303 redirect, the
    // content at the final location can be cached indefinitely

    // const requestUrl = new URL(request.url);
    // const permanentLocation = `${requestUrl.origin}${requestUrl.pathname.replace(`/${entryId}`, `/${fenceIndex.toString().padStart(8, '0')}`)}`;

    // return seeOtherResponse(permanentLocation);
    // Still processing - return 303 with current location and retry-after
    const requestUrl = new URL(request.url);
    const currentLocation = `${requestUrl.origin}${requestUrl.pathname}`;

    return seeOtherResponse(currentLocation, 5); // Retry after 5 seconds

  } catch (error) {
    console.error('Error resolving receipt:', error);

    return ClientErrors.notFound(
      `Entry ${logID}/${index}/${etag} not found or error retrieving receipt`
    );
  }
}
