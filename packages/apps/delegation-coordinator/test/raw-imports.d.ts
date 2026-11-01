/**
 * Vite `?raw` imports (vitest resolves them to the file's text). Tests use
 * them to check source-level invariants, e.g. that every route whose handler
 * touches the range columns sits behind the migration gate.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
