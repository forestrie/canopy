import type { RequestHandler } from './$types';
import { cborResponse } from '$lib/scrapi/cbor';

// Minimal placeholder: service may not expose keys yet
// Returns an empty set to satisfy SCRAPI 2.1.2 (Transparency Service Keys)
export const GET: RequestHandler = async () => {
	const keys = {
		keys: [] as Array<unknown>
	};
	return cborResponse(keys, 200, { 'cache-control': 'no-store' });
};
