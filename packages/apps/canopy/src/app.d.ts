// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			// [AUTH HOOK POINT] - API key validation result
			authenticated: boolean;
			apiKey?: string;
			forestProjectId: string;
		}

		interface Platform {
			env: {
				// Environment variables
				FOREST_PROJECT_ID: string;
				R2_BUCKET_NAME: string;
				QUEUE_NAME: string;
				API_KEY_SECRET?: string;

				// Cloudflare bindings
				R2: R2Bucket;
				QUEUE: Queue;

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
