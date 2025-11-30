/**
 * Proof types for MMR inclusion and consistency proofs
 */

/**
 * Proof - Inclusion or consistency proof structure
 */
export interface Proof {
  /** The proof path (sibling hashes) */
  path: Uint8Array[];
  /** The leaf index being proven */
  leafIndex?: bigint;
  /** The MMR index being proven */
  mmrIndex?: bigint;
}

/**
 * Peak - A peak node in the MMR
 */
export interface Peak {
  /** The MMR index of the peak */
  index: bigint;
  /** The hash value of the peak */
  hash: Uint8Array;
}

/**
 * Hasher interface for cryptographic hashing operations
 */
export interface Hasher {
  /** Reset the hasher state */
  reset(): void;
  /** Update the hasher with data */
  update(data: Uint8Array): void;
  /** Finalize and return the hash */
  digest(): Uint8Array;
}

