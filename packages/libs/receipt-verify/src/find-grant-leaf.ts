/**
 * Offline grant-leaf lookup (FOR-344): locate a grant's sequenced leaf in a
 * local massif blob using only the grant statement and the massif `.log`.
 *
 * The sequencer commits a grant to the log under its grant commitment hash
 * (`grantCommitmentHashFromGrant` — the ContentHash enqueued in
 * canopy-api `grant-sequencing.ts`), and the v2 urkle index region records that
 * hash in each leaf's value column keyed by the leaf's 8-byte idtimestamp. So a
 * client holding the owner-log massif can recover BOTH halves of the permanent
 * entry id (`idtimestamp_be8 || mmrIndex_be8`) with no operator round-trip —
 * the derivation that lets `forestrie complete-grant` build the completed grant
 * header offline (grants are derivable from log data, not operator-issued).
 *
 * Pure over bytes; no network, no signing key. Browser-safe (ADR-0048).
 *
 * The lookup is a linear scan of the leaf-table value column. That is optimal
 * here: recovering the entry id needs the leaf's *position* (ordinal → mmrIndex
 * + idtimestamp key), and no content-hash→position index exists in the blob.
 * The index region's bloom filter 0 IS keyed on the content hash, but a bloom
 * only answers membership (maybe/definitely-not), never position — so it could
 * at best short-circuit the not-present case, not the recovery; the positional
 * structure (the urkle trie) is keyed by idtimestamp, which is exactly what we
 * are recovering. Building a value→position map would itself be an O(n) scan.
 */
import { openMassifLeafIndex, type LocatedLeaf } from "@forestrie/merklelog";
import type { Grant } from "@forestrie/encoding";
import { grantCommitmentHashFromGrant } from "./grant-commitment.js";

export type { LocatedLeaf };

/**
 * Find the grant's leaf in `massifBytes` and return its `mmrIndex` and the
 * 8-byte idtimestamp key, or `null` when the grant's commitment hash is not
 * present in this massif's index region (searched, not found).
 *
 * Throws `MissingIndexError` (from `@forestrie/merklelog`) when the blob has no
 * populated index region at all — distinguishable from a not-found `null`.
 */
export async function findGrantLeafInMassif(
  massifBytes: Uint8Array,
  grant: Grant,
): Promise<LocatedLeaf | null> {
  const inner = await grantCommitmentHashFromGrant(grant);
  const index = openMassifLeafIndex(massifBytes);
  return index.findLeafByContentHash(inner);
}
