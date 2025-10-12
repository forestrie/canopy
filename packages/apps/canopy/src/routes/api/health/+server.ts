import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/health
 * Health check endpoint (public, no auth required)
 */
export const GET: RequestHandler = async ({ platform, locals }) => {
	const health = {
		status: 'healthy',
		timestamp: Date.now(),
		version: process.env.npm_package_version || '0.0.1',
		forestProjectId: locals.forestProjectId,
		environment: platform?.env?.NODE_ENV || 'development',
		services: {
			r2: false,
			queue: false
		}
	};

	// Check R2 availability
	if (platform?.env?.R2) {
		try {
			// Simple R2 check - list with limit 1
			await platform.env.R2.list({ limit: 1 });
			health.services.r2 = true;
		} catch (error) {
			console.error('R2 health check failed:', error);
		}
	}

	// Queue health is assumed if binding exists
	if (platform?.env?.QUEUE) {
		health.services.queue = true;
	}

	// Determine overall health
	const isHealthy = health.services.r2 && health.services.queue;

	return json(health, {
		status: isHealthy ? 200 : 503,
		headers: {
			'Cache-Control': 'no-cache, no-store, must-revalidate'
		}
	});
};