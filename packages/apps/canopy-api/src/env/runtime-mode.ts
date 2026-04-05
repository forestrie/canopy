/**
 * Vitest + @cloudflare/vitest-pool-workers + wrangler.test.jsonc use NODE_ENV "test"
 * with incomplete bindings. Production code must gate test-only skips with this helper
 * only—see AGENTS.md. Playwright e2e uses dev/prod-like NODE_ENV, not "test".
 */
export function isCanopyApiPoolTestMode(env: { NODE_ENV: string }): boolean {
  return env.NODE_ENV === "test";
}
