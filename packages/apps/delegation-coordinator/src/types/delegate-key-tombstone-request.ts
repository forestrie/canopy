/**
 * JSON body for `POST /admin/api/sealer/delegate-keys/tombstones`
 * (plan-2609-12 slice 08, ruling 8): retire one key by hash, or a sealer's
 * epochs up to `maxEpoch`. Exactly one of the two targets.
 */

/** Tombstone one key by its hash. */
export interface PubkeyHashTombstoneTarget {
  /** 64 lowercase hex chars, the `delegate_keys.pubkey_hash` shape. */
  pubkeyHash: string;
}

/** Tombstone every epoch of a sealer up to and including `maxEpoch`. */
export interface SealerEpochTombstoneTarget {
  sealerId: string;
  /** Integer >= 1. */
  maxEpoch: number;
}

/** Tombstone request body. */
export type DelegateKeyTombstoneRequest = (
  | PubkeyHashTombstoneTarget
  | SealerEpochTombstoneTarget
) & {
  /** Non-empty; reported in the 410 and the listing. */
  reason: string;
};
