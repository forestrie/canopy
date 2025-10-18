import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import path from 'path';

export default defineWorkersConfig({
	test: {
		globals: true,
		pool: '@cloudflare/vitest-pool-workers',
		poolOptions: {
			workers: {
				wrangler: {
					configPath: './wrangler.jsonc'
				},
				miniflare: {
					// Miniflare v4 configuration
					compatibilityDate: '2024-10-01',
					compatibilityFlags: ['nodejs_compat'],
					bindings: {
						CANOPY_ID: 'canopy-test',
						FOREST_PROJECT_ID: 'forest-test',
						API_VERSION: 'v1',
						NODE_ENV: 'test'
					},
					r2Buckets: {
						R2: 'canopy-test-bucket'
					},
					// Use in-memory storage for tests
					r2Persist: false,
					kvPersist: false
				}
			}
		},
		include: ['**/*.test.ts'],
		exclude: ['node_modules', 'dist', '.svelte-kit', '**/*.api.test.ts'],
		coverage: {
			reporter: ['text', 'lcov', 'html'],
			exclude: [
				'node_modules',
				'.svelte-kit',
				'*.config.*',
				'**/*.d.ts',
				'**/dist/**'
			]
		}
	},
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib'),
			'@cloudflare/workers-types': path.resolve('./node_modules/@cloudflare/workers-types')
		}
	}
});