/**
 * Response of `GET /api/sealer/delegate-keys?sealerId=` (plan-2609-12 slice
 * 04, ruling 4): the operator's verification surface for a delegate-key
 * rotation, replacing log reading. Certificates are sharded per log while
 * keys are replicated to every shard, so the worker sums the certificate
 * counts and counts the shards holding each row. Since slice 08 it also marks
 * expired rows and returns the sealer's tombstones.
 */

import type { DelegateKeyRecord } from "./delegate-key-record.js";
import type { DelegateKeyTombstone } from "./delegate-key-tombstone.js";

/** One registered key of the sealer with its certificate coverage evidence. */
export interface DelegateKeysListingEntry extends DelegateKeyRecord {
  /**
   * `delegation_certificates` rows bound to this hash with `expires_at > now`,
   * summed over all shards.
   */
  unexpiredCertificates: number;
  /**
   * Shards holding this row. Equals the listing's `shards` when registration
   * replicated fully; a smaller number means a fan-out did not complete.
   */
  shardsRegistered: number;
  /**
   * notAfter has passed. The row is not registered (the lookup answers 404 and
   * coverage ignores it) and is deleted at the sealer's next registration.
   */
  expired: boolean;
}

/** One of the sealer's tombstones with the shards holding it. */
export interface DelegateKeysListingTombstone extends DelegateKeyTombstone {
  /** Shards holding this tombstone; fewer than `shards` means a partial write. */
  shardsRecorded: number;
}

/** By-sealer delegate-key listing. */
export interface DelegateKeysListing {
  sealerId: string;
  /** Number of store shards consulted. */
  shards: number;
  /** Keys ordered by epoch descending, then hash. */
  keys: DelegateKeysListingEntry[];
  /** Tombstones naming the sealer, oldest first. */
  tombstones: DelegateKeysListingTombstone[];
}
