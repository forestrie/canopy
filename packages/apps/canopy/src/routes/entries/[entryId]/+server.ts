/**
 * SCITT Entry Retrieval Endpoint
 * GET /entries/{entryId}
 */

import type { RequestHandler } from './$types';
import type { R2Object } from '@cloudflare/workers-types';
import { cborResponse, checkETag, notModifiedResponse } from '$lib/scrapi/cborresponse';
import { ClientErrors, ServerErrors } from '$lib/scrapi/problem-details';
import { validateEntryId } from '$lib/scrapi/validation';
import type { StatementEntry } from '$lib/scrapi/types';

/**
 * GET /entries/{entryId}
 * Retrieve a specific entry from the log
 */
export const GET: RequestHandler = async ({ request, params, platform }) => {
	if (!platform?.env?.R2) {
		return ServerErrors.serviceUnavailable('Platform services not available');
	}

	const { entryId } = params;

	// Validate entry ID
	const entryIdError = validateEntryId(entryId);
	if (entryIdError) return entryIdError;

	// Use configured log ID from environment
	const logId = platform.env.CANOPY_ID || 'default-log';

	try {
		// Search for the entry in R2
		const prefix = `logs/${logId}/leaves/`;
		const list = await platform.env.R2.list({
			prefix,
			limit: 1000
		});

		// Find the entry by matching the hash or etag
		let foundObject: R2Object | undefined;
		for (const obj of list.objects) {
			const pathParts = obj.key.split('/');
			const hash = pathParts[pathParts.length - 1];

			if (hash === entryId || obj.etag?.replace(/"/g, '') === entryId) {
				foundObject = obj;
				break;
			}
		}

		if (!foundObject) {
			return ClientErrors.notFound('entry', `Entry ${entryId} not found`);
		}

		// Get the actual object to read metadata
		const object = await platform.env.R2.get(foundObject.key);
		if (!object) {
			return ClientErrors.notFound('entry', `Entry ${entryId} not found`);
		}

		// Extract fence index from path
		const pathParts = foundObject.key.split('/');
		const fenceIndex = parseInt(pathParts[pathParts.length - 2], 10);

		// Check ETag for caching
		const etag = foundObject.etag || '';
		if (checkETag(request, etag)) {
			return notModifiedResponse(etag);
		}

		// Build statement entry
		const entry: StatementEntry = {
			entryId: entryId,
			logId: logId,
			statementId: pathParts[pathParts.length - 1],
			fenceIndex: isNaN(fenceIndex) ? 0 : fenceIndex,
			timestamp: foundObject.uploaded?.getTime() || Date.now(),
			contentHash: pathParts[pathParts.length - 1],
			size: foundObject.size || 0,
			sequenced: object.customMetadata?.sequenced === 'true',
			mmrIndex: object.customMetadata?.mmrIndex ? parseInt(object.customMetadata.mmrIndex, 10) : undefined
		};

		// Return CBOR-encoded entry
		const response = cborResponse(entry);
		response.headers.set('ETag', etag);
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');

		return response;

	} catch (error) {
		console.error('Error retrieving entry:', error);
		return ServerErrors.storageError(
			error instanceof Error ? error.message : 'Failed to retrieve entry',
			'get'
		);
	}
};