/**
 * Mock MMR (Merkle Mountain Range) Index Service
 * Returns a fence index for pre-sequencing objects
 */

export interface MMRIndexResponse {
	fenceIndex: number;
	massifHeight: number;
	timestamp: number;
}

/**
 * Get the current fence MMR index from external service
 *
 * TODO: Replace with actual service call to forestrie/datatrails massif
 * Currently returns 0 as specified in requirements
 *
 * @param logId The log identifier
 * @param serviceEndpoint Optional service endpoint
 * @returns The current fence MMR index
 */
export async function getFenceMMRIndex(
	logId: string,
	serviceEndpoint?: string
): Promise<MMRIndexResponse> {
	// Mock implementation - always returns 0
	console.log(`[MMR Mock] Returning fence index 0 for log ${logId}`);

	return {
		fenceIndex: 0,
		massifHeight: 0,
		timestamp: Date.now()
	};
}

/**
 * Calculate the lower bound MMR index for an object
 * Based on the first mmrIndex in the current (head) massif tile
 *
 * @param logId The log identifier
 * @returns The lower bound MMR index
 */
export async function getLowerBoundMMRIndex(logId: string): Promise<number> {
	const response = await getFenceMMRIndex(logId);
	return response.fenceIndex;
}