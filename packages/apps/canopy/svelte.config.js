import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			// Build for Cloudflare Workers (not Pages)
			// This will output to .svelte-kit/cloudflare
		}),
		// Service worker registration disabled for Cloudflare Workers
		serviceWorker: {
			register: false
		},
		// CSRF protection
		csrf: {
			trustedOrigins: ['https://canopy.forestrie.dev']
		}
	}
};

export default config;
