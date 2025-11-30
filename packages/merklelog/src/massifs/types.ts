/**
 * Re-exports for massifs module types and constants
 *
 * This file serves as a convenience re-export point for external consumers.
 * Types and interfaces are organized into individual files to:
 * 1. Avoid circular dependencies
 * 2. Avoid monolithic types.ts files
 * 3. Keep related code (interfaces and their implementations) together
 */

// Re-export MassifStart interface and format namespace
export type { MassifStart } from "./massifstart.js";
export { MassifStartFmt } from "./massifstart.js";

// Re-export log format namespace and functions
export { LogFormat, peakStackEnd, massifLogEntries } from "./logformat.js";

// Re-export find entry functions
export { findTrieEntry, findAppEntry, type FindEntryOptions } from "./findentry.js";

// Re-export trie key functions and types
export { TrieEntryFmt, TrieKeyDomains, computeTrieKey, type TrieKeyOptions } from "./triekey.js";
