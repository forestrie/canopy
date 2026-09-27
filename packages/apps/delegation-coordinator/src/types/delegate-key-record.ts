/**
 * A registered standing delegate key as the coordinator reports it
 * ([devdocs plan-2609-12 slice 04](https://github.com/forestrie/devdocs/blob/main/plans/plan-2609-12-delegate-key-registration-hardening/04-coordinator-routes-and-invariant.md),
 * rulings 1 and 4). Read by the arbor sealer's readiness gate through
 * `GET /api/sealer/delegate-keys/{pubkeyHash}` and by the operator listing
 * `GET /api/sealer/delegate-keys?sealerId=`. Public metadata only: the hash
 * and its binding, never the voucher or the key bytes.
 */

/** One `delegate_keys` row as exposed by the read routes. */
export interface DelegateKeyRecord {
  /**
   * Hex sha256 of the COSE_Key CBOR bytes; the `delegate_keys` primary key and
   * the value a certificate's `delegated_pubkey_hash` is matched against.
   */
  pubkeyHash: string;
  /** Sealer the custodian derived the key for. */
  sealerId: string;
  /** Delegate-key epoch, which is the custodian's MAC key version (ADR-0050). */
  epoch: number;
  /** Unix seconds after which the key is retired and dropped. */
  notAfter: number;
  /**
   * Unix seconds when the row last landed (insert or refresh). Null only for
   * rows written before the column existed.
   */
  registeredAt: number | null;
}
