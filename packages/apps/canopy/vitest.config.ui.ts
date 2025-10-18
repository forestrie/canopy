import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		globals: true,
		environment: 'miniflare',
		environmentOptions: {
			// Miniflare-specific options
			bindings: {
				CANOPY_ID: 'canopy-test',
				FOREST_PROJECT_ID: 'forest-test',
				API_VERSION: 'v1',
				NODE_ENV: 'test'
			},
			r2Buckets: ['R2'],
			r2Persist: false, // Use in-memory storage for tests
			// Additional Miniflare options
			compatibilityDate: '2024-10-01',
			compatibilityFlags: ['nodejs_compat']
		},
		include: ['**/*.test.ts'],
		exclude: ['node_modules', 'dist', '.svelte-kit'],
		coverage: {
			reporter: ['text', 'lcov', 'html'],
			exclude: [
				'node_modules',
				'.svelte-kit',
				'*.config.*',
				'**/*.d.ts',
				'**/dist/**'
			]
		},
		alias: {
			$lib: '/src/lib',
			$app: '/.svelte-kit/runtime/app'
		}
	},
	resolve: {
		alias: {
			$lib: '/src/lib'
		}
	}
});