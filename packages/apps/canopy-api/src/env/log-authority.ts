/**
 * A log's authority as canopy-api acts on it: univocity's answer from
 * `GET /api/logs/{logId}/authority` (arbor `services/univocity`), reduced to
 * what admission and receipt verification need. A log's key grants authority
 * only once it is anchored on chain
 * ([protocol ADR-0070](https://github.com/forestrie/protocol/blob/main/adr/adr-0070-sec-log-authority-anchored-before-use.md));
 * univocity is canopy-api's only source of it
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decisions 5 and 9).
 */

/**
 * - `anchored`: the chain has fixed the log's key, and every ancestor is
 *   anchored too. `final` is false until univocity has compared the log's
 *   first checkpoint with its claim, so it can still become conflicted.
 * - `pending`: claimed (`reserved`, `committed` or `sequenced`), or anchored
 *   with an ancestor (`blockedBy`) that is not yet. Waiting resolves it.
 * - `conflicted`: the chain recorded a different owner or key than the claim,
 *   for the log or for the ancestor `blockedBy`. Final: waiting never helps.
 * - `unclaimed`: univocity holds no claim for the log.
 * - `unavailable`: univocity could not answer.
 */
export type LogAuthority =
  | {
      kind: "anchored";
      final: boolean;
      /** COSE algorithm of the root key. */
      alg: number;
      /** ES256 x||y (64 bytes) or KS256 address (20 bytes). */
      key: Uint8Array;
      /** Decimal EIP-155 chain id of the log's univocity instance. */
      chainId?: string;
    }
  | {
      kind: "pending";
      /** univocity's state for the log itself. */
      state: string;
      /** The ancestor nearest the root that is not anchored. */
      blockedBy?: Uint8Array;
      /** A reservation's lapse time, unix seconds. */
      expiresAt?: number;
    }
  | { kind: "conflicted"; blockedBy?: Uint8Array }
  | { kind: "unclaimed" }
  | { kind: "unavailable"; detail: string };

/** CBOR state names univocity answers with. */
export const AUTHORITY_STATE_ANCHORED = "anchored";
export const AUTHORITY_STATE_CONFLICTED = "conflicted";
