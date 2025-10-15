// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			// [AUTH HOOK POINT] - API key validation result
			authenticated: boolean;
			apiKey?: string;
			canopyId: string;
			forestProjectId: string;
		}

		interface Platform {
			env: {
				// Instance identifiers
				CANOPY_ID: string;
				FOREST_PROJECT_ID: string;  // External forest project reference

				API_KEY_SECRET?: string;

				// R2 API tokens (R2_WRITER used by app for read/write operations)
				R2_WRITER: string;

				// Cloudflare bindings
				R2: R2Bucket;

				// Additional env vars
				NODE_ENV: string;
				API_VERSION: string;
			};
			context: ExecutionContext;
			caches: CacheStorage & { default: Cache };
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
