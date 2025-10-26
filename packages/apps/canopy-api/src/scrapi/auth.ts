/**
 * Authentication module for API key validation
 * [AUTH IMPLEMENTATION POINT]
 */

/**
 * Validate API key from request headers
 *
 * TODO: Implement actual API key validation
 * - Check against API_KEY_SECRET from environment
 * - Validate key format and expiry
 * - Add rate limiting per key
 *
 * @param apiKey The API key to validate
 * @param secret The secret to validate against
 * @returns True if valid, false otherwise
 */
export async function validateApiKey(apiKey: string | undefined, secret: string | undefined): Promise<boolean> {
	// [AUTH HOOK] - Currently returns true for all requests
	// TODO: Implement actual validation logic
	console.log('[AUTH] API key validation stub - returning true');
	return true;
}

/**
 * Extract API key from Authorization header
 *
 * @param authHeader The Authorization header value
 * @returns The extracted API key or undefined
 */
export function extractApiKey(authHeader: string | null): string | undefined {
	if (!authHeader) return undefined;

	// Support both "Bearer <key>" and "ApiKey <key>" formats
	const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	if (bearerMatch) return bearerMatch[1];

	const apiKeyMatch = authHeader.match(/^ApiKey\s+(.+)$/i);
	if (apiKeyMatch) return apiKeyMatch[1];

	// If no prefix, treat entire header as key
	return authHeader;
}

/**
 * Check if a request requires authentication
 *
 * @param pathname The request pathname
 * @returns True if authentication is required
 */
export function requiresAuth(pathname: string): boolean {
	// Public endpoints that don't require auth
	const publicPaths = [
		'/',
		'/health',
		'/api/health',
		'/api/v1/status'
	];

	// Check if path is public
	if (publicPaths.includes(pathname)) {
		return false;
	}

	// All API routes require auth by default
	if (pathname.startsWith('/api/')) {
		return true;
	}

	// Frontend routes don't require auth
	return false;
}