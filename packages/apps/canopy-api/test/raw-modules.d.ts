/** Vite `?raw` imports return the file contents as a string (used by guard tests). */
declare module "*?raw" {
  const content: string;
  export default content;
}
