/**
 * Utility functions for Uint8Array operations
 */

/**
 * Compares two Uint8Arrays for equality
 *
 * Simple and efficient byte-by-byte comparison. Optimized for small
 * fixed-size arrays like trie keys (32 bytes) and extraBytes (24 bytes).
 *
 * @param a - First array to compare
 * @param b - Second array to compare
 * @returns true if arrays are equal, false otherwise
 */
export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

