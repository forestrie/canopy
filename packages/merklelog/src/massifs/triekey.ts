/**
 * Trie key computation and format constants
 *
 * Based on the Go implementation in go-merklelog/massifs/trieentry.go
 */

/**
 * TrieEntryFmt - Format constants for trie entry fields
 *
 * Matching the Go implementation in go-merklelog/massifs/trieentry.go
 */
export namespace TrieEntryFmt {
  /**
   * TrieEntryBytes - Size of each trie entry (trie key + trie value)
   * 32 bytes for trie key + 32 bytes for trie value
   */
  export const TrieEntryBytes = 64;

  /**
   * TrieKeyBytes - Size of trie key in bytes
   */
  export const TrieKeyBytes = 32;

  /**
   * TrieKeyEnd - End offset of trie key within entry
   */
  export const TrieKeyEnd = TrieKeyBytes;

  /**
   * ExtraBytesStart - Start offset of extra bytes within entry
   */
  export const ExtraBytesStart = 32;

  /**
   * ExtraBytesSize - Size of extra bytes in bytes
   */
  export const ExtraBytesSize = 24;

  /**
   * ExtraBytesEnd - End offset of extra bytes within entry
   */
  export const ExtraBytesEnd = ExtraBytesStart + ExtraBytesSize;

  /**
   * IdTimestampStart - Start offset of ID timestamp within entry
   */
  export const IdTimestampStart = 32 + 24; // 56

  /**
   * IdTimestampSize - Size of ID timestamp in bytes
   */
  export const IdTimestampSize = 8;

  /**
   * IdTimestampEnd - End offset of ID timestamp within entry
   */
  export const IdTimestampEnd = IdTimestampStart + IdTimestampSize;
}

/**
 * TrieKeyDomains - Domain constants for trie key computation
 *
 * Matching go-merklelog/massifs/massifstart.go KeyType constants
 */
export namespace TrieKeyDomains {
  /**
   * ApplicationContent - Standard entry type, purposefully defined as 0
   * Matching go-merklelog/massifs/massifstart.go KeyTypeApplicationContent
   */
  export const ApplicationContent = 0;
}

/**
 * Options for trie key computation
 */
export interface TrieKeyOptions {
  /**
   * Domain key type for trie key computation
   */
  domain: number;
}

/**
 * Computes the trie key from domain, logId, and appId
 *
 * The trie key is computed as: SHA256(DOMAIN || LOGID || APPID)
 * Matching go-merklelog/massifs/trieentry.go NewTrieKey
 *
 * @param opts - Options containing domain key type
 * @param logId - Log ID bytes
 * @param appId - Application ID bytes
 * @returns 32-byte trie key hash
 */
export async function computeTrieKey(
  opts: TrieKeyOptions,
  logId: Uint8Array,
  appId: Uint8Array
): Promise<Uint8Array> {
  const data = new Uint8Array(1 + logId.length + appId.length);
  data[0] = opts.domain;
  data.set(logId, 1);
  data.set(appId, 1 + logId.length);
  
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

