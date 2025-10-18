import { ClientErrors } from '$lib/scrapi/problem-details';
import { extractApiKey, requiresAuth, validateApiKey } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	// Extract instance identifiers from environment
	event.locals.canopyId = event.platform?.env?.CANOPY_ID || 'canopy-dev-1';
	event.locals.forestProjectId = event.platform?.env?.FOREST_PROJECT_ID || 'forest-dev-1';

	// Check if authentication is required for this path
	if (requiresAuth(event.url.pathname)) {
		// Extract API key from Authorization header
		const authHeader = event.request.headers.get('Authorization');
		const apiKey = extractApiKey(authHeader);

		// Validate API key
		const apiKeySecret = event.platform?.env?.API_KEY_SECRET;
		const isValid = await validateApiKey(apiKey, apiKeySecret);

		// Set authentication status
		event.locals.authenticated = isValid;
		event.locals.apiKey = apiKey;

        // [AUTH HOOK POINT] - Reject unauthorized requests (CBOR for API routes, JSON allowed for /api/health)
        if (!isValid) {
            if (event.url.pathname === '/api/health') {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    status: 401,
                    headers: {
                        'content-type': 'application/json',
                        'WWW-Authenticate': 'Bearer realm="api"'
                    }
                });
            }
            return ClientErrors.unauthorized('Missing or invalid API key', {
                'WWW-Authenticate': 'Bearer realm="api"'
            });
        }
	} else {
		// Public endpoint - no auth required
		event.locals.authenticated = false;
	}

	// Continue with request
	const response = await resolve(event);

	// Add security headers
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-XSS-Protection', '1; mode=block');

	return response;
};