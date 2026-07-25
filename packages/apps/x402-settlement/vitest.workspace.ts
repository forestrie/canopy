/**
 * Two projects so the isolated-storage override is confined to the tests that
 * genuinely need it, rather than applied package-wide.
 */
export default ["./vitest.config.ts", "./vitest.receivables.config.ts"];
