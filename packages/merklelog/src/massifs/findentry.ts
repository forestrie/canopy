/**
 * Find entry functions for locating trie entries in massif data
 *
 * Based on the Go implementation in go-merklelog/massifs/trieentry.go
 */

import { Massif } from "./massif.js";
import { LogFormat } from "./logformat.js";
import { TrieEntryFmt, TrieKeyDomains, computeTrieKey } from "./triekey.js";
import { arraysEqual } from "../utils/arrays.js";

/**
 * Options for findTrieEntry and findAppEntry functions
 */
export interface FindEntryOptions {
  /**
   * Domain key type for trie key computation
   * If undefined, defaults to TrieKeyDomains.ApplicationContent (only used by findAppEntry)
   */
  domain?: number;

  /**
   * Start index for search (inclusive, zero-based)
   * If undefined, search starts at 0
   */
  start?: number;

  /**
   * End index for search (exclusive, zero-based)
   * If undefined, search ends at trieEntryCount
   * If both start and end are set, end - start must be > 0
   */
  end?: number;

  /**
   * Optional extra bytes for defense-in-depth check
   * If present, verifies stored extraBytes match provided extraBytes
   * If not present, skips the defense-in-depth check (only used by findTrieEntry)
   */
  extraBytes?: Uint8Array;
}

/**
 * Finds the trie entry index for a given appId in the massif
 *
 * High-level function that computes the trie key from the provided appId, logId, and domain,
 * then delegates to findTrieEntry to perform the search. As defense in depth, always verifies
 * that extraBytes match the first 24 bytes of the appId.
 *
 * @param massif - Massif instance containing the trie data
 * @param appId - Application ID to search for (also used as content hash)
 * @param logId - Log ID for computing the trie key
 * @param opts - Optional search range parameters and domain for trie key computation
 * @returns The trie index (zero-based) if found, or null if not found
 * @throws Error if trie key matches but extraBytes don't match content hash prefix
 */
export async function findAppEntry(
  massif: Massif,
  appId: Uint8Array,
  logId: Uint8Array,
  opts?: FindEntryOptions,
): Promise<number | null> {
  // Compute expected trie key
  const domain = opts?.domain ?? TrieKeyDomains.ApplicationContent;
  const expectedTrieKey = await computeTrieKey({ domain }, logId, appId);

  // Get content hash prefix (first 24 bytes of appId)
  // Pad with zeros if appId is shorter than 24 bytes
  const contentHashPrefix = new Uint8Array(24);
  contentHashPrefix.set(appId.slice(0, Math.min(24, appId.length)), 0);

  // Delegate to findTrieEntry with computed key and extraBytes for defense-in-depth
  return findTrieEntry(massif, expectedTrieKey, {
    start: opts?.start,
    end: opts?.end,
    extraBytes: contentHashPrefix,
  });
}

/**
 * Finds the trie entry index for a given expected trie key in the massif
 *
 * Low-level function that searches for a matching trie key in the massif's trie entries.
 * Optionally performs defense-in-depth verification by checking extraBytes if provided.
 *
 * @param massif - Massif instance containing the trie data
 * @param expectedTrieKey - The trie key to search for (32 bytes)
 * @param opts - Optional search range parameters and extraBytes for verification
 * @returns The trie index (zero-based) if found, or null if not found
 * @throws Error if trie key matches but extraBytes don't match (when extraBytes is provided)
 */
export async function findTrieEntry(
  massif: Massif,
  expectedTrieKey: Uint8Array,
  opts?: FindEntryOptions,
): Promise<number | null> {
  const start = massif.getStart();

  // Calculate trie data start offset
  // TrieDataStart = StartHeaderEnd + IndexHeaderBytes
  const trieDataStart =
    BigInt(LogFormat.StartHeaderSize) + BigInt(LogFormat.IndexHeaderBytes);

  // Calculate number of trie entries from massif height
  // TrieDataEntryCount = 1 << massifHeight
  const trieEntryCount = 1 << start.massifHeight;

  // Validate and set search range
  const searchStart = opts?.start ?? 0;
  const searchEnd = opts?.end ?? trieEntryCount;

  // Validate range if both start and end are provided
  if (opts?.start !== undefined && opts?.end !== undefined) {
    if (searchEnd - searchStart <= 0) {
      throw new Error(
        `Invalid search range: end (${searchEnd}) - start (${searchStart}) must be > 0`,
      );
    }
  }

  // Validate bounds
  if (searchStart < 0 || searchStart >= trieEntryCount) {
    throw new Error(
      `Invalid start index: ${searchStart} (must be 0 <= start < ${trieEntryCount})`,
    );
  }
  if (searchEnd < 0 || searchEnd > trieEntryCount) {
    throw new Error(
      `Invalid end index: ${searchEnd} (must be 0 <= end <= ${trieEntryCount})`,
    );
  }

  // Iterate through trie entries efficiently
  const trieDataStartNum = Number(trieDataStart);
  for (let i = searchStart; i < searchEnd; i++) {
    const entryOffset = trieDataStartNum + i * TrieEntryFmt.TrieEntryBytes;

    // Read trie key directly from buffer (first 32 bytes of entry)
    const storedTrieKey = massif.readBytes(
      entryOffset,
      TrieEntryFmt.TrieKeyBytes,
    );

    // Compare trie keys
    if (arraysEqual(storedTrieKey, expectedTrieKey)) {
      // Defense in depth: verify extraBytes match if provided
      if (opts?.extraBytes !== undefined) {
        const extraBytesOffset = entryOffset + TrieEntryFmt.ExtraBytesStart;
        const storedExtraBytes = massif.readBytes(
          extraBytesOffset,
          TrieEntryFmt.ExtraBytesSize,
        );

        if (!arraysEqual(storedExtraBytes, opts.extraBytes)) {
          throw new Error(
            `Trie key match found at index ${i}, but extraBytes do not match. ` +
              `This indicates data corruption or a hash collision.`,
          );
        }
      }

      return i; // Return trie index (zero-based, relative to massif)
    }
  }

  return null; // Not found
}
