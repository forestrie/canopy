/**
 * A single queue entry returned in a pull response.
 *
 * The `seq` is not included here—it's implicit in the LogGroup's seqLo/seqHi
 * range. Entries are contiguous within a group.
 */
export interface Entry {
  /** SHA-256 content hash (32 bytes) */
  contentHash: ArrayBuffer;
  /** Optional extra field 0 (≤32 bytes) */
  extra0: ArrayBuffer | null;
  /** Optional extra field 1 (≤32 bytes) */
  extra1: ArrayBuffer | null;
  /** Optional extra field 2 (≤32 bytes) */
  extra2: ArrayBuffer | null;
  /** Optional extra field 3 (≤32 bytes) */
  extra3: ArrayBuffer | null;
}

/**
 * A group of entries for a single log, returned in a pull response.
 *
 * Entries are contiguous from seqLo to seqHi inclusive.
 */
export interface LogGroup {
  /** Log identifier (16 bytes) */
  logId: ArrayBuffer;
  /** First sequence number in this group (for ack) */
  seqLo: number;
  /** Last sequence number in this group (for ack) */
  seqHi: number;
  /** Entries in ascending seq order */
  entries: Entry[];
}

/**
 * Response body from the pull endpoint.
 *
 * Wire format (CBOR):
 * [version, leaseExpiry, [[logId, seqLo, seqHi, [[contentHash, extra0-3], ...]], ...]]
 */
export interface PullResponse {
  /** Wire format version (currently 1) */
  version: number;
  /** Unix timestamp (ms) when the lease expires */
  leaseExpiry: number;
  /** Entries grouped by log */
  logGroups: LogGroup[];
}
