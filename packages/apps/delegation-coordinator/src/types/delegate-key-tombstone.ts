/**
 * A delegate-key tombstone as the coordinator stores and reports it
 * ([devdocs plan-2609-12 slice 08](https://github.com/forestrie/devdocs/blob/main/plans/plan-2609-12-delegate-key-registration-hardening/08-coordinator-voucher-enforcement.md),
 * ruling 8). Replicated to every shard, like `delegate_keys`, so each shard
 * refuses a retired key's registration on its own. Tombstones never expire;
 * an operator lifts one only to undo a mistake.
 *
 * Exactly one target is set: a key hash, or a sealer with every epoch up to
 * and including `maxEpoch`.
 */

/** One `delegate_key_tombstones` row as exposed by the read routes. */
export interface DelegateKeyTombstone {
  /** Retired key hash, for a hash tombstone; null for an epoch tombstone. */
  pubkeyHash: string | null;
  /**
   * The sealer: the target of an epoch tombstone, or for a hash tombstone the
   * sealer whose row it deleted (null when no row was registered).
   */
  sealerId: string | null;
  /** Highest retired epoch of an epoch tombstone; null for a hash tombstone. */
  maxEpoch: number | null;
  /** Operator's reason, returned in the 410 that refuses a registration. */
  reason: string;
  /** Unix seconds; one value for every shard's replica. */
  createdAt: number;
}
