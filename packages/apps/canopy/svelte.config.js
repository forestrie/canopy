import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			// Cloudflare Pages configuration
			routes: {
				include: ['/*'],
				exclude: ['<all>']
			}
		}),
		// Service worker registration disabled for Cloudflare Workers
		serviceWorker: {
			register: false
		},
		// CSRF protection
		csrf: {
			checkOrigin: true
		}
	}
};

export default config;
